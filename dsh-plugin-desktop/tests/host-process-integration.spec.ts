import { fork, type Serializable } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
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

it.each([false, true])('boots a separate Web Host with client plugins (AA enabled: %s)', async aaEnabled => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-isolated-host-'))
  const token = Buffer.alloc(32, 7).toString('base64url')
  let child: ReturnType<typeof fork> | undefined
  let rpc: HostRpc | undefined
  let releaseNative: (() => Promise<void>) | undefined
  let pnpm: ReturnType<typeof installDesktopPnpmRuntime> | undefined
  let stderr = ''
  try {
    writeFileSync(join(home, 'settings.yaml'), 'dsh-desktop:\n  mode: advanced\nagent-presets:\n  default: minimal\n')
    const prepared = prepareDesktopProfile('1', home, 'win32', undefined, undefined, undefined, { aaEnabled })
    prepared.overlays = []
    if (aaEnabled) prepared.overlays.push({ id: 'agents-anywhere-bridge-next', config: { dshHome: home, stateRoot: join(home, 'aa-state') } })
    prepared.port = 0
    const plugin = join(prepared.profile.dir, 'node_modules', 'isolated-client-fixture')
    mkdirSync(plugin, { recursive: true })
    writeFileSync(join(plugin, 'package.json'), JSON.stringify({ name: 'isolated-client-fixture', version: '1.0.0', type: 'module',
      exports: { '.': './index.js', './client': './client.js', './package.json': './package.json' }, dsh: { client: { platform: 'web' } } }))
    writeFileSync(join(plugin, 'index.js'), 'export function apply() {}\n')
    writeFileSync(join(plugin, 'client.js'), 'export function apply(ctx) { ctx.provide("isolatedClientFixture", true) }\n')
    prepared.overlays.push({ insert: [{ id: 'isolated-client-fixture', name: 'isolated-client-fixture' }] })
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
    // The legacy settings document above is imported once the Loader settles, which
    // is after this profile has mounted in compatibility. The imported `advanced`
    // mode is restart-applied, so 0.1.7 asks the runtime to restart exactly once on
    // the first boot after an upgrade; a runtime without the method faults the Host.
    const restarts: string[] = []
    const runtime = {
      platform: 'win32', locale: 'en',
      updates: { isPackaged: false, canDownload: false, currentVersion: '2.0.7-beta.1', statePath: join(home, 'updates') },
      schedule(spec: DesktopShellSpec) { shell = spec; return async () => {} },
      registerTrayItem() { return { refresh() {}, dispose() {} } },
      setLocalePreference() {}, setThemeSource() {},
      async requestRestart() { restarts.push('restart') },
      async requestRecoveryRestart() { restarts.push('recovery') },
    } as unknown as DesktopRuntime
    releaseNative = bindNativeRuntime(rpc, runtime)
    rpc.handle('certificate', () => ({ failureCode: 'test-disabled' }))
    rpc.handle('quit', () => {})
    const result = await rpc.call<{ pid: number; services: { aaRuntime: boolean; aaOnboarding: boolean } }>('boot', [{
      prepared, profilePreferences: { mode: 'advanced', openBrowser: false, networkExposure: 'loopback',
        macosMaterial: 'auto', windowsMaterial: 'auto', market: 'disabled', notifications: { enabled: false }, aaEnabled },
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
      logDirectory: join(home, 'logs'),
    }, runtimeSnapshot(runtime), token])
    expect(result.pid).toBe(child.pid)
    expect(result.pid).not.toBe(process.pid)
    expect(shell).toBeDefined()
    const spec = shell!
    const headers = { [spec.rendererAccessHeader.name]: spec.rendererAccessHeader.value }
    const unauthorized = await fetch(spec.url, { headers })
    await unauthorized.body?.cancel()
    expect(unauthorized.status).toBe(401)
    const authentication = await fetch(spec.authenticationUrl, { headers, redirect: 'manual' })
    await authentication.body?.cancel()
    expect(authentication.status).toBe(303)
    const cookie = authentication.headers.get('set-cookie')!.split(';')[0]!
    const response = await fetch(spec.url, { headers: { ...headers, Cookie: cookie } })
    expect(response.status).toBe(200)
    const html = await response.text()
    const match = html.match(/(?:window\.__DSH_BOOT__|globalThis\["__DSH_BOOT__"\]) = (\{.*?\})<\/script>/u)
    expect(match).not.toBeNull()
    const graph = JSON.parse(match![1]!) as { entries: { id: string; url: string }[] }
    const pluginEntry = graph.entries.find(entry => entry.id === 'isolated-client-fixture')
    expect(pluginEntry).toBeDefined()
    const bundle = await fetch(new URL(pluginEntry!.url, spec.url), { headers: { ...headers, Cookie: cookie } })
    expect(bundle.status).toBe(200)
    expect(await bundle.text()).toContain('isolatedClientFixture')
    expect(html).toContain('dsh-plugin-desktop')
    await expect.poll(async () => (await rpc!.call<{ services: { aaRuntime: boolean; aaOnboarding: boolean } }>('status')).services, { timeout: 3000 })
      .toEqual({ aaRuntime: aaEnabled, aaOnboarding: aaEnabled })
    // A settings import is an ordinary restart; recovery is reserved for a Host that
    // failed to compose, and this one did not.
    expect(restarts).not.toContain('recovery')
    await rpc.call('stop')
    await expect(fetch(spec.url, { headers })).rejects.toThrow()
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.stack : String(error)}\n${stderr}`)
  } finally {
    await releaseNative?.()
    rpc?.close()
    if (child && child.exitCode === null) { const exit = once(child, 'exit'); child.kill(); await exit }
    pnpm?.dispose()
    rmSync(home, { recursive: true, force: true })
  }
}, 60_000)
