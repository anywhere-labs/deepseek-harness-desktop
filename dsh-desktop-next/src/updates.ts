/** Main-process update ownership survives a stopped or broken Profile Host. */
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { checkForDesktopUpdate, type UpdateCheckResult, type UpdateRequest } from '../../dsh-plugin-desktop-beta/src/update-checker.ts'
import { desktopUpdateFilename, downloadDesktopUpdate, type UpdateArtifactRequest } from '../../dsh-plugin-desktop-beta/src/update-download.ts'
import { getOrCreateDesktopInstallationId } from '../../dsh-plugin-desktop-beta/src/desktop-installation-id.ts'
import { privateDirectory } from './private-files.ts'
import type { NextUpdateState } from './update-state.ts'

export interface NextUpdateOptions {
  version: string
  platform: string
  packaged: boolean
  userData: string
  /** Fetch adapter for the version check. */
  request: UpdateRequest
  /** Installer transport; it owns redirect following and its per-hop HTTPS check. */
  artifactRequest: UpdateArtifactRequest
  changed(): void
  log(error: unknown): void
  prepare(path: string, version: string, directory: string, signal: AbortSignal): Promise<void>
  install(): Promise<void>
}

export class NextUpdates {
  private state: NextUpdateState
  private result?: UpdateCheckResult
  private operation?: Promise<void>
  private controller?: AbortController
  private timer?: ReturnType<typeof setTimeout>
  private directory?: string
  private cacheReady?: Promise<void>
  private disposed = false
  constructor(private readonly options: NextUpdateOptions) {
    this.state = { phase: 'idle', installable: options.packaged && ['darwin', 'win32'].includes(options.platform) }
  }
  snapshot(): NextUpdateState { return { ...this.state } }
  private initializeCache(): Promise<void> {
    return this.cacheReady ??= (async () => {
      const cache = join(this.options.userData, 'next-updates')
      privateDirectory(cache)
      // One primary process owns this userData tree. Clean our previous process's
      // completed installers/partial files; never delete arbitrary files in userData.
      for (const entry of await readdir(cache, { withFileTypes: true })) {
        if (entry.isDirectory() && /^download-[A-Za-z0-9]+$/.test(entry.name)) {
          await rm(join(cache, entry.name), { recursive: true, force: true }).catch(this.options.log)
        }
      }
    })()
  }
  private set(patch: Partial<NextUpdateState>): void {
    if (this.disposed) return
    this.state = { ...this.state, error: undefined, ...patch }
    this.options.changed()
  }
  start(): void {
    if (!this.options.packaged || this.timer || this.disposed) return
    void this.initializeCache().catch(this.options.log)
    const poll = (): void => {
      if (this.disposed) return
      if (['idle', 'current', 'error'].includes(this.state.phase)) void this.check()
      this.timer = setTimeout(poll, 6 * 60 * 60_000); this.timer.unref()
    }
    this.timer = setTimeout(poll, 30_000); this.timer.unref()
  }
  private run(task: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.operation) return this.operation
    this.controller = new AbortController()
    const signal = this.controller.signal
    this.operation = (async () => {
      try { await this.initializeCache(); signal.throwIfAborted(); await task(signal) }
      catch (error) { if (!signal.aborted) { this.options.log(error); this.set({ phase: 'error', error: 'download' }) } }
    })().finally(() => { this.operation = undefined; this.controller = undefined })
    return this.operation
  }
  private async query(signal: AbortSignal): Promise<UpdateCheckResult | null> {
    let installationId
    if (this.options.packaged) {
      try { installationId = await getOrCreateDesktopInstallationId(this.options.userData) } catch (error) { this.options.log(error) }
    }
    return checkForDesktopUpdate({ currentVersion: this.options.version, channel: 'next', installationId,
      request: this.options.request, signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) })
  }
  check(): Promise<void> {
    if (this.state.phase === 'ready' || this.state.phase === 'installing') return Promise.resolve()
    return this.run(async signal => {
      this.set({ phase: 'checking' })
      try {
        this.result = await this.query(signal) ?? undefined
        if (!this.result) { this.set({ phase: 'error', error: 'service', version: undefined }); return }
        this.set({ phase: this.result.status === 'update-available' ? 'available' : 'current', version: this.result.latestVersion })
      } catch (error) { this.options.log(error); this.set({ phase: 'error', error: 'service' }) }
    })
  }
  download(): Promise<void> {
    if (!this.state.installable) {
      this.set({ phase: 'error', error: this.options.packaged ? 'unsupported' : 'development' }); return Promise.resolve()
    }
    if (this.state.phase === 'ready' || this.state.phase === 'installing') return Promise.resolve()
    return this.run(async signal => {
      let preparing = false
      try {
        // Recheck before a counted download; the service also pins targetVersion across races.
        this.set({ phase: 'checking' })
        const result = await this.query(signal)
        if (!result) { this.set({ phase: 'error', error: 'service' }); return }
        this.result = result
        if (result.status !== 'update-available') { this.set({ phase: 'current', version: result.latestVersion }); return }
        const platform = this.options.platform as 'darwin' | 'win32'
        const cache = join(this.options.userData, 'next-updates'); privateDirectory(cache)
        if (this.directory) await rm(this.directory, { recursive: true, force: true })
        const directory = this.directory = await mkdtemp(join(cache, 'download-'))
        this.set({ phase: 'downloading', version: result.latestVersion, received: 0, total: undefined })
        let lastProgress = 0
        const path = await downloadDesktopUpdate({ platform, version: result.latestVersion, channel: 'next',
          destinationPath: join(directory, desktopUpdateFilename(platform, result.latestVersion, 'next')),
          request: this.options.artifactRequest, expectedSha256: result.installerSha256?.[platform],
          signal: AbortSignal.any([signal, AbortSignal.timeout(60 * 60_000)]), onProgress: (received, total) => {
            if (Date.now() - lastProgress < 250 && received !== total) return
            lastProgress = Date.now(); this.set({ received, total })
          } })
        signal.throwIfAborted()
        preparing = true; this.set({ phase: 'preparing' })
        await this.options.prepare(path, result.latestVersion, directory, signal)
        signal.throwIfAborted()
        this.set({ phase: 'ready' })
      } catch (error) {
        this.options.log(error)
        this.set({ phase: 'error', error: preparing ? 'prepare' : 'download' })
      }
    })
  }
  async install(): Promise<void> {
    if (this.disposed || this.state.phase !== 'ready') return
    this.set({ phase: 'installing' })
    try { await this.options.install() }
    catch (error) { this.options.log(error); this.set({ phase: 'error', error: 'install' }) }
  }
  async dispose(keepInstaller = false): Promise<void> {
    this.disposed = true
    clearTimeout(this.timer)
    this.controller?.abort()
    await this.operation
    if (this.directory && !keepInstaller) await rm(this.directory, { recursive: true, force: true }).catch(this.options.log)
  }
}
