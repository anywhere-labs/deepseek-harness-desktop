// Boots the real isolated Host child process through the real bootstrap path
// and checks that a failure reported from inside the plugin tree reaches the
// real log files. The unit and integration specs cover formatting and the
// exporter; only this one proves the listener is actually wired up at boot,
// and that `agent/error` crosses from a plugin context to the Host context.
import { fork, type Serializable } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { prepareDesktopProfile } from '../src/profile.ts'
import { desktopReleaseUserDataLocations } from '../src/profile-channel-admission.ts'
import { installDesktopPnpmRuntime } from '../src/desktop-runtime-environment.ts'
import { HostRpc } from '../src/host-rpc.ts'
import { bindNativeRuntime, runtimeSnapshot } from '../src/host-runtime-bridge.ts'
import type { DesktopRuntime, DesktopShellSpec } from '../src/runtime.ts'

const SESSION_ID = 'ws-1-session-realhost-probe'

it('writes a plugin-reported agent failure to the real Host log files', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-agent-error-host-'))
  const token = Buffer.alloc(32, 7).toString('base64url')
  let child: ReturnType<typeof fork> | undefined
  let rpc: HostRpc | undefined
  let releaseNative: (() => Promise<void>) | undefined
  let pnpm: ReturnType<typeof installDesktopPnpmRuntime> | undefined
  let stderr = ''
  try {
    writeFileSync(join(home, 'settings.yaml'), 'dsh-desktop:\n  mode: advanced\nagent-presets:\n  default: minimal\n')
    const prepared = prepareDesktopProfile('1', home, 'win32', undefined, undefined, undefined, { aaEnabled: false })
    prepared.overlays = []
    prepared.port = 0

    // A real server-side plugin. Its `apply` runs inside the Host's plugin
    // tree, so this emit takes the same route agent-loop's failure report does
    // — which is the part no in-process test can stand in for.
    const plugin = join(prepared.profile.dir, 'node_modules', 'agent-error-probe')
    mkdirSync(plugin, { recursive: true })
    writeFileSync(join(plugin, 'package.json'), JSON.stringify({
      name: 'agent-error-probe', version: '1.0.0', type: 'module',
      exports: { '.': './index.js', './package.json': './package.json' },
    }))
    // Shaped like llm-deepseek's failure: a `code` field, not a code in the text.
    writeFileSync(join(plugin, 'index.js'), `
export function apply(ctx) {
  setTimeout(() => {
    const root = new Error('cannot resolve active package')
    const wrapped = Object.assign(
      new Error('DeepSeek request extension preparation failed', { cause: root }),
      { code: 'REQUEST_EXTENSION' },
    )
    wrapped.name = 'LlmError'
    ctx.emit('agent/error', {
      agent: { id: ${JSON.stringify(SESSION_ID)} },
      turn: 3,
      step: 2,
      error: wrapped,
    })
  }, 100)
}
`)
    prepared.overlays.push({ insert: [{ id: 'agent-error-probe', name: 'agent-error-probe' }] })

    const packageRoot = new URL('../', import.meta.url)
    const pnpmBinPath = fileURLToPath(new URL('node_modules/pnpm/bin/pnpm.mjs', packageRoot))
    const electronVersion = JSON.parse(readFileSync(new URL('node_modules/electron/package.json', packageRoot), 'utf8')).version
    pnpm = installDesktopPnpmRuntime({ platform: process.platform, appExecutable: process.execPath, pnpmBinPath,
      electronVersion, stateDir: join(home, 'runtime'), environment: process.env })
    prepared.patches.push(...prepared.overlays)
    child = fork(fileURLToPath(new URL('./fixtures/isolated-host/child.mjs', import.meta.url)), [], {
      execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'advanced',
    })
    child.stderr?.on('data', data => { stderr += String(data) })
    const [ready] = await once(child, 'message')
    expect(ready).toEqual({ ready: true })
    const worker = child
    rpc = new HostRpc({ send: data => worker.send(data as Serializable),
      listen: receive => { worker.on('message', receive); return () => { worker.off('message', receive) } },
    }, 30_000)
    child.on('exit', () => rpc?.close(stderr || 'worker exited'))
    let shell: DesktopShellSpec | undefined
    const runtime = {
      platform: 'win32', locale: 'en',
      updates: { isPackaged: false, canDownload: false, currentVersion: '2.0.7-beta.1', statePath: join(home, 'updates') },
      schedule(spec: DesktopShellSpec) { shell = spec; return async () => {} },
      registerTrayItem() { return { refresh() {}, dispose() {} } },
      setLocalePreference() {}, setThemeSource() {},
    } as unknown as DesktopRuntime
    releaseNative = bindNativeRuntime(rpc, runtime)
    rpc.handle('certificate', () => ({ failureCode: 'test-disabled' }))
    rpc.handle('quit', () => {})

    const logDirectory = join(home, 'logs')
    await rpc.call<{ pid: number }>('boot', [{
      prepared, profilePreferences: { mode: 'advanced', openBrowser: false, networkExposure: 'loopback',
        macosMaterial: 'auto', windowsMaterial: 'auto', market: 'disabled', notifications: { enabled: false }, aaEnabled: false },
      homeDir: home, activeProfileName: prepared.profile.name, pluginManagementStatePath: join(home, 'plugins.json'),
      selectionStatePath: join(home, 'selection.json'), marketUserDataDir: join(home, 'userdata'),
      releaseUserDataLocations: desktopReleaseUserDataLocations(home, join(home, 'userdata')),
      launchEnvironmentLayers: [],
      // Empty is what the supervisor sends when the machine has no system proxy, so the Host still
      // installs its outbound policy here and resolves every probe to a direct connection.
      desktopProxyOverlay: {},
      desktopPnpmBootstrap: { activeProfileName: prepared.profile.name, activeProfileDir: prepared.profile.dir, homeDir: home,
        appExecutable: process.execPath, pnpmBinPath, electronVersion, nodeBinDir: pnpm.nodeBinDir,
        nodeShimPath: pnpm.nodeShimPath, clearEnvironmentPath: pnpm.clearEnvironmentPath,
        dshBootstrapPath: fileURLToPath(new URL('../lib/desktop-cli.js', import.meta.url)) },
      logDirectory,
    }, runtimeSnapshot(runtime), token])
    expect(shell).toBeDefined()

    const readLogs = (suffix: string): string => readdirSync(logDirectory)
      .filter(name => name.endsWith(suffix))
      .map(name => readFileSync(join(logDirectory, name), 'utf8'))
      .join('')
    await expect.poll(() => readLogs('.log').includes('dsh-agent-error'), { timeout: 20_000 }).toBe(true)

    const logs = readLogs('.log')
    // The digest line: the only place the code, session, turn and step meet.
    expect(logs).toContain(`agent turn failed (session ${SESSION_ID}, turn 3, step 2) [REQUEST_EXTENSION]`)
    expect(logs).toContain('DeepSeek request extension preparation failed: cannot resolve active package')
    // Cordis expanded the chain, so the root cause got its own record and stack.
    expect(logs).toContain('Error: cannot resolve active package')
    expect(logs).toContain('LlmError: DeepSeek request extension preparation failed')
    // Nothing was swallowed by maskSecrets on the way through the real sink.
    expect(logs).not.toContain('****')
    // The failure also reaches the error-only file, which is what users send us.
    expect(readLogs('.error.log')).toContain('[REQUEST_EXTENSION]')
    await rpc.call('stop')
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.stack : String(error)}\n${stderr}`)
  } finally {
    await releaseNative?.()
    rpc?.close()
    if (child && child.exitCode === null) { const exit = once(child, 'exit'); child.kill(); await exit }
    pnpm?.dispose()
    rmSync(home, { recursive: true, force: true })
  }
}, 120_000)
