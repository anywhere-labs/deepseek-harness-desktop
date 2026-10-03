/** Headless smoke for the complete published DSH Web profile and renderer manifest. */

import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import {
  createLaunchEnvironmentSnapshot,
  DSH_LAUNCH_ENVIRONMENT_KEY,
} from '@deepseek-ai/dsh-launch-environment'
import { installDesktopPnpmRuntime } from '../lib/desktop-runtime-environment.js'
import { installProfilePackageResolver } from '../lib/module-resolution.js'
import { prepareDesktopProfile } from '../lib/profile.js'
import { DesktopProfileService } from '../lib/profile-service.js'
import { createDesktopProfileBoot } from '../lib/profile-context.js'

/** Loader entry id of the Desktop shell row, which 0.1.7 uses as its settings namespace. */
const DESKTOP_SETTINGS_ENTRY_ID = 'desktop-shell'
/**
 * The Desktop row as the profile's own patch layer carries it.
 *
 * 0.1.7 keeps persisted settings in that layer, so every write to the document
 * has to restate this entry: a real settings edit rewrites the document around
 * the rows it does not touch, it does not replace them.
 */
const DESKTOP_SHELL_PATCH_ENTRY = Object.freeze({
  id: DESKTOP_SETTINGS_ENTRY_ID,
  name: 'dsh-plugin-desktop',
  config: Object.freeze({ mode: 'advanced' }),
})

const BIN_NAME = 'dsh-plugin-desktop-profile-smoke'
const HOST_SERVICE_PLUGIN_NAME = 'dsh-desktop-host-services-smoke-plugin'
const HOST_SERVICE_PROBE_KEY = 'desktopHostServiceProbe'
let ordinaryBrowserEnabled = false
const BROWSER_ACCESS = Object.freeze({
  get ordinaryBrowserEnabled() { return ordinaryBrowserEnabled },
  rendererHeader: Object.freeze({
    name: 'x-dsh-desktop-renderer',
    value: Buffer.alloc(32, 2).toString('base64url'),
  }),
  setOrdinaryBrowserEnabled(enabled) { ordinaryBrowserEnabled = enabled },
})
const LAN_HTTPS_SNAPSHOT = Object.freeze({
  state: 'inactive',
  actualPort: null,
  addresses: Object.freeze([]),
  caFingerprint: null,
  errorCode: null,
})
const LAN_HTTPS = Object.freeze({
  caCertificate: null,
  attach() {},
  snapshot() { return LAN_HTTPS_SNAPSHOT },
  async setEnabled() { return LAN_HTTPS_SNAPSHOT },
  async stop() { return LAN_HTTPS_SNAPSHOT },
})
const home = mkdtempSync(join(tmpdir(), 'dsh-desktop-profile-'))
let ctx
let releasePackageResolver
let pnpmRuntime
let mountedSpec
let nativeThemeSource = 'system'
const trayItems = []

try {
  // A 0.1.6 harness home: sections keyed by the old settings namespaces, preset
  // choice under the old field name. `prepareDesktopProfile` migrates it in place
  // before the Loader starts; the settings plugin imports it once the Loader has
  // settled, which is strictly after every plugin has mounted.
  writeFileSync(join(home, 'settings.yaml'), [
    'dsh-desktop:',
    '  mode: advanced',
    'agent-presets:',
    '  default: minimal',
    '',
  ].join('\n'))
  // 0.1.7 resolves Desktop's startup mode from the composed `desktop-shell` row --
  // the bundle default under the profile's own patch layer -- not from the harness
  // home document, which by then may already be `settings.yaml.imported`. Seed the
  // patch layer the way that one-shot import leaves it, which is what every boot
  // after the upgrade reads. Without it this smoke would assert the single
  // pre-import boot, where the window necessarily still opens in compatibility.
  writeFileSync(
    prepareDesktopProfile('1', home, 'win32').profile.patchPath,
    JSON.stringify([DESKTOP_SHELL_PATCH_ENTRY]),
  )
  const aaRequested = process.env.DSH_VERIFY_AA === '1'
  const brokenAa = process.env.DSH_VERIFY_AA_BROKEN === '1'
  // A shared AA directory may already contain settings written by a newer channel.
  const aaSettings = {
    uvPath: '', uvPypiIndexUrl: '', uvPythonInstallMirror: '', syncIntervalSeconds: 37,
  }
  if (aaRequested && !brokenAa) {
    // Older releases left an installation projection above the active Profile.
    // Its lexically larger build hash must not override the current AA artifact,
    // including during rc.2's compatibility preflight before Loader starts.
    const aaPackage = '@agents-anywhere/dsh-bridge-next'
    const installedManifest = createRequire(import.meta.url).resolve(`${aaPackage}/package.json`)
    const stalePackage = join(home, 'profiles', 'node_modules', aaPackage)
    mkdirSync(stalePackage, { recursive: true })
    const staleManifest = JSON.parse(readFileSync(installedManifest, 'utf8'))
    staleManifest.version = '0.1.0-dev.0.desktop.ca022d9286dd0.rc4b2a1d2'
    staleManifest.peerDependencies['@deepseek-ai/dsh-session'] = '0.1.5-rc.2'
    writeFileSync(join(stalePackage, 'package.json'), JSON.stringify(staleManifest))
    cpSync(new URL('./cordis.patch.yml', pathToFileURL(installedManifest)), join(stalePackage, 'cordis.patch.yml'))
    mkdirSync(join(stalePackage, 'lib', 'bundled-connector'), { recursive: true })
    writeFileSync(join(stalePackage, 'lib', 'bundled-connector', 'pyproject.toml'), '')
    mkdirSync(join(home, 'aa-smoke-state'))
    writeFileSync(join(home, 'aa-smoke-state', 'connector-settings.json'), JSON.stringify(aaSettings))
  }
  if (brokenAa) {
    const initial = prepareDesktopProfile('1', home, 'win32')
    const brokenPackage = join(initial.profile.dir, 'node_modules', '@agents-anywhere', 'dsh-bridge-next')
    mkdirSync(brokenPackage, { recursive: true })
    writeFileSync(join(brokenPackage, 'package.json'), JSON.stringify({
      name: '@agents-anywhere/dsh-bridge-next', version: '99.0.0',
      dsh: { bundle: { patch: './missing.patch.yml' } },
    }))
  }
  const prepared = prepareDesktopProfile('1', home, 'win32', undefined, undefined, undefined, { aaEnabled: aaRequested })
  if (brokenAa && (!prepared.aaFailure || prepared.aaEnabled)) throw new Error('Broken AA bundle did not fail closed')
  const hostServicePluginDir = join(
    prepared.profile.dir,
    'node_modules',
    HOST_SERVICE_PLUGIN_NAME,
  )
  mkdirSync(join(prepared.profile.dir, 'node_modules'), { recursive: true })
  cpSync(
    fileURLToPath(new URL('../tests/fixtures/desktop-host-services-smoke-plugin/', import.meta.url)),
    hostServicePluginDir,
    { recursive: true, force: false, errorOnExist: true },
  )
  prepared.overlays = [
    { insert: [{ id: 'desktop-host-services-smoke-plugin', name: HOST_SERVICE_PLUGIN_NAME }] },
    // The smoke's explicit Profile home must also own account credentials.
    { id: 'credentials', config: { dshHome: home } },
    // Isolate the bridge from the operator's real AA account on every reload.
    ...(prepared.aaEnabled ? [{ id: 'agents-anywhere-bridge-next', config: {
      dshHome: home, stateRoot: join(home, 'aa-smoke-state'), uvPath: 'uv',
    } }] : []),
  ]
  const patches = [...prepared.patches, ...prepared.overlays]
  const packageRoot = new URL('../', import.meta.url)
  const pnpmBinPath = fileURLToPath(new URL('node_modules/pnpm/bin/pnpm.mjs', packageRoot))
  const electronVersion = JSON.parse(
    readFileSync(new URL('node_modules/electron/package.json', packageRoot), 'utf8'),
  ).version
  pnpmRuntime = installDesktopPnpmRuntime({
    platform: process.platform,
    appExecutable: process.execPath,
    pnpmBinPath,
    electronVersion,
    stateDir: join(home, 'runtime-commands'),
    environment: process.env,
  })
  releasePackageResolver = installProfilePackageResolver(prepared.bareModuleBaseUrl)
  const runtime = {
    platform: 'win32',
    locale: 'en',
    updates: {
      isPackaged: false,
      canDownload: true,
      currentVersion: '2.0.0',
      statePath: join(home, 'update-state.json'),
      request: async () => { throw new Error('profile smoke must not perform update requests') },
      confirmDownload: async () => false,
      showManualCheckResult: async () => {},
      downloadAndOpen: async () => {},
      notify: () => {},
    },
    schedule(spec) {
      mountedSpec = spec
      return async () => {}
    },
    async mountScheduled() {
      if (mountedSpec === undefined) throw new Error('desktop shell was not registered')
      runtime.setLocalePreference(mountedSpec.readLocalePreference())
      nativeThemeSource = mountedSpec.readThemeSource()
    },
    show() {},
    registerTrayItem(item) {
      trayItems.push(item)
      return {
        refresh() {},
        dispose() {
          const index = trayItems.indexOf(item)
          if (index >= 0) trayItems.splice(index, 1)
        },
      }
    },
    openTerminal() {},
    setLocalePreference(preference) { runtime.locale = preference ?? 'en' },
    setThemeSource(source) { nativeThemeSource = source },
    async requestRestart() {},
    prepareToQuit() {},
  }
  const pnpmBootstrap = {
    activeProfileName: 'desktop',
    activeProfileDir: prepared.profile.dir,
    homeDir: prepared.homeDir,
    appExecutable: process.execPath,
    pnpmBinPath,
    electronVersion,
    nodeBinDir: pnpmRuntime.nodeBinDir,
    nodeShimPath: pnpmRuntime.nodeShimPath,
    clearEnvironmentPath: pnpmRuntime.clearEnvironmentPath,
    dshBootstrapPath: fileURLToPath(new URL('../lib/desktop-cli.js', import.meta.url)),
  }
  const profileBoot = createDesktopProfileBoot(prepared, pnpmBootstrap)
  ctx = await boot(
    BIN_NAME,
    prepared.rootConfig,
    patches,
    async (host) => {
      profileBoot.prepare(host)
      // Match the public resolver path used by packaged Electron.
      host.loader.internal = undefined
      host.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([]))
      host.provide('desktopBrowserAccess', BROWSER_ACCESS)
      host.provide('desktopLanHttps', LAN_HTTPS)
      host.provide('desktopRuntime', runtime)
      host.provide('desktopPnpmBootstrap', pnpmBootstrap)
      await host.plugin(DesktopProfileService, {
        current: {
          name: 'desktop',
          dir: prepared.profile.dir,
        },
        list: () => [{
          name: 'desktop',
          dir: prepared.profile.dir,
          exists: true,
          bundles: prepared.profile.layers.map(layer => layer.packageName),
          webCapable: true,
        }],
        persistSelection: () => {},
        requestRestart: () => {},
      })
      provideCmdline(host, {
        args: ['--host', '127.0.0.1', '--port', '0'],
        exit: () => {},
      })
    },
    prepared.bareModuleBaseUrl,
  )
  profileBoot.markReady()
  await runtime.mountScheduled()

  if (ctx.get('desktopPnpm') === undefined) {
    throw new Error('assembled desktop profile is missing the desktop pnpm Host capability')
  }
  if (ctx.desktopProfiles.current.name !== 'desktop'
    || ctx.desktopProfiles.current.dir !== prepared.profile.dir) {
    throw new Error('assembled desktop profile service has the wrong active identity')
  }
  const agentPresets = ctx.get('agentPresets')
  if (agentPresets === undefined) {
    throw new Error('assembled Windows profile is missing the agent preset roster')
  }
  const presetIds = (await agentPresets.list()).map(preset => preset.id)
  if (!presetIds.includes('minimal') || !presetIds.includes('standard')) {
    throw new Error(`assembled Windows profile exposes unexpected presets: ${presetIds.join(', ')}`)
  }
  // The legacy import runs off `loader.await()`, so the preset choice lands after
  // this profile has finished mounting. Waiting for it here is what proves the
  // section and field renames reached a namespace the settings service accepts.
  const importDeadline = Date.now() + 15_000
  while (agentPresets.defaultId !== 'minimal' && Date.now() < importDeadline) await delay(50)
  if (agentPresets.defaultId !== 'minimal') {
    throw new Error(`assembled Windows profile selected unexpected default ${agentPresets.defaultId}`)
  }
  const minimalPreset = await agentPresets.resolve('minimal')
  if (minimalPreset.id !== 'minimal') {
    throw new Error(`assembled Windows profile remapped minimal preset to ${minimalPreset.id}`)
  }
  if (ctx.get('pluginManager') === undefined) {
    throw new Error('Desktop Profile did not activate the official plugin manager')
  }
  // Resolve AND mount Creator: discovery alone cannot catch missing Host services.
  // 0.1.7 replaced `standingKeyFor` with `acquireScope`, a disposable revision
  // lease: the composition is mounted at registration and the lease still throws
  // `agent-preset/invalid` when that mount is unusable, which is what we assert.
  await (await agentPresets.acquireScope('cordis'))[Symbol.asyncDispose]()
  if ((await ctx.get('pluginManager').listPlugins()).length === 0) {
    throw new Error('Official plugin manager cannot inspect the Desktop composition')
  }
  // Exercise the actual Profile watcher twice, rather than invoking our reader
  // directly. Both generations must preserve the Desktop layers and fixture.
  const reloadProbePath = join(home, 'reload-probe.mjs')
  writeFileSync(reloadProbePath, "export function apply(ctx, config) { ctx.provide('desktopReloadProbe', config.value) }\n")
  for (const value of [1, 2]) {
    writeFileSync(prepared.profile.patchPath, JSON.stringify([DESKTOP_SHELL_PATCH_ENTRY, { insert: [{
      id: 'desktop-reload-probe', name: pathToFileURL(reloadProbePath).href, config: { value },
    }] }]))
    const deadline = Date.now() + 15_000
    while (ctx.get('desktopReloadProbe') !== value && Date.now() < deadline) await delay(50)
    if (ctx.get('desktopReloadProbe') !== value) {
      throw new Error(`Profile HMR failed to activate generation ${value}`)
    }
  }
  if (ctx.get('desktopRuntime') !== runtime || ctx.get('pluginManager') === undefined) {
    throw new Error('Profile reload lost Desktop or plugin-manager services')
  }
  await (await ctx.agentPresets.acquireScope('cordis'))[Symbol.asyncDispose]()
  const hostServiceProbe = ctx.get(HOST_SERVICE_PROBE_KEY)
  if (hostServiceProbe?.current?.name !== 'desktop'
    || hostServiceProbe.current.dir !== prepared.profile.dir
    || hostServiceProbe.pnpm?.serviceName !== 'desktopPnpm'
    || hostServiceProbe.pnpm.lookupRun !== 'function'
    || hostServiceProbe.pnpm.run !== 'function') {
    throw new Error(
      `profile-local Host service plugin produced an unexpected probe: ${JSON.stringify(hostServiceProbe)}`,
    )
  }

  const picker = ctx.directoryPicker.capability()
  if (picker.kind !== 'browse') {
    throw new Error(`assembled Windows profile selected ${picker.kind} directory picker`)
  }
  const listing = await picker.list(home)
  if (listing.path !== home) {
    throw new Error(`assembled Windows browse picker listed ${listing.path} instead of ${home}`)
  }

  const expectedUrl = `http://127.0.0.1:${String(ctx.webServer.port)}/?dsh-desktop-mode=advanced&dsh-desktop-platform=win32&dsh-desktop-version=2.0.0&dsh-desktop-material=off`
  if (mountedSpec?.url !== expectedUrl) {
    throw new Error(`desktop plugin produced an unexpected renderer URL: ${String(mountedSpec?.url)}`)
  }
  if (mountedSpec?.mode !== 'advanced') {
    throw new Error(`desktop plugin produced an unexpected shell mode: ${String(mountedSpec?.mode)}`)
  }
  if (mountedSpec?.rendererAccessHeader !== BROWSER_ACCESS.rendererHeader) {
    throw new Error('assembled profile did not preserve the launcher browser capability')
  }
  if (nativeThemeSource !== 'system') {
    throw new Error(`desktop plugin produced an unexpected native theme source: ${nativeThemeSource}`)
  }
  // 0.1.7 keys live configuration by Loader entry id and serves it from the
  // describe face; `settings.get(namespace)` was the 0.1.5 surface.
  const desktopSettings = ctx.settings.describe()
    .find(entry => String(entry.ns) === DESKTOP_SETTINGS_ENTRY_ID)?.value
  if (desktopSettings?.mode !== 'advanced') {
    throw new Error('assembled Host settings are missing the advanced desktop-shell mode')
  }
  if (!trayItems.some(item => item.label() === 'Check for Updates…')) {
    throw new Error('assembled desktop profile is missing the update tray command')
  }
  if (process.platform !== 'linux'
    && !trayItems.some(item => item.label() === 'Open DSH Terminal')) {
    throw new Error('assembled desktop profile is missing the terminal tray command')
  }
  const profileMenu = trayItems.find(item => item.label() === 'Profile: desktop')
  if (profileMenu?.submenu?.()[0]?.label() !== 'desktop') {
    throw new Error('assembled desktop profile is missing the active profile tray submenu')
  }
  const unauthenticated = await fetch(expectedUrl, {
    headers: {
      [BROWSER_ACCESS.rendererHeader.name]: BROWSER_ACCESS.rendererHeader.value,
    },
  })
  await unauthenticated.body?.cancel()
  if (unauthenticated.status !== 401) {
    throw new Error(
      `assembled Web root accepted a renderer without browser authentication: HTTP ${String(unauthenticated.status)}`,
    )
  }
  if (typeof mountedSpec?.authenticationUrl !== 'string') {
    throw new Error('desktop plugin did not provide an authentication URL')
  }
  const authenticationUrl = new URL(mountedSpec.authenticationUrl)
  const rendererUrl = new URL(expectedUrl)
  const authenticationTokens = authenticationUrl.searchParams.getAll('token')
  if (authenticationUrl.origin !== rendererUrl.origin
    || authenticationUrl.pathname !== '/'
    || authenticationUrl.hash !== ''
    || [...authenticationUrl.searchParams.keys()].some(key => key !== 'token')
    || authenticationTokens.length !== 1
    || !/^[A-Za-z0-9_-]{43}$/u.test(authenticationTokens[0])) {
    throw new Error(`desktop plugin produced an invalid authentication URL: ${authenticationUrl.href}`)
  }
  const exchange = await fetch(authenticationUrl, {
    headers: {
      [BROWSER_ACCESS.rendererHeader.name]: BROWSER_ACCESS.rendererHeader.value,
    },
    redirect: 'manual',
  })
  await exchange.body?.cancel()
  // 0.1.7 redirects document-relative (`./`, `dsh-client-connection/lib/index.js:405`)
  // rather than to the site root, so the exchange survives a mounted base path.
  if (exchange.status !== 303 || exchange.headers.get('location') !== './') {
    throw new Error(
      `browser authentication exchange returned HTTP ${String(exchange.status)} instead of a document-relative redirect`,
    )
  }
  const setCookie = exchange.headers.get('set-cookie')
  const cookie = setCookie?.split(';', 1)[0]
  if (cookie === undefined || cookie.length === 0) {
    throw new Error('browser authentication exchange did not mint a cookie')
  }
  const response = await fetch(expectedUrl, {
    headers: {
      [BROWSER_ACCESS.rendererHeader.name]: BROWSER_ACCESS.rendererHeader.value,
      Cookie: cookie,
    },
  })
  const html = await response.text()
  if (process.argv.includes('--onboarding')) {
    const { verifyDesktopOnboardingBrowser } = await import('../../scripts/verify-desktop-onboarding-browser.mjs')
    await verifyDesktopOnboardingBrowser({
      url: expectedUrl, cookie,
      headers: { [BROWSER_ACCESS.rendererHeader.name]: BROWSER_ACCESS.rendererHeader.value },
    })
  }
  if (response.status !== 200) {
    throw new Error(`assembled Web root returned HTTP ${String(response.status)}`)
  }
  const bootMatch = html.match(/(?:window\.__DSH_BOOT__|globalThis\["__DSH_BOOT__"\]) = (\{.*?\})<\/script>/u)
  if (bootMatch?.[1] === undefined) {
    throw new Error('assembled Web root is missing window.__DSH_BOOT__')
  }
  const graph = JSON.parse(bootMatch[1])
  const ids = new Set(graph.entries.map(entry => entry.id))
  const aaEnabled = aaRequested && !brokenAa
  if (ids.has('@agents-anywhere/dsh-bridge-next') !== aaEnabled) throw new Error('AA client graph does not match explicit selection')
  if (aaEnabled && (!ctx.get('agentsAnywhereRuntime') || !ctx.get('agentsAnywhereOnboarding'))) {
    throw new Error('AA Host services did not activate in the actual Desktop profile')
  }
  if (aaEnabled) {
    const endpoint = join(home, 'agents-anywhere', 'bridge', 'endpoint.json')
    if (!existsSync(endpoint)) throw new Error('AA did not publish its native DSH home endpoint')
    const snapshot = await ctx.get('agentsAnywhereOnboarding').inspect()
    if (snapshot.account) throw new Error('A fresh Profile inherited an AA account')
    for (const [key, value] of Object.entries(aaSettings)) {
      if (snapshot.connector.settings[key] !== value) {
        throw new Error(`AA did not preserve the shared connector setting ${key}`)
      }
    }
    const uvSuffix = join('node_modules', '@dataiku', `uv-${process.platform}-${process.arch}`, 'bin', process.platform === 'win32' ? 'uv.exe' : 'uv')
    if (!snapshot.connector.resolvedUvPath?.endsWith(uvSuffix)) {
      throw new Error('AA must resolve bundled uv instead of falling back to the operator PATH')
    }
    const uvVersion = execFileSync(snapshot.connector.resolvedUvPath, ['--version'], { encoding: 'utf8', timeout: 10_000 })
    if (!/^uv \d+\./u.test(uvVersion)) throw new Error('Bundled AA uv did not return a version')
  }
  for (const id of [
    'dsh-plugin-desktop',
    '@deepseek-ai/dsh-client-file-upload',
    '@deepseek-ai/dsh-client-shortcuts',
    '@deepseek-ai/dsh-client-ui-shortcuts',
    '@deepseek-ai/dsh-client-ui-conversation',
    '@deepseek-ai/dsh-client-ui-sidebar',
    '@deepseek-ai/dsh-client-ui-directory-picker-browse',
  ]) {
    if (!ids.has(id)) {
      throw new Error(
        `assembled advanced Web graph is missing ${id}; received ${[...ids].sort().join(', ')}`,
      )
    }
  }
  for (const id of [
    '@deepseek-ai/dsh-client-ui-layout',
    '@deepseek-ai/dsh-client-ui-directory-picker-native',
  ]) {
    if (ids.has(id)) throw new Error(`assembled advanced Web graph unexpectedly includes ${id}`)
  }
  process.stdout.write('verify-profile-boot: Creator, plugin manager and two Profile HMR generations passed\n')
} finally {
  await ctx?.fiber.dispose()
  releasePackageResolver?.()
  pnpmRuntime?.dispose()
  rmSync(home, { recursive: true, force: true })
}
