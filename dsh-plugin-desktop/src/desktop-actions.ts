/** Narrow, generation-scoped native actions available to trusted Host plugins. */

import { type Context, Service } from '@deepseek-ai/cordis'

/** Native actions deliberately exposed without command, path, or restart arguments. */
export interface DesktopActions {
  /** Open the already-configured DSH Desktop terminal for the active profile. */
  openTerminal(): void
  /** Request one orderly Host-owned application restart. */
  requestRestart(): Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Narrow native actions safe for optional Host-plugin integration. */
    desktopActions: DesktopActions
  }
}

/** Launcher-owned implementations behind the narrow service boundary. */
export interface DesktopActionsBootstrap {
  openTerminal(): void
  requestRestart(): void | Promise<void>
}

/** Publish only terminal-open and restart operations for one Cordis generation. */
export class DesktopActionsService extends Service implements DesktopActions {
  private disposed = false
  private restartCompleted = false
  private restartOperation: Promise<void> | undefined

  constructor(ctx: Context, private readonly bootstrap: DesktopActionsBootstrap) {
    super(ctx, 'desktopActions')
    ctx.effect(
      () => () => { this.disposed = true },
      'dsh-plugin-desktop: desktop actions lifetime',
    )
  }

  openTerminal(): void {
    this.assertActive()
    this.bootstrap.openTerminal()
  }

  requestRestart(): Promise<void> {
    try {
      this.assertActive()
      if (this.restartCompleted) return Promise.resolve()
      if (this.restartOperation !== undefined) return this.restartOperation
      const operation = (async () => {
        this.assertActive()
        await this.bootstrap.requestRestart()
        this.restartCompleted = true
      })()
      this.restartOperation = operation
      void operation.catch(() => {
        if (this.restartOperation === operation) this.restartOperation = undefined
      })
      return operation
    } catch (cause) {
      return Promise.reject(cause)
    }
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('dsh-plugin-desktop: desktopActions service disposed')
  }
}

export default DesktopActionsService
