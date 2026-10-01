import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createProviderSetup } from './provider-setup.js'

function fixture() {
  const records = new Map()
  const secrets = new Map()
  let queue = Promise.resolve()
  let revision = 0
  let providerConfig = { other: { displayName: 'Keep me' } }
  const counts = { create: 0, readKey: 0, write: 0 }
  const credentials = {
    readRecord: async key => records.get(key),
    modifyRecord(key, mutate) {
      const task = queue.then(async () => {
        assert.match(key, /^[\w-]+\/[\w-]+$/)
        const next = await mutate(records.get(key))
        if (next !== undefined) records.set(key, structuredClone(next))
      })
      queue = task.catch(() => {})
      return task
    },
    set: async (ref, value) => { secrets.set(ref, value) },
    describe: async ref => ({ configured: secrets.has(ref) }),
  }
  const settings = {
    prepareDocument: async () => '/profiles/test/cordis.patch.yml',
    describe: () => [{ ns: 'llm-pi-ai', revision, value: { providers: structuredClone(providerConfig) } }],
    async mutate(ns, ops, expected) {
      assert.equal(ns, 'llm-pi-ai')
      assert.equal(expected, revision)
      const [op] = ops
      assert.deepEqual(op.path.slice(0, 1), ['providers'])
      providerConfig[op.path[1]] = op.value
      counts.write++
      revision++
    },
  }
  const ctx = { get: name => ({ credentials, settings })[name] }
  const options = {
    issuer: 'https://example.test',
    async userApi(_ctx, path, request) {
      assert.ok(request.expectedUserId > 0)
      if (path === '/api/user/self') return { id: request.expectedUserId }
      if (path === '/api/token/') {
        counts.create++
        const body = JSON.parse(request.body)
        assert.equal(body.expired_time, -1)
        assert.equal(body.group, '')
        assert.equal(body.unlimited_quota, true)
        return { id: counts.create }
      }
      assert.match(path, /^\/api\/token\/\d+\/key$/)
      counts.readKey++
      return { key: 'secret-test-value' }
    },
    async models(apiKey) {
      assert.equal(apiKey, 'sk-secret-test-value')
      return [{ id: 'chat', supported_endpoint_types: ['openai'] },
        { id: 'chat', supported_endpoint_types: ['openai'] },
        { id: 'embedding', supported_endpoint_types: ['embeddings'] }]
    },
  }
  return { records, secrets, counts, settings, ctx, options, providers: () => providerConfig }
}

test('concurrent setup creates once, reads key by ID, and persists official provider config', async () => {
  const f = fixture()
  const setup = createProviderSetup(f.options)
  const result = await Promise.all([setup.run(f.ctx, 1), setup.run(f.ctx, 1)])
  assert.equal(f.counts.create, 1)
  assert.equal(f.counts.readKey, 1)
  assert.equal(f.counts.write, 1)
  const provider = Object.values(f.providers()).find(p => p.apiKeyEnv)
  assert.equal(provider.baseURL, 'https://example.test/v1')
  assert.deepEqual(provider.models, [{ id: 'chat', name: 'chat' }])
  assert.equal(f.providers().other.displayName, 'Keep me')
  assert.equal(JSON.stringify(result).includes('secret-test-value'), false)
  assert.equal(JSON.stringify([...f.records.values()]).includes('secret-test-value'), false)
  assert.equal((await setup.status(f.ctx, 1)).status, 'ready')
  await createProviderSetup(f.options).run(f.ctx, 1)
  assert.equal(f.counts.create, 1, 'ready state survives plugin reload')
})

test('a later settings failure resumes the same newly created key', async () => {
  const f = fixture()
  const mutate = f.settings.mutate
  f.settings.mutate = async () => { throw new Error('settings conflict') }
  const setup = createProviderSetup(f.options)
  await assert.rejects(setup.run(f.ctx, 1), /配置未完成/)
  f.settings.mutate = mutate
  await setup.run(f.ctx, 1)
  assert.equal(f.counts.create, 1)
  assert.equal(f.counts.readKey, 2)
})

test('unknown create outcome never silently repeats POST', async () => {
  const f = fixture()
  let requests = 0
  f.options.userApi = async () => { requests++; throw new Error('response lost') }
  const setup = createProviderSetup(f.options)
  await assert.rejects(setup.run(f.ctx, 1), /未确认创建结果/)
  await assert.rejects(setup.run(f.ctx, 1), /未确认创建结果/)
  assert.equal(requests, 1)
})

test('account and profile identities isolate keys and provider entries', async () => {
  const f = fixture()
  const setup = createProviderSetup(f.options)
  await setup.run(f.ctx, 1)
  await setup.run(f.ctx, 2)
  f.settings.prepareDocument = async () => '/profiles/second/cordis.patch.yml'
  await setup.run(f.ctx, 1)
  assert.equal(f.counts.create, 3)
  assert.equal(f.secrets.size, 3)
  assert.equal(Object.keys(f.providers()).length, 4)
})

test('a definite create refusal can be retried without an orphaned configuration', async () => {
  const f = fixture()
  const userApi = f.options.userApi
  let refused = false
  f.options.userApi = async (...args) => {
    if (!refused) {
      refused = true
      throw Object.assign(new Error('rate limited'), { requestRejected: true })
    }
    return userApi(...args)
  }
  const setup = createProviderSetup(f.options)
  await assert.rejects(setup.run(f.ctx, 1), /网关拒绝创建/)
  await setup.run(f.ctx, 1)
  assert.equal(f.counts.create, 1)
})

test('no compatible models leaves retryable state without writing a provider', async () => {
  const f = fixture()
  f.options.models = async () => [{ id: 'image', supported_endpoint_types: ['image-generation'] }]
  const setup = createProviderSetup(f.options)
  await assert.rejects(setup.run(f.ctx, 1))
  assert.equal(f.counts.write, 0)
  assert.equal((await setup.status(f.ctx, 1)).status, 'error')
})

test('missing official services fails before creating any key', async () => {
  const f = fixture()
  await assert.rejects(createProviderSetup(f.options).run({ get: () => undefined }, 1), /缺少官方/)
  assert.equal(f.counts.create, 0)
})

test('manual provider edits are preserved', async () => {
  const f = fixture()
  const setup = createProviderSetup(f.options)
  await setup.run(f.ctx, 1)
  const provider = Object.values(f.providers()).find(p => p.apiKeyEnv)
  provider.models = [{ id: 'custom-user-choice' }]
  await setup.run(f.ctx, 1)
  assert.deepEqual(provider.models, [{ id: 'custom-user-choice' }])
  assert.equal(f.counts.write, 1)
})

test('completed setup is not repaired after the user removes its provider and credential', async () => {
  const f = fixture()
  await createProviderSetup(f.options).run(f.ctx, 1)
  for (const key of Object.keys(f.providers())) {
    if (key.startsWith('anywhere-')) delete f.providers()[key]
  }
  f.secrets.clear()
  f.settings.describe = () => { throw new Error('must not inspect model configuration') }
  const setup = createProviderSetup(f.options)
  assert.equal((await setup.status(f.ctx, 1)).status, 'ready')
  assert.equal((await setup.run(f.ctx, 1)).alreadyConfigured, true)
  assert.equal(f.counts.create, 1)
  assert.equal(f.counts.write, 1)
})

test('a confirmed deleted key during unfinished setup is replaced once, including concurrent retries', async () => {
  const f = fixture()
  const models = f.options.models
  f.options.models = async () => []
  await assert.rejects(createProviderSetup(f.options).run(f.ctx, 1))
  f.options.models = models
  const userApi = f.options.userApi
  f.options.userApi = async (...args) => {
    if (args[1] === '/api/token/1/key') {
      throw Object.assign(new Error('record not found'), { requestRejected: true })
    }
    return userApi(...args)
  }
  const setup = createProviderSetup(f.options)
  await Promise.all([setup.run(f.ctx, 1), setup.run(f.ctx, 1)])
  assert.equal(f.counts.create, 2)
  assert.equal((await setup.status(f.ctx, 1)).status, 'ready')
})

test('network, authorization and rate-limit failures never trigger replacement keys', async () => {
  for (const error of [new Error('record not found'),
    Object.assign(new Error('unauthorized'), { requestRejected: true }),
    Object.assign(new Error('rate limited'), { requestRejected: true })]) {
    const f = fixture()
    const userApi = f.options.userApi
    f.options.userApi = async (...args) => {
      if (args[1].endsWith('/key')) throw error
      return userApi(...args)
    }
    const setup = createProviderSetup(f.options)
    await assert.rejects(setup.run(f.ctx, 1))
    await assert.rejects(setup.run(f.ctx, 1))
    assert.equal(f.counts.create, 1)
  }
})

test('repeated key deletion cannot cause an unbounded creation loop', async () => {
  const f = fixture()
  const userApi = f.options.userApi
  f.options.userApi = async (...args) => {
    if (args[1].endsWith('/key')) {
      throw Object.assign(new Error('record not found'), { requestRejected: true })
    }
    return userApi(...args)
  }
  await assert.rejects(createProviderSetup(f.options).run(f.ctx, 1))
  assert.equal(f.counts.create, 2)
})

// Exercise the actual loopback handler without a browser, socket or stored credentials.
const hostSource = readFileSync(new URL('./index.js', import.meta.url), 'utf8')
const callbackStart = hostSource.indexOf('function waitForCallback(')
const callbackEnd = hostSource.indexOf('\n/**', callbackStart)
const waitForCallback = runInNewContext(
  `${hostSource.slice(callbackStart, callbackEnd)}; waitForCallback`,
  { URL, setTimeout, clearTimeout, LOOPBACK_HOST: '127.0.0.1',
    LOGIN_TIMEOUT_MS: 1000, BASE_URL: 'https://example.test' },
)

test('callback reports setup success only after completion and rejects duplicate callbacks', async () => {
  let handler
  let finishSetup
  const completed = new Promise(resolve => { finishSetup = resolve })
  const pending = waitForCallback({ on: (_, fn) => { handler = fn } }, { state: 'test' }, () => completed)
  let html
  const response = { writeHead() { return this }, end(value) { html = value } }
  const request = { url: '/callback?code=example&state=test' }
  const first = handler(request, response)
  assert.equal(html, undefined)
  let duplicateStatus
  await handler(request, { writeHead(status) { duplicateStatus = status; return this }, end() {} })
  assert.equal(duplicateStatus, 409)
  finishSetup({ status: 'ready' })
  await first
  await pending
  assert.match(html, /<h1 id="result-title">模型配置和APIkey已自动导入DSH<\/h1>/)
  assert.match(html, /已自动创建 API Key 并写入 DSH 模型配置/)
})

test('failed setup or invalid OAuth callbacks never claim successful provisioning', async () => {
  for (const state of ['test', 'wrong']) {
    let handler
    let calls = 0
    const pending = waitForCallback({ on: (_, fn) => { handler = fn } }, { state: 'test' }, async () => {
      calls++
      throw new Error('private upstream detail')
    })
    const rejection = assert.rejects(pending)
    let html
    await handler({ url: `/callback?code=example&state=${state}` }, {
      writeHead() { return this }, end(value) { html = value },
    })
    await rejection
    assert.equal(calls, state === 'test' ? 1 : 0)
    assert.doesNotMatch(html, /已自动创建|private upstream detail/)
  }
})
