import type { RendererBootReport } from './renderer-boot-contract.ts'

const RETRY_DELAYS_MS = [0, 1000, 3000] as const
const HEALTH_TIMEOUT_MS = 30_000
const STABLE_PERIOD_MS = 60_000

interface RendererRecoveryOptions {
  readonly available: () => boolean
  readonly reload: () => void
  readonly exhausted: () => void
  readonly log: (message: string) => void
  readonly requireSurface?: () => boolean
}

type RecoveryPhase = 'idle' | 'scheduled' | 'loading' | 'exhausted' | 'stopped'

export class DesktopRendererRecovery {
  private phase: RecoveryPhase = 'idle'
  private attempts = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private stableTimer: ReturnType<typeof setTimeout> | undefined
  private documentLoaded = false
  private clientHealthy = false
  private failure: string | undefined
  private surfaceHealthy = false
  private surfaceHidden = false

  constructor(private readonly options: RendererRecoveryOptions) {}

  get exhausted(): boolean { return this.phase === 'exhausted' }
  get detail(): string | undefined { return this.failure }
  get canProbeSurface(): boolean {
    return this.phase === 'idle'
      || ((this.phase === 'loading' || this.phase === 'exhausted') && this.documentLoaded && this.clientHealthy)
  }

  private canAcceptHealth(): boolean {
    return this.phase === 'loading'
      || (this.phase === 'exhausted' && this.failure === 'renderer recovery timed out waiting for page load and client health')
  }

  confirmSurface(): void {
    if (!this.canAcceptHealth()) return
    this.surfaceHealthy = true
    this.acceptHealth()
  }

  visibilityChanged(): void {
    if (this.canAcceptHealth()) this.acceptHealth()
  }

  surfaceBecameHidden(): void {
    if (!this.canAcceptHealth()) return
    this.surfaceHidden = true
    this.acceptHealth()
  }

  fail(detail: string): void {
    if (this.phase === 'stopped' || !this.options.available()) return
    this.failure = detail
    clearTimeout(this.stableTimer)
    this.stableTimer = undefined
    if (this.phase === 'scheduled' || this.phase === 'exhausted') return
    this.clearAttemptTimer()
    const delay = RETRY_DELAYS_MS[this.attempts]
    if (delay === undefined) {
      this.phase = 'exhausted'
      this.options.log(`automatic renderer recovery exhausted: ${detail}`)
      this.options.exhausted()
      return
    }
    this.phase = 'scheduled'
    this.timer = setTimeout(() => { this.reload() }, delay)
    this.timer.unref()
  }

  loaded(): void {
    if (!this.canAcceptHealth()) return
    this.documentLoaded = true
    this.acceptHealth()
  }

  report(report: RendererBootReport): void {
    if (!this.canAcceptHealth()) return
    if (report.status === 'failed') {
      this.fail(`renderer recovery Loader failed: ${report.error ?? report.plugins.join(', ')}`)
      return
    }
    this.clientHealthy = true
    this.acceptHealth()
  }

  retry(): void {
    if (this.phase !== 'exhausted') return
    this.attempts = 0
    this.phase = 'idle'
    this.fail(this.failure ?? 'renderer recovery requested')
  }

  restore(): void {
    if (this.phase !== 'exhausted') return
    this.clearAttemptTimer()
    this.phase = 'idle'
    this.failure = undefined
    this.documentLoaded = true
    this.clientHealthy = true
    this.surfaceHealthy = true
    this.options.log('automatic renderer recovery healthy')
    this.stableTimer = setTimeout(() => {
      this.attempts = 0
      this.stableTimer = undefined
    }, STABLE_PERIOD_MS)
    this.stableTimer.unref()
  }

  stop(): void {
    this.phase = 'stopped'
    this.clearAttemptTimer()
    clearTimeout(this.stableTimer)
    this.stableTimer = undefined
  }

  private reload(): void {
    this.timer = undefined
    if (this.phase !== 'scheduled') return
    if (!this.options.available()) {
      this.stop()
      return
    }
    this.phase = 'loading'
    this.attempts += 1
    this.documentLoaded = false
    this.clientHealthy = false
    this.surfaceHealthy = false
    this.surfaceHidden = false
    this.options.log(`automatic renderer recovery attempt ${String(this.attempts)}`)
    this.timer = setTimeout(() => {
      this.fail('renderer recovery timed out waiting for page load and client health')
    }, HEALTH_TIMEOUT_MS)
    this.timer.unref()
    try {
      this.options.reload()
    } catch (cause) {
      this.fail(`renderer reload failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }

  private acceptHealth(): void {
    if (!this.documentLoaded || !this.clientHealthy || !this.options.available()) return
    if (this.options.requireSurface?.() && !this.surfaceHealthy && !this.surfaceHidden) return
    this.clearAttemptTimer()
    this.phase = 'idle'
    this.failure = undefined
    this.options.log('automatic renderer recovery healthy')
    this.stableTimer = setTimeout(() => {
      this.attempts = 0
      this.stableTimer = undefined
    }, STABLE_PERIOD_MS)
    this.stableTimer.unref()
  }

  private clearAttemptTimer(): void {
    clearTimeout(this.timer)
    this.timer = undefined
  }
}
