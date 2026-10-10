/** Headless owner of the Host, desktop preferences, Profiles and recovery. */
import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { cleanupDisposableTree } from '../../dsh-plugin-desktop-beta/src/disposable-tree.ts'
import { join } from 'node:path'
import { DesktopBackendController } from './backend-controller.ts'
import { DesktopHostFatalError, DesktopHostProcess, type DesktopPlatformLoginRequest } from './host-process.ts'
import { DesktopPreferenceStore, parsePreferences } from './desktop-preferences.ts'
import { DEFAULT_FEATURES, NextProfiles } from './profiles.ts'
import { DEFAULT_PREFERENCES, DEFAULT_PROFILE, SAFE_MODE_PREFERENCES, type DesktopBrowserLinks, type DesktopPreferences, type DesktopState, type DesktopNotification } from './desktop-contract.ts'
import { DesktopDiagnostics } from './diagnostics.ts'
import { NextRecovery } from './recovery.ts'
import { maskSecrets } from './mask-secrets.ts'
import { privateDirectory } from './private-files.ts'
import { authenticateWebHost } from './web-document.ts'
import { DesktopLanHttpsRuntime } from './lan-https-runtime.ts'
import type { DesktopLanHttpsCertificate } from './lan-https-certificate.ts'
import type { DesktopPermission, DesktopPermissionAction, DesktopPermissionSnapshot } from './permissions.ts'
import { SYSTEM_PROXY_ENV, type DesktopSystemProxyProbe } from './system-proxy.ts'

interface RuntimeOptions {
  home: string
  /** Disposable desktop settings; recovery continues to address the original home. */
  stateHome?: string
  root: string
  executable: string
  addresses(): string[]
  /** The system proxy main probed at startup; the Host decides whether it applies. */
  systemProxy?(): DesktopSystemProxyProbe
  certificate(addresses: readonly string[]): Promise<DesktopLanHttpsCertificate>
  onFailure(): void
  onChange(): void
  onRestart(): void
  onTerminal(): void
  onNotification(notification: DesktopNotification): void
  onPermission?(action: DesktopPermissionAction, permission: DesktopPermission): Promise<DesktopPermissionSnapshot>
  onPlatformLogin?(request: DesktopPlatformLoginRequest): void
}

export class NextDesktopRuntime {
  readonly profiles: NextProfiles
  readonly recovery: NextRecovery
  readonly settings: DesktopPreferenceStore
  readonly diagnostics: DesktopDiagnostics
  readonly backend: DesktopBackendController<{ start(): Promise<void>; stop(): Promise<void> }>
  preferences: DesktopPreferences = { ...DEFAULT_PREFERENCES }
  selected: string = DEFAULT_PROFILE
  safeMode = false
  recoveryMode = false
  busy = false
  closing = false
  failure = ''
  startup: Promise<void> = Promise.resolve()
  /** Main-process transport only; never copied into a DesktopState. */
  auth: { url: string; cookie: string; token: string; injections: readonly unknown[] } | undefined
  lan: DesktopLanHttpsRuntime | undefined
  private safeHome: string | undefined
  private hostProcess: DesktopHostProcess | undefined

  constructor(readonly options: RuntimeOptions) {
    this.profiles = new NextProfiles(options.home)
    this.recovery = new NextRecovery(this.profiles)
    this.settings = new DesktopPreferenceStore(options.stateHome ?? options.home)
    this.diagnostics = new DesktopDiagnostics(options.home)
    this.backend = new DesktopBackendController(onFailure => this.createHost(onFailure), state => {
      this.diagnostics.record({ source: 'desktop.backend', event: 'phase', fields: { phase: state.phase } })
      if (state.phase === 'error' && !this.closing) {
        this.report(state.failure ?? state.message)
        // The Host now ships its complete inspected error with `fatal`. Recovery
        // shows only the message; the stack, properties and cause chain go to the
        // diagnostics log so a startup failure stays diagnosable after the fact.
        const failure = state.failure
        if (failure instanceof DesktopHostFatalError && failure.diagnostic !== undefined) {
          this.diagnostics.append(maskSecrets(failure.diagnostic), 'error')
        }
      }
      this.options.onChange()
    })
  }

  initialize(): void {
    try { this.selected = this.profiles.active } catch (error) {
      if (this.safeMode) this.diagnostics.append(`Original Profile selection is unavailable: ${String(error)}`, 'warn')
      else this.report(error)
    }
    if (this.safeMode) this.preferences = { ...SAFE_MODE_PREFERENCES }
    else try { this.preferences = this.settings.read() } catch (error) { this.report(error) }
    this.diagnostics.level = this.preferences.logLevel
    this.diagnostics.developer = this.preferences.developerLogging
  }

  report(error: unknown): void {
    if (this.closing) return
    this.failure = maskSecrets(error instanceof Error ? error.message : String(error))
    this.diagnostics.record({ source: 'desktop', event: 'runtime.failed', level: 'error', error })
    this.options.onFailure()
    this.options.onChange()
  }

  start(): Promise<void> {
    this.recoveryMode = false
    this.failure = ''
    this.startup = this.backend.start(async () => {
      if (this.safeMode && !this.safeHome) {
        privateDirectory(this.recovery.directory)
        this.safeHome = mkdtempSync(join(this.recovery.directory, 'safe-runtime-'))
        const safe = new NextProfiles(this.safeHome)
        safe.ensure(DEFAULT_PROFILE)
        safe.setFeatures(DEFAULT_PROFILE, { remoteControl: false, market: false })
      }
      if (this.safeMode) this.preferences = { ...SAFE_MODE_PREFERENCES }
      if (!this.safeMode) this.profiles.ensure(this.selected)
    })
    // The backend publishes failures after owned process cleanup.
    void this.startup.catch(() => {})
    return this.startup
  }

  async restart(change: () => void | Promise<void> = () => {}): Promise<void> {
    await this.backend.stop()
    if (this.closing) return
    const wasSafe = this.safeMode
    await change()
    if (!this.safeMode) {
      this.cleanupSafeHome()
      if (wasSafe) this.preferences = new DesktopPreferenceStore(this.options.home).read()
    }
    await this.start()
  }

  /** Native repair tools target the original Profile; app tools follow the running environment. */
  terminalTarget(repair = false): { homeDir: string; profileDir: string; profileName: string; mode: 'normal' | 'safe' | 'recovery' } {
    if (this.closing) throw new Error('Next is shutting down')
    const safe = this.safeMode && !repair
    if (safe && !this.safeHome) throw new Error('Safe mode environment is not ready')
    const homeDir = safe ? this.safeHome! : this.options.home
    const profileName = safe ? DEFAULT_PROFILE : this.selected
    return { homeDir, profileName, profileDir: new NextProfiles(homeDir).directory(profileName),
      mode: safe ? 'safe' : repair || this.recoveryMode ? 'recovery' : 'normal' }
  }

  writePreferences(value: unknown): void {
    if (this.safeMode) throw new Error('Desktop preferences are fixed in Safe Mode')
    this.preferences = this.settings.write(parsePreferences(value))
    this.diagnostics.level = this.preferences.logLevel
    this.diagnostics.developer = this.preferences.developerLogging
    this.options.onChange()
  }

  /**
   * Boot rows for a document that is loading now.
   * @returns The Host's current Web boot table, or the table captured at startup when the running
   * Host cannot answer. dsh 0.1.7 addresses boot bundles by revision and republishes the table
   * whenever a plugin registers, so replaying the startup table breaks every reload that follows
   * a plugin installation.
   */
  async injections(): Promise<readonly unknown[]> {
    const auth = this.auth
    if (!auth) throw new Error('Next Host is unavailable')
    try { return await (this.hostProcess?.collectInjections() ?? Promise.resolve(auth.injections)) }
    catch (error) {
      this.diagnostics.append(`Web boot injections: ${String(error)}`, 'warn')
      return auth.injections
    }
  }

  /** Apply access toggles without stopping conversations or changing the renderer capability. */
  async applyPreferences(value: unknown): Promise<void> {
    const next = parsePreferences(value)
    // A Host already being spawned has captured its boot policy. Apply after
    // readiness instead of only saving a value that the running Host never sees.
    if (this.backend.state.phase === 'starting' && !this.recoveryMode && !this.safeMode) await this.startup.catch(() => {})
    if (this.closing) throw new Error('Next is shutting down')
    const previous = this.preferences
    const host = this.hostProcess
    const lan = this.lan
    if (!host || !lan || !this.auth || this.safeMode || this.backend.state.phase !== 'ready') {
      this.writePreferences(next); return
    }
    const loggingChanged = next.developerLogging !== previous.developerLogging || next.logLevel !== previous.logLevel
    const changed = next.browserAccess !== previous.browserAccess || next.networkExposure !== previous.networkExposure
    try {
      if (loggingChanged) await host.setLogging(next)
      if (!changed) { this.writePreferences(next); return }
      await host.setBrowserAccess(next.browserAccess)
      const edge = await lan.setEnabled(next.browserAccess && next.networkExposure === 'lan')
      if (this.closing) throw new Error('Next is shutting down')
      this.writePreferences(next)
      if (edge.state === 'failed') this.diagnostics.append(`LAN HTTPS: ${edge.errorCode}`, 'warn')
    } catch (error) {
      if (!this.closing) {
        try {
          if (loggingChanged) await host.setLogging(previous)
          await host.setBrowserAccess(previous.browserAccess)
          await lan.setEnabled(previous.browserAccess && previous.networkExposure === 'lan')
        } catch {
          // An unacknowledged access policy must never remain publicly reachable.
          await this.backend.stop()
        }
      }
      throw error
    }
  }

  state(): Pick<DesktopState, 'selected' | 'profiles' | 'unavailableProfiles' | 'features' | 'preferences' | 'phase' | 'busy' | 'failure' | 'safeMode' | 'home' | 'browserUrl' | 'lan' | 'checkpoint' | 'logs'> {
    let features = { ...DEFAULT_FEATURES }
    let profiles: string[] = []
    let checkpoint: DesktopState['checkpoint'] = null
    let failure = this.failure
    try { profiles = this.profiles.list() } catch (error) { failure ||= maskSecrets(String(error)) }
    if (!this.safeMode) try { features = this.profiles.features(this.selected) } catch (error) { failure ||= maskSecrets(String(error)) }
    try { const saved = this.recovery.latest(this.selected); if (saved) checkpoint = { created: saved.created } } catch { /* Recovery remains usable without backups. */ }
    return { selected: this.selected, profiles, unavailableProfiles: profiles.filter(name => !this.profiles.selectable(name)), features, preferences: { ...this.preferences }, phase: this.recoveryMode ? 'recovery' : !this.auth && failure ? 'error' : this.backend.state.phase,
      busy: this.busy, failure, safeMode: this.safeMode, home: this.options.home,
      browserUrl: this.auth && this.preferences.browserAccess && !this.safeMode ? new URL(this.auth.url).origin : null,
      lan: this.lan?.snapshot() ?? null, checkpoint, logs: this.diagnostics.snapshot() }
  }

  browserLinks(): DesktopBrowserLinks {
    if (!this.auth || this.closing || this.recoveryMode || this.backend.state.phase !== 'ready' || !this.preferences.browserAccess || this.safeMode) return { localUrl: null, lanUrls: [] }
    const localUrl = new URL(this.auth.url).href
    const edge = this.lan?.snapshot()
    const lanUrls = this.preferences.networkExposure === 'lan' && edge?.state === 'ready' && edge.actualPort
      ? edge.addresses.map(address => {
        const url = new URL(localUrl)
        url.protocol = 'https:'; url.hostname = address; url.port = String(edge.actualPort)
        return url.href
      }) : []
    return { localUrl, lanUrls }
  }

  browserLink(lan = false): string {
    const links = this.browserLinks()
    const url = lan ? links.lanUrls[0] : links.localUrl
    if (!url) throw new Error(lan ? 'LAN HTTPS is unavailable' : 'Browser access is unavailable')
    return url
  }

  resolveBrowserLink(value: unknown): string {
    const links = this.browserLinks()
    if (typeof value !== 'string' || !value || (value !== links.localUrl && !links.lanUrls.includes(value))) throw new Error('Browser address is unavailable')
    return value
  }

  async close(): Promise<void> {
    this.closing = true
    const end = this.diagnostics.operation('desktop', 'backend.close')
    try { await this.backend.close(); end() } catch (error) { end(error); throw error }
    this.cleanupSafeHome()
    this.diagnostics.flush()
  }

  private cleanupSafeHome(): void {
    const home = this.safeHome
    if (!home) return
    this.safeHome = undefined
    try {
      // Share Stable/Beta's explicit junction unlinking and bounded retries.
      cleanupDisposableTree(home)
    } catch (error) {
      // Temporary files must not prevent relaunch or returning to the original Profile.
      this.diagnostics.append(`Safe mode temporary directory cleanup failed (${home}): ${String(error)}`, 'warn')
    }
  }

  private createHost(onFailure: (error: Error) => void) {
    const { options } = this
    const actualHome = this.safeMode ? this.safeHome! : options.home
    const profile = this.safeMode ? DEFAULT_PROFILE : this.selected
    const effective = this.safeMode ? { ...SAFE_MODE_PREFERENCES } : this.preferences
    const addresses = options.addresses()
    const token = randomBytes(32).toString('base64url')
    const lan = new DesktopLanHttpsRuntime({ addresses, requestedPort: effective.lanPort,
      prepareCertificate: async () => ({ certificate: await options.certificate(addresses) }) })
    this.lan = lan
    let stopped = false
    const host = new DesktopHostProcess(options.executable, options.root, new NextProfiles(actualHome).directory(profile), undefined,
      { ...process.env, DSH_HOME: actualHome, DSH_NEXT_NATIVE_TOKEN: token,
        DSH_NEXT_PREFERENCES: JSON.stringify(effective), DSH_NEXT_TRUSTED_HOSTS: JSON.stringify(addresses),
        [SYSTEM_PROXY_ENV]: JSON.stringify(options.systemProxy?.() ?? {}),
        ...(this.safeMode ? { DSH_TELEMETRY_DISABLED: '1' } : {}) },
      onFailure, undefined, undefined, join(options.root, 'lib', 'host.js'), options.onRestart, options.onNotification,
      (chunk, stream, pid) => this.diagnostics.hostChunk(chunk, stream, pid), options.onTerminal, options.onPermission, undefined, options.onPlatformLogin,
      input => { if (input.event === 'exit') this.diagnostics.hostClosed(input.pid); this.diagnostics.record(input) })
    this.hostProcess = host
    return {
      start: async (): Promise<void> => {
        let timer: ReturnType<typeof setTimeout> | undefined
        const started = this.diagnostics.operation('desktop', 'host.start', { profile, safeMode: this.safeMode })
        try {
          const ready = await Promise.race([host.start(), new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('Host startup exceeded 60 seconds')), 60_000)
            timer.unref()
          })]).finally(() => clearTimeout(timer))
          const url = new URL(ready.url)
          if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('Next Host must use loopback HTTP')
          if (!ready.injections) throw new Error('Next Host omitted Web boot injections')
          const cookie = await authenticateWebHost(ready.url, token)
          if (stopped) { started(); return }
          this.auth = { url: ready.url, cookie, token, injections: ready.injections }
          lan.attach(Number(url.port))
          if (effective.browserAccess && effective.networkExposure === 'lan') {
            const edge = await lan.setEnabled(true)
            if (stopped) { await lan.stop(); started(); return }
            // The optional LAN edge must not turn a ready loopback Host into recovery mode.
            if (edge.state === 'failed') this.diagnostics.append(`LAN HTTPS: ${edge.errorCode}`, 'warn')
          }
          if (!this.safeMode) {
            try { this.recovery.checkpoint(this.selected) } catch (error) { this.diagnostics.append(`Recovery checkpoint: ${String(error)}`, 'warn') }
          }
          started()
          this.diagnostics.append(`Host ready: ${profile}${this.safeMode ? ' (safe mode)' : ''}`)
        } catch (error) { started(error); throw error }
      },
      stop: async (): Promise<void> => {
        stopped = true
        this.auth = undefined
        const edgeStopped = this.diagnostics.operation('desktop', 'lan.stop')
        try { await lan.stop(); edgeStopped() } catch (error) { edgeStopped(error); throw error }
        const hostStopped = this.diagnostics.operation('desktop', 'host.stop')
        try { await host.stop(); hostStopped() } catch (error) { hostStopped(error); throw error }
        if (this.hostProcess === host) this.hostProcess = undefined
        if (this.lan === lan) this.lan = undefined
      },
    }
  }
}
