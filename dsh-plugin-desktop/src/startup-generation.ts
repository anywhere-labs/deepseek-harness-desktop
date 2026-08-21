/** Resource ownership for one immutable Desktop startup generation. */

import { randomUUID } from 'node:crypto'

const BIN_NAME = 'dsh-plugin-desktop'
const DEFAULT_QUIESCE_TIMEOUT_MS = 5_000

/** Minimal Host lifetime consumed by the startup generation. */
export interface DesktopStartupGenerationHost {
  readonly fiber: {
    dispose(): Promise<void>
  }
}

/** Minimal logger used when recovery cannot safely stop the Host. */
export interface DesktopStartupGenerationLogger {
  error(message: string): void
}

export interface DesktopStartupGenerationOptions {
  readonly logger: DesktopStartupGenerationLogger
  readonly quiesceTimeoutMs?: number
}

/**
 * Own the Host and process-local resources created by one Desktop startup.
 * Host effects receive the same idempotent release callbacks as final shutdown,
 * so every path converges on one resource lifetime.
 */
export class DesktopStartupGeneration {
  readonly id = randomUUID()

  private readonly quiesceTimeoutMs: number
  private readonly releases: Array<() => void> = []
  private host: DesktopStartupGenerationHost | undefined
  private hostDisposeTask: Promise<boolean> | undefined
  private releaseTask: Promise<void> | undefined
  private released = false

  constructor(private readonly options: DesktopStartupGenerationOptions) {
    this.quiesceTimeoutMs = options.quiesceTimeoutMs ?? DEFAULT_QUIESCE_TIMEOUT_MS
    if (!Number.isSafeInteger(this.quiesceTimeoutMs) || this.quiesceTimeoutMs < 1) {
      throw new Error(`${BIN_NAME}: startup generation quiesce timeout must be a positive integer`)
    }
  }

  /** Bind the only Cordis Host that may own this generation's effects. */
  bindHost(host: DesktopStartupGenerationHost): void {
    this.assertActive()
    if (this.host !== undefined && this.host !== host) {
      throw new Error(`${BIN_NAME}: startup generation already owns another Host`)
    }
    this.host = host
  }

  /** Register one process-local resource and return its idempotent Host effect. */
  own(release: () => void): () => void {
    this.assertActive()
    let active = true
    const releaseOnce = (): void => {
      if (!active) return
      active = false
      release()
    }
    this.releases.push(releaseOnce)
    return releaseOnce
  }

  /** Stop the Host and its effects before a recovery mutation. */
  async quiesceForRecovery(): Promise<boolean> {
    if (this.released) return false
    if (this.host === undefined) return true
    this.hostDisposeTask ??= this.disposeHostForRecovery()
    let timeout: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<false>(resolve => {
      timeout = setTimeout(() => {
        this.options.logger.error(
          `${BIN_NAME}: plugin Host did not stop in time; mutating recovery actions are unavailable`,
        )
        resolve(false)
      }, this.quiesceTimeoutMs)
    })
    const result = await Promise.race([this.hostDisposeTask, timedOut])
    if (timeout !== undefined) clearTimeout(timeout)
    return result
  }

  /** Release the Host and every owned resource exactly once. */
  release(): Promise<void> {
    this.releaseTask ??= this.releaseOwned()
    return this.releaseTask
  }

  private async releaseOwned(): Promise<void> {
    this.released = true
    let failure: unknown
    try {
      if (this.hostDisposeTask === undefined || !await this.hostDisposeTask) {
        await this.disposeBoundHost()
      }
    } catch (cause) {
      failure = cause
    }
    for (const release of this.releases.reverse()) {
      try {
        release()
      } catch (cause) {
        failure ??= cause
      }
    }
    if (failure !== undefined) throw failure
  }

  private async disposeHostForRecovery(): Promise<boolean> {
    try {
      await this.disposeBoundHost()
      return true
    } catch (cause) {
      this.options.logger.error(
        `${BIN_NAME}: failed to stop the plugin Host before recovery: ${cause instanceof Error ? cause.message : String(cause)}`,
      )
      return false
    }
  }

  private async disposeBoundHost(): Promise<void> {
    const host = this.host
    if (host === undefined) return
    await host.fiber.dispose()
    if (this.host === host) this.host = undefined
  }

  private assertActive(): void {
    if (this.released) {
      throw new Error(`${BIN_NAME}: startup generation is already released`)
    }
  }
}
