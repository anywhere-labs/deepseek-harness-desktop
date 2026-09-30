import assert from 'node:assert/strict'
import { test } from 'node:test'
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
