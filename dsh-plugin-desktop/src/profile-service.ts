/** Generation-scoped desktop profile discovery and restart-safe selection service. */

import { type Context, Service } from '@deepseek-ai/cordis'
import type { DesktopProfileSummary } from './profile-manager.ts'

/** Profile identity fixed for one running Cordis generation. */
export interface DesktopCurrentProfile {
  /** Name passed to the profile launcher. */
  readonly name: string
  /** Absolute directory backing the active profile. */
  readonly dir: string
}

/** Supported profile-management capability available to Desktop Host plugins. */
export interface DesktopProfiles {
  /** Immutable identity of the profile backing this Cordis generation. */
  readonly current: DesktopCurrentProfile
  /** Create a safe Web profile without selecting or restarting it. */
  create(name: string): DesktopProfileSummary
  /** Re-read the available profile manifests without changing them. */
  list(): readonly DesktopProfileSummary[]
  /** Persist a compatible profile and request an orderly application restart. */
  select(name: string): Promise<void>
  /** Whether one inactive user profile can be safely removed now. */
  canDelete(name: string): boolean
  /** Remove one inactive user profile through the launcher boundary. */
  delete(name: string): Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Generation-scoped profile identity, discovery, and restart-safe selection. */
    desktopProfiles: DesktopProfiles
  }
}

/** Launcher operations delegated through one service lifetime. */
export interface DesktopProfileServiceBootstrap {
  /** Profile that produced the current Cordis generation. */
  readonly current: DesktopCurrentProfile
  /** Create a safe Web profile without selecting or restarting it. */
  create?: (name: string) => DesktopProfileSummary
  /** Re-read the available profile manifests without changing them. */
  list(): readonly DesktopProfileSummary[]
  /** Persist one validated profile as pending for the next startup. */
  persistSelection(name: string): void | Promise<void>
  /** Request orderly teardown followed by an Electron relaunch. */
  requestRestart(): void | Promise<void>
  /** Whether one profile passes the synchronous deletion checks. */
  canDelete?: (name: string) => boolean
  /** Remove one profile after re-reading selection and recovery state. */
  delete?: (name: string) => void | Promise<void>
}

interface SelectionOperation {
  readonly name: string
  readonly promise: Promise<void>
}

/**
 * Cordis service that exposes the active profile and owns profile-switch ordering.
 *
 * Selection is serialized for the service lifetime. The first selection whose
 * persistence succeeds becomes the committed target; a different concurrent
 * target cannot replace it while restart is pending. A persistence failure
 * releases the slot, while a restart failure retains the committed target so a
 * retry cannot overwrite the pending on-disk selection.
 */
export class DesktopProfileService extends Service implements DesktopProfiles {
  private readonly fixedCurrent: DesktopCurrentProfile
  private disposed = false
  private operation: SelectionOperation | undefined
  private committedName: string | undefined
  private restartCompleted = false

  /**
   * Register the launcher-backed capability as `ctx.desktopProfiles`.
   * @param ctx - Cordis context owning this exact service lifetime.
   * @param bootstrap - generation identity and launcher operations.
   */
  constructor(ctx: Context, private readonly bootstrap: DesktopProfileServiceBootstrap) {
    super(ctx, 'desktopProfiles')
    this.fixedCurrent = Object.freeze({ ...bootstrap.current })
    ctx.effect(
      () => () => { this.disposed = true },
      'dsh-plugin-desktop: profile service lifetime',
    )
  }

  /** Active profile identity for this generation. */
  get current(): DesktopCurrentProfile {
    this.assertActive()
    return this.fixedCurrent
  }

  /** Create a profile through the launcher-owned implementation. */
  create(name: string): DesktopProfileSummary {
    this.assertActive()
    if (this.bootstrap.create === undefined) {
      throw new Error('dsh-plugin-desktop: profile creation is unavailable')
    }
    return this.bootstrap.create(name)
  }

  /** Re-read profile discovery through the launcher-owned implementation. */
  list(): readonly DesktopProfileSummary[] {
    this.assertActive()
    return this.bootstrap.list()
  }

  /**
   * Persist another profile and request restart in that order.
   * @param name - validated profile name selected for the next generation.
   * @returns once the restart request succeeds.
   */
  select(name: string): Promise<void> {
    try {
      this.assertActive()
      if (name === this.fixedCurrent.name) return Promise.resolve()

      const running = this.operation
      if (running !== undefined) {
        if (running.name === name) return running.promise
        return running.promise.then(
          () => this.select(name),
          () => this.select(name),
        )
      }

      if (this.committedName !== undefined) {
        if (name !== this.committedName) return Promise.reject(this.committedSelectionError(name))
        if (this.restartCompleted) return Promise.resolve()
        return this.runExclusive(name, async () => {
          this.assertActive()
          await this.bootstrap.requestRestart()
          this.restartCompleted = true
        })
      }

      return this.runExclusive(name, async () => {
        await this.bootstrap.persistSelection(name)
        this.committedName = name
        this.assertActive()
        await this.bootstrap.requestRestart()
        this.restartCompleted = true
      })
    } catch (cause) {
      return Promise.reject(cause)
    }
  }

  canDelete(name: string): boolean {
    this.assertActive()
    if (this.bootstrap.canDelete === undefined) return false
    return this.bootstrap.canDelete(name)
  }

  async delete(name: string): Promise<void> {
    this.assertActive()
    if (this.bootstrap.delete === undefined) {
      throw new Error('dsh-plugin-desktop: profile deletion is unavailable')
    }
    await this.bootstrap.delete(name)
    this.assertActive()
  }

  /** Run one target transition while retaining exact promise identity for duplicate callers. */
  private runExclusive(name: string, invoke: () => Promise<void>): Promise<void> {
    const promise = invoke()
    const operation = { name, promise }
    this.operation = operation
    const release = (): void => {
      if (this.operation === operation) this.operation = undefined
    }
    void promise.then(release, release)
    return promise
  }

  /** Reject a target that would overwrite the already-persisted pending profile. */
  private committedSelectionError(name: string): Error {
    return new Error(
      `dsh-plugin-desktop: profile ${JSON.stringify(this.committedName)} is already pending; `
      + `cannot select ${JSON.stringify(name)} before restart`,
    )
  }

  /** Reject calls through a retained reference after the owning fiber unloads. */
  private assertActive(): void {
    if (this.disposed) throw new Error('dsh-plugin-desktop: desktopProfiles service disposed')
  }
}

export default DesktopProfileService
