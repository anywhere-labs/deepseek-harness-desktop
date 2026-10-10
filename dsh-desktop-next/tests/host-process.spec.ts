import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesktopHostFatalError, DesktopHostProcess, DesktopHostUncleanExitError } from '../src/host-process.ts'

const roots: string[] = []
const hosts: DesktopHostProcess[] = []

const HTTP_HOST = `
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
const server = createServer((request, response) => {
  if (request.url === '/fatal') {
    process.send({ type: 'fatal', message: 'plugin unavailable' })
    response.end('reported')
    return
  }
  if (request.url === '/crash') {
    response.end('exiting', () => {
      process.stderr.write('plugin crashed', () => process.exit(7))
    })
    return
  }
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify({runtime: process.argv[2], profile: process.argv[3], cwd: process.cwd(), nodePath: process.env.NODE_PATH, registry: process.env.NPM_CONFIG_REGISTRY, nodeOptions: process.env.NODE_OPTIONS, runAsNode: process.env.ELECTRON_RUN_AS_NODE, internals: process.execArgv.includes('--expose-internals')}))
})
server.listen(0, '127.0.0.1', () => {
  process.send({ type: 'ready', url: 'http://127.0.0.1:' + server.address().port + '/?token=fixture' })
})
process.on('message', message => {
  if (message.type === 'browser-access') {
    process.send({ type: 'browser-access', requestId: message.requestId, ...(message.enabled ? {} : { error: 'fixture rejection' }) })
    return
  }
  if (message.type === 'update-tasks') {
    process.send({ type: 'update-tasks', requestId: message.requestId, active: message.action === 'lock' })
    return
  }
  if (message.type !== 'shutdown') return
  server.close(() => {
    writeFileSync(join(process.argv[3], 'stopped'), '')
    process.send({ type: 'shutdown-complete' }, () => process.disconnect())
  })
  server.closeAllConnections()
})
`

function projectWithHost(source = HTTP_HOST): string {
  const project = mkdtempSync(join(tmpdir(), 'dsh-desktop-host-test-'))
  roots.push(project)
  const packageRoot = join(project, 'node_modules', '@deepseek-ai', 'dsh-desktop-host')
  mkdirSync(join(packageRoot, 'lib'), { recursive: true })
  writeFileSync(join(packageRoot, 'package.json'), '{"name":"@deepseek-ai/dsh-desktop-host","type":"module"}\n')
  writeFileSync(join(packageRoot, 'lib', 'index.js'), source)
  return project
}

function hostProcess(
  runtime: string, profile = runtime, onFailure?: (error: Error) => void, environment = process.env,
): DesktopHostProcess {
  const host = new DesktopHostProcess(process.execPath, runtime, profile, undefined, environment, onFailure)
  hosts.push(host)
  return host
}

afterEach(async () => {
  await Promise.all(hosts.splice(0).map(host => host.stop()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('desktop host process', () => {
  it('returns Desktop permission snapshots over private child IPC', async () => {
    const snapshot = { permission: 'screen' as const, status: 'denied' as const, canRequest: false, canOpenSettings: true }
    const source = HTTP_HOST.replace('const server = createServer', 'let permissionResponse;\nconst server = createServer')
      .replace("  if (request.url === '/fatal') {", `
        if (request.url === '/permission') {
          permissionResponse = response;
          process.send({ type: 'permission', requestId: 7, action: 'query', permission: 'screen' }); return;
        }
        if (request.url === '/fatal') {`)
      .replace("  if (message.type === 'browser-access') {", `
        if (message.type === 'permission-result') { permissionResponse.end(JSON.stringify(message)); return; }
        if (message.type === 'browser-access') {`)
    const runtime = projectWithHost(source)
    const permission = vi.fn(async () => snapshot)
    const host = new DesktopHostProcess(process.execPath, runtime, runtime, undefined, process.env, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, permission)
    hosts.push(host)
    const { url } = await host.start()
    expect(await (await fetch(new URL('/permission', url))).json()).toEqual({ type: 'permission-result', requestId: 7, snapshot })
    expect(permission).toHaveBeenCalledExactlyOnceWith('query', 'screen')
  })

  it('delivers bounded user-turn previews over child IPC', async () => {
    const notification = { outcome: 'turn-completed', userMessage: 'Check my code', assistantMessage: 'Fixed the issue.' }
    const runtime = projectWithHost(HTTP_HOST.replace("  if (request.url === '/fatal') {", `
      if (request.url === '/notify') {
        process.send({ type: 'notification', notification: ${JSON.stringify(notification)} })
        response.end('sent'); return
      }
      if (request.url === '/fatal') {`))
    const notify = vi.fn()
    const failure = vi.fn()
    const host = new DesktopHostProcess(process.execPath, runtime, runtime, undefined, process.env, failure,
      undefined, undefined, undefined, undefined, notify)
    hosts.push(host)
    const { url } = await host.start()
    await fetch(new URL('/notify', url))
    await expect.poll(() => notify.mock.calls).toEqual([[notification]])
    expect(failure).not.toHaveBeenCalled()
  })

  it('applies logging settings through correlated acknowledgements and records IPC metadata only', async () => {
    const runtime = projectWithHost(HTTP_HOST.replace("  if (message.type === 'browser-access') {", `
      if (message.type === 'logging-config') {
        process.send({ type: 'logging-config', requestId: message.requestId }); return;
      }
      if (message.type === 'browser-access') {`))
    const diagnostic = vi.fn()
    const host = new DesktopHostProcess(process.execPath, runtime, runtime, undefined, process.env,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, diagnostic)
    hosts.push(host)
    await host.start()
    await Promise.all([host.setLogging({ developerLogging: true, logLevel: 'debug' }), host.setLogging({ developerLogging: false, logLevel: 'info' })])
    const complete = diagnostic.mock.calls.map(([record]) => record).filter(record => record.event === 'control.complete')
    expect(complete).toHaveLength(2)
    expect(complete[0].operationId).not.toBe(complete[1].operationId)
    expect(complete[0]).toMatchObject({ source: 'host.ipc', fields: { type: 'logging-config' } })
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('token=fixture')
    await host.stop()
    await expect(host.setLogging({ developerLogging: true, logLevel: 'info' })).rejects.toThrow('unavailable')
  })

  it('correlates browser-policy acknowledgements and refuses stale or failed changes', async () => {
    const host = hostProcess(projectWithHost())
    await expect(host.setBrowserAccess(true)).rejects.toThrow('unavailable')
    await host.start()
    const results = await Promise.allSettled([host.setBrowserAccess(true), host.setBrowserAccess(false), host.setBrowserAccess(true)])
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected', 'fulfilled'])
    await host.stop()
    await expect(host.setBrowserAccess(true)).rejects.toThrow('unavailable')
  })

  it('correlates task inspections and admission changes over private IPC', async () => {
    const host = hostProcess(projectWithHost())
    await expect(host.updateTasks('inspect')).rejects.toThrow('Host is unavailable')
    await host.start()
    expect(await Promise.all([host.updateTasks('inspect'), host.updateTasks('lock'), host.updateTasks('unlock')]))
      .toEqual([false, true, false])
    await host.stop(true)
    await expect(host.updateTasks('inspect')).rejects.toThrow('Host is unavailable')
  })

  it.each([
    'process.exit(17)',
    'process.exit(0)',
  ])('refuses installation when exit lacks successful teardown acknowledgement: %s', async (exit) => {
    const host = hostProcess(projectWithHost(`
      process.send({ type: 'ready', url: 'http://127.0.0.1:3080/' })
      process.on('message', message => {
        if (message.type === 'shutdown') process.stderr.write('token=fixture-secret', () => { ${exit} })
      })
    `))
    await host.start()
    const error = await host.stop(true).then(() => undefined, (error: unknown) => error)
    expect(error).toBeInstanceOf(DesktopHostUncleanExitError)
    expect(String(error)).toContain('shutdown acknowledged false')
    expect(String(error)).toContain('graceful deadline exceeded false')
    expect(String(error)).not.toContain('fixture-secret')
    await expect(host.stop()).resolves.toBeUndefined()
  })

  it('returns the Web authentication URL and waits for graceful shutdown', async () => {
    const runtime = projectWithHost()
    const failure = vi.fn()
    const host = hostProcess(runtime, runtime, failure)
    const ready = await host.start()
    expect(new URL(ready.url).searchParams.get('token')).toBe('fixture')
    expect(await host.start()).toEqual(ready)
    expect((await fetch(ready.url)).status).toBe(200)
    await host.stop()
    expect(existsSync(join(runtime, 'stopped'))).toBe(true)
    await expect(fetch(ready.url)).rejects.toThrow()
    expect(failure).not.toHaveBeenCalled()
  })

  it('passes external dependencies and package-manager paths to the Host', async () => {
    const runtime = projectWithHost(HTTP_HOST.replace('runtime: process.argv[2]',
      'pnpm: process.argv[5], nodeBin: process.argv[6], primaryRuntime: process.argv[4], runtime: process.argv[2]'))
    const primaryRuntime = join(runtime, 'external-primary-runtime')
    const host = new DesktopHostProcess(process.execPath, runtime, runtime, undefined, process.env,
      undefined, primaryRuntime, { pnpm: join(runtime, 'pnpm.mjs'), nodeBin: join(runtime, 'bin') })
    hosts.push(host)
    const { url } = await host.start()
    expect(await (await fetch(url)).json()).toMatchObject({ primaryRuntime, pnpm: join(runtime, 'pnpm.mjs'), nodeBin: join(runtime, 'bin') })
  })

  it('reports a fatal event after readiness once', async () => {
    const runtime = projectWithHost()
    const failure = vi.fn()
    const host = hostProcess(runtime, runtime, failure)
    const { url } = await host.start()
    await fetch(new URL('/fatal', url))
    await expect.poll(() => failure.mock.calls.length).toBe(1)
    await host.stop()
    expect(failure).toHaveBeenCalledTimes(1)
    expect(failure).toHaveBeenCalledWith(new Error('plugin unavailable'))
  })

  it('reports a child crash after readiness with its stderr diagnostic', async () => {
    const runtime = projectWithHost()
    const failure = vi.fn()
    const host = hostProcess(runtime, runtime, failure)
    const { url } = await host.start()
    await fetch(new URL('/crash', url))
    await expect.poll(() => failure.mock.calls.length).toBe(1)
    expect(failure).toHaveBeenCalledWith(new Error('dsh desktop host exited with 7: plugin crashed'))
  })

  it('retains only recent diagnostics from a noisy child', async () => {
    const runtime = projectWithHost('process.stderr.write(\'discarded-prefix\' + \'x\'.repeat(70_000) + \'recent-failure\', () => { process.exitCode = 7; process.disconnect() })')
    const failure = await hostProcess(runtime).start().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    const message = (failure as Error).message
    expect(message).not.toContain('discarded-prefix')
    expect(message.endsWith('recent-failure')).toBe(true)
    expect(message.length).toBeLessThan(66_000)
  })

  it('settles teardown when the executable cannot be spawned', async () => {
    const runtime = projectWithHost()
    const host = new DesktopHostProcess(join(runtime, 'missing-node'), runtime, runtime)
    hosts.push(host)
    await expect(host.start()).rejects.toThrow()
    await host.stop()
  })

  it('loads the resource entry with a separate profile and inherits runtime and package-manager configuration', async () => {
    const runtime = projectWithHost()
    const profile = mkdtempSync(join(tmpdir(), 'desktop-external-profile-'))
    roots.push(profile)
    const host = hostProcess(runtime, profile, undefined, {
      ...process.env, NODE_OPTIONS: '--no-warnings', NODE_PATH: '/custom', NPM_CONFIG_REGISTRY: 'https://registry.example.test/',
    })
    const { url } = await host.start()
    const response = await fetch(url)
    expect(await response.json()).toEqual({ runtime, profile, cwd: realpathSync(profile), nodePath: '/custom', registry: 'https://registry.example.test/', nodeOptions: '--no-warnings', runAsNode: '1', internals: true })
  })

  it.each([
    ["process.send({ type: 'fatal', message: 'startup failed' }); process.disconnect()", 'startup failed'],
    ["process.send({ type: 'ready', url: 4 })", 'invalid IPC event'],
    ["process.send({ type: 'fatal', message: 'startup failed', diagnostic: 42 })", 'invalid IPC event'],
    ['process.exit(0)', 'host stopped'],
  ])('rejects startup when the child fails before readiness: %s', async (source, message) => {
    const host = hostProcess(projectWithHost(source))
    await expect(host.start()).rejects.toThrow(message)
  })

  it('keeps the Host\'s inspected error separate from the message it reports', async () => {
    const diagnostic = "Error: startup failed\\n    at boot (lib/index.js:3:9) {\\n  code: 'ENOENT',\\n  path: '/profile/cordis.yml'\\n}"
    const failures: Error[] = []
    const host = hostProcess(projectWithHost(
      `process.send({ type: 'fatal', message: 'startup failed', diagnostic: ${JSON.stringify(diagnostic)} }); process.disconnect()`,
    ), undefined, (error) => { failures.push(error) })
    await expect(host.start()).rejects.toThrow('startup failed')
    const [failure] = failures
    expect(failure).toBeInstanceOf(DesktopHostFatalError)
    expect((failure as DesktopHostFatalError).diagnostic).toBe(diagnostic)
    expect(Object.keys(failure!)).not.toContain('diagnostic')
  })

  it('carries Platform credentials over private IPC and clears them on shutdown', async () => {
    const runtime = projectWithHost(HTTP_HOST.replace("process.send({ type: 'ready'", "process.send({ type: 'platform-session', session: { origin: 'https://platform.deepseek.com', token: 'fixture-secret', embeddedPageDist: 'feat/test' } }); process.send({ type: 'ready'"))
    const changed = vi.fn()
    const host = new DesktopHostProcess(process.execPath, runtime, runtime, undefined, process.env, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, changed)
    hosts.push(host)
    await host.start()
    expect(changed).toHaveBeenCalledWith({ origin: 'https://platform.deepseek.com', token: 'fixture-secret', embeddedPageDist: 'feat/test' })
    await host.stop()
    expect(changed).toHaveBeenLastCalledWith(null)
  })

  it.each([
    ["{ origin: 'https://platform.deepseek.com', token: '' }", 'an empty credential'],
    ["{ origin: 'http://platform.deepseek.com', token: 'secret' }", 'a plaintext non-loopback origin'],
    ["{ origin: 'https://user:pass@platform.deepseek.com', token: 'secret' }", 'embedded userinfo'],
    ["{ origin: 'https://platform.deepseek.com/app', token: 'secret' }", 'a path beyond the origin'],
    ["{ origin: 'https://platform.deepseek.com', token: 'secret', requestHeaders: { 'X-Deploy': 'a' } }", 'an upper-case header name'],
    ["{ origin: 'https://platform.deepseek.com', token: 'secret', requestHeaders: { authorization: 'a' } }", 'a forbidden header'],
    ["{ origin: 'https://platform.deepseek.com', token: 'secret', requestHeaders: { 'x-deploy': 'a\\r\\nx: b' } }", 'a header value carrying CRLF'],
  ])('refuses a Platform session with %s (%s)', async (session) => {
    const host = hostProcess(projectWithHost(`process.send({ type: 'platform-session', session: ${session} })`))
    await expect(host.start()).rejects.toThrow('invalid IPC event')
  })

  it('hands Platform sign-in pages and ended attempts to the shell', async () => {
    const url = 'https://platform.deepseek.com/dsh/authorize?state=fixture'
    const runtime = projectWithHost(HTTP_HOST.replace("process.send({ type: 'ready'",
      `process.send({ type: 'platform-login', action: 'open', url: '${url}' }); process.send({ type: 'platform-login', action: 'close', focus: true }); process.send({ type: 'ready'`))
    const login = vi.fn()
    const host = new DesktopHostProcess(process.execPath, runtime, runtime, undefined, process.env, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, login)
    hosts.push(host)
    await host.start()
    expect(login.mock.calls).toEqual([[{ action: 'open', url }], [{ action: 'close', focus: true }]])
  })

  it.each([
    ["{ type: 'platform-login', action: 'open', url: 'http://platform.deepseek.com/dsh/authorize' }", 'a plaintext non-loopback page'],
    ["{ type: 'platform-login', action: 'open', url: 'https://user:pass@platform.deepseek.com/' }", 'embedded userinfo'],
    ["{ type: 'platform-login', action: 'open', url: 'file:///C:/Windows/System32/calc.exe' }", 'a local file'],
    ["{ type: 'platform-login', action: 'open' }", 'a missing page'],
    ["{ type: 'platform-login', action: 'run', url: 'https://platform.deepseek.com/' }", 'an unknown action'],
    ["{ type: 'platform-login', action: 'close' }", 'a close without a focus decision'],
  ])('refuses a Platform sign-in request %s (%s)', async (event) => {
    const host = hostProcess(projectWithHost(`process.send(${event})`))
    await expect(host.start()).rejects.toThrow('invalid IPC event')
  })
})
