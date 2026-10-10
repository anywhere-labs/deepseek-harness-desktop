/** Run the exact vendored runtime methods, with or without Desktop's trash patch. */
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { runInNewContext } from 'node:vm'
import { test, after } from 'node:test'

const root = resolve(import.meta.dirname, '..')
const temporary = mkdtempSync(join(tmpdir(), 'dsh-trash-runtime-'))
after(() => rmSync(temporary, { recursive: true, force: true }))
class RemoteError extends Error { constructor(code, message, detail) { super(message); this.code = code; this.detail = detail } }
class SessionQueryError extends Error {}
const schema = new Proxy(() => schema, { get: () => schema, apply: () => schema })
const sandbox = { RemoteError, SessionQueryError, z: schema, z$1: schema, performance, mkdir: async () => {}, scheduler: { yield: async () => {} }, SESSION_SEARCH_RESULT_LIMIT: 20, SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS: 100 }
function evaluate(source, result) {
  return runInNewContext(source.replace(/^import[^\n]+;\n/gmu, '').replace(/^export /gmu, '') + '\n' + result, { ...sandbox })
}
function method(source, signature) {
  const start = source.lastIndexOf(signature)
  assert.notEqual(start, -1, `missing runtime method ${signature}`)
  let position = source.indexOf('{', start), depth = 1
  const bodyStart = position + 1
  while (depth > 0) { position++; if (source[position] === '{') depth++; else if (source[position] === '}') depth-- }
  return runInNewContext(`(async function(request){${source.slice(bodyStart, position)}})`, { ...sandbox })
}

for (const version of ['0.2.1-alpha.2', '0.2.0-rc.2']) {
  const base = join(temporary, version)
  mkdirSync(base, { recursive: true })
  execFileSync('tar', ['-xzf', join(root, `vendor/dsh-runtime/${version}/deepseek-ai-dsh-api-session-controller-${version}.tgz`), '-C', base], { env: { ...process.env, LC_ALL: 'C' } })
  let pkg = join(base, 'package')
  if (process.env.DSH_ISSUE369_UNPATCHED !== '1') execFileSync('git', ['apply', join(process.env.DSH_ISSUE369_PATCH_DIR ?? join(root, 'patches'), `dsh-api-session-controller@${version}.patch`)], { cwd: pkg })
  if (process.env.DSH_ISSUE369_INSTALLED === '1') pkg = join(root, version === '0.2.0-rc.2' ? 'dsh-plugin-desktop' : 'dsh-plugin-desktop-beta', 'node_modules/@deepseek-ai/dsh-api-session-controller')
  const load = name => readFileSync(join(pkg, 'lib/types', name), 'utf8')
  const bundle = readFileSync(join(pkg, 'lib/index.js'), 'utf8')
  function region(name) {
    const start = bundle.indexOf('//#region lib/types/' + name)
    assert.notEqual(start, -1, 'missing shipped bundle region ' + name)
    return bundle.slice(start, bundle.indexOf('//#endregion', start)) + (process.env.DSH_ISSUE369_UNPATCHED === '1' ? '' : '\n' + bundle.slice(bundle.lastIndexOf('function desktopSessionTrashOf(ctx)')))
  }
  for (const face of ['types', 'bundle']) {
  const suffix = version + '/' + face
  const code = name => face === 'types' ? load(name) : region(name)
  const ApiSessionList = evaluate(code('list.js'), 'ApiSessionList')
  const ApiSessionAgentController = evaluate(code('agent.js'), 'ApiSessionAgentController')
  const underArchivedSession = evaluate(code('archived-session-gate.js'), 'underArchivedSession')
  const source = face === 'types' ? load('index.js') : bundle
  if (process.env.DSH_ISSUE369_UNPATCHED !== '1') sandbox.desktopSessionTrashOf = runInNewContext(bundle.slice(bundle.lastIndexOf('function desktopSessionTrashOf(ctx)')) + '\n desktopSessionTrashOf')
  const fork = method(source, version === '0.2.1-alpha.2' ? 'async fork(request)' : 'fork(request)')
  const deleted = new Set(['parent'])
  function context() {
    const records = ['parent', 'branch'].map(id => ({ header: { id, cwd: '/work', createdAt: 1 } }))
    const query = {
      listSessions: async () => records,
      searchSessions: async () => ({ items: records.map(({ header }) => ({ header, bestMatch: { sessionId: header.id, surface: 'current', type: 'user/message', snippet: 'match' } })) }),
    }
    return {
      get(name) { return name === 'desktopSessionTrash' ? { has: id => deleted.has(id), blocks: id => deleted.has(id) } : name === 'sessionQuery' ? query : undefined },
      sessionQuery: query, sessions: { get: id => ({ id, header: { id } }) }, agents: { get: () => undefined },
      sessionProjections: { register() {} }, inject() {},
      typert: { lookups: { configure() {} }, contexts: { configureHost() {} } },
    }
  }
  test(`${suffix}: deleted ordinary/archived catalogs exclude parent but preserve branch`, async () => {
    const list = new ApiSessionList(context(), 100)
    list.summaryFor = session => ({ sessionId: session.id, updatedAt: 1 })
    assert.deepEqual(Array.from(await list.list(), item => item.sessionId), ['branch'])
    deleted.clear()
    assert.deepEqual(new Set(Array.from(await list.list(), item => item.sessionId)), new Set(['parent', 'branch']))
    deleted.add('parent')
  })
  test(`${suffix}: content search excludes deleted parent`, async () => {
    const list = new ApiSessionList(context(), 100)
    assert.deepEqual(Array.from((await list.search('match', new AbortController().signal)).items, item => item.sessionId), ['branch'])
  })
  test(`${suffix}: deleted source cannot resume, be adopted, or fork`, async () => {
    const controller = new ApiSessionAgentController(context())
    controller.liveAgent = () => ({ agent: {} })
    await assert.rejects(controller.resolve('parent'), error => error.code === 'session/agent-busy' && /Restore/.test(error.message))
    await assert.rejects(controller.createOrAdopt('parent', '/work', false), error => error.code === 'session/agent-busy')
    let forks = 0
    await assert.rejects(async () => fork.call({ ctx: context(), commands: { fork() { forks++; return {} } } }, { sessionId: 'parent' }), error => error.code === 'session/agent-busy')
    assert.equal(forks, 0)
  })
  test(`${suffix}: model gate blocks trash and subagents without blocking independent branches`, () => {
    const ctx = { ...context(), workspaceRegistry: { archivedSessionIds: [] }, sessions: { get: () => undefined } }
    assert.equal(underArchivedSession(ctx, { session: { header: { id: 'parent' } } }), true)
    assert.equal(underArchivedSession(ctx, { session: { header: { id: 'child', origin: 'subagent', parentSession: 'parent' } } }), true)
    assert.equal(underArchivedSession(ctx, { session: { header: { id: 'branch', isSeeded: true, parentSession: 'parent' } } }), false)
  })
  test(`${suffix}: late concurrent deletion is rechecked after async search`, async () => {
    deleted.clear()
    const ctx = context()
    const original = ctx.sessionQuery.searchSessions
    ctx.sessionQuery.searchSessions = async () => { const result = await original(); deleted.add('parent'); return result }
    const list = new ApiSessionList(ctx, 100)
    assert.deepEqual(Array.from((await list.search('match', new AbortController().signal)).items, item => item.sessionId), ['branch'])
  })
  test(`${suffix}: stale mutation/history entry points refuse deleted identities`, async () => {
    for (const name of ['selectModel', 'rename', 'prompt', 'attachment', 'updateQueue', 'projections', 'page', 'follow']) {
      const signature = new RegExp('(?:async )?' + name + '\\(request(?:, signal)?\\) \\{').exec(source)?.[0]
      assert.ok(signature, 'missing method ' + name)
      const operation = method(source, signature)
      await assert.rejects(async () => operation.call({ ctx: context() }, { sessionId: 'parent', address: { kind: 'session', sessionId: 'parent' } }), error => error.code === 'session/agent-busy')
    }
  })
  test(`${suffix}: a missing required Desktop fence refuses catalog admission`, async () => {
    const ctx = context(); ctx.get = name => name === 'desktopSessionTrashRequired' ? true : undefined
    const list = new ApiSessionList(ctx, 100); list.summaryFor = session => ({ sessionId: session.id, updatedAt: 1 })
    await assert.rejects(list.list(), /protection is unavailable/)
  })
  test(`${suffix}: a late fault disposes only the handle returned by its own factory`, async () => {
    for (const operation of ['resume', 'create']) {
      let fault = false; let disposed = 0
      const ctx = context(); ctx.sessions.get = () => undefined
      const originalGet = ctx.get
      ctx.get = name => name === 'desktopSessionTrash' ? { blocks() { if (fault) throw new Error('metadata disappeared'); return false }, has: () => false } : originalGet(name)
      ctx.agents[operation] = async () => { fault = true; return { agent: {}, dispose: async () => { disposed++ } } }
      const controller = new ApiSessionAgentController(ctx)
      controller.composeAgent = async () => ({ setup: () => {} }); controller.presetForObservation = () => undefined; controller.agentOptions = () => ({})
      const promise = operation === 'resume'
        ? controller.resumeObserved('target', { header: { id: 'target', cwd: '/work' } })
        : controller.createOrAdopt('target', '/work', false)
      await assert.rejects(promise, /metadata disappeared/)
      assert.equal(disposed, 1, 'a failed admission must dispose its own newly returned handle')
    }
  })
  test(`${suffix}: runtime remains unchanged when Desktop trash is absent`, async () => {
    const ctx = context(); ctx.get = () => undefined
    const list = new ApiSessionList(ctx, 100); list.summaryFor = session => ({ sessionId: session.id, updatedAt: 1 })
    assert.equal((await list.list()).length, 2)
  })
}
}
