/** Recoverable startup state machine for the desktop-owned Host process. */

import type { HostSupervisor } from './host-supervisor.ts'

const DEFAULT_SLOW_START_MS = 15_000

/** Host composition selected for one startup attempt. */
export type DesktopHostMode = 'normal' | 'safe'

/** Observable states used by structured desktop startup diagnostics. */
export type DesktopStartupState =
  | 'starting-normal'
  | 'starting-safe'
  | 'slow-normal'
  | 'slow-safe'
  | 'failed-normal'
  | 'failed-safe'
  | 'stopping-normal'
  | 'stopping-safe'
  | 'ready-normal'
  | 'ready-safe'

/** User decision returned by a startup recovery prompt. */
export type DesktopRecoveryChoice = 'wait' | 'retry' | 'safe-mode' | 'quit' | 'dismissed'

/** Recovery prompt request emitted by the startup controller. */
export interface DesktopRecoveryRequest {
  readonly kind: 'slow' | 'failure'
  readonly mode: DesktopHostMode
  readonly error?: unknown
  readonly signal: AbortSignal
}

/** Successful startup result. */
export interface DesktopStartupResult {
  readonly host: HostSupervisor
  readonly origin: string
  readonly safeMode: boolean
}

/** Dependencies and timing for {@link startRecoverableDesktopHost}. */
export interface DesktopStartupOptions {
  readonly createHost: (mode: DesktopHostMode) => HostSupervisor
  readonly prompt: (request: DesktopRecoveryRequest) => Promise<DesktopRecoveryChoice>
  readonly signal?: AbortSignal
  readonly slowStartMs?: number
  readonly onState?: (state: DesktopStartupState) => void
  readonly onCallbackError?: (error: unknown) => void
}

/** Error used when application shutdown owns an unfinished startup. */
export class DesktopStartupCancelledError extends Error {
  constructor() {
    super('desktop startup cancelled')
    this.name = 'DesktopStartupCancelledError'
  }
}

type StartOutcome =
  | { readonly kind: 'ready'; readonly origin: string }
  | { readonly kind: 'failure'; readonly error: unknown }

type PromptOutcome =
  | { readonly kind: 'choice'; readonly choice: DesktopRecoveryChoice }
  | { readonly kind: 'prompt-failure'; readonly error: unknown }

function startOutcome(host: HostSupervisor): Promise<StartOutcome> {
  return host.start().then(
    origin => ({ kind: 'ready', origin }),
    (error: unknown) => ({ kind: 'failure', error }),
  )
}

function emitState(options: DesktopStartupOptions, state: DesktopStartupState): void {
  try {
    options.onState?.(state)
  } catch (error) {
    try {
      options.onCallbackError?.(error)
    } catch {
      // Diagnostic callbacks cannot own or interrupt the Host lifecycle.
    }
  }
}

function abortPromise(signal: AbortSignal | undefined): { promise: Promise<'aborted'>; dispose: () => void } {
  if (signal === undefined) return { promise: new Promise(() => {}), dispose: () => {} }
  if (signal.aborted) return { promise: Promise.resolve('aborted'), dispose: () => {} }
  let accept!: (value: 'aborted') => void
  const promise = new Promise<'aborted'>((resolve) => { accept = resolve })
  const abort = (): void => { accept('aborted') }
  signal.addEventListener('abort', abort, { once: true })
  return { promise, dispose: () => { signal.removeEventListener('abort', abort) } }
}

async function stopAttempt(
  options: DesktopStartupOptions,
  mode: DesktopHostMode,
  host: HostSupervisor,
  outcome: Promise<StartOutcome>,
): Promise<void> {
  emitState(options, mode === 'normal' ? 'stopping-normal' : 'stopping-safe')
  await host.shutdown()
  await outcome
}

/**
 * Start the normal Host and recover through a safe composition when requested.
 * @param options - Host factory, prompt adapter, cancellation and diagnostics.
 * @returns The ready Host and its loopback origin.
 */
export async function startRecoverableDesktopHost(options: DesktopStartupOptions): Promise<DesktopStartupResult> {
  const abort = abortPromise(options.signal)
  let mode: DesktopHostMode = 'normal'
  try {
    for (;;) {
      if (options.signal?.aborted === true) throw new DesktopStartupCancelledError()
      emitState(options, mode === 'normal' ? 'starting-normal' : 'starting-safe')
      const host = options.createHost(mode)
      const outcome = startOutcome(host)
      let slowTimer: ReturnType<typeof setTimeout> | undefined
      const slow = new Promise<'slow'>((resolve) => {
        slowTimer = setTimeout(() => { resolve('slow') }, options.slowStartMs ?? DEFAULT_SLOW_START_MS)
      })
      let current = await Promise.race([outcome, slow, abort.promise])
      if (slowTimer !== undefined) clearTimeout(slowTimer)

      if (current === 'aborted') {
        await stopAttempt(options, mode, host, outcome)
        throw new DesktopStartupCancelledError()
      }

      if (current === 'slow') {
        emitState(options, mode === 'normal' ? 'slow-normal' : 'slow-safe')
        const promptAbort = new AbortController()
        const prompt: Promise<PromptOutcome> = options.prompt({
          kind: 'slow',
          mode,
          signal: promptAbort.signal,
        }).then(
          choice => ({ kind: 'choice' as const, choice }),
          (error: unknown) => ({ kind: 'prompt-failure' as const, error }),
        )
        const slowDecision: StartOutcome
          | { readonly kind: 'choice'; readonly choice: DesktopRecoveryChoice }
          | { readonly kind: 'prompt-failure'; readonly error: unknown }
          | 'aborted'
            = await Promise.race([outcome, prompt, abort.promise])
        if (slowDecision === 'aborted') {
          promptAbort.abort()
          await stopAttempt(options, mode, host, outcome)
          throw new DesktopStartupCancelledError()
        }
        if (slowDecision.kind === 'ready' || slowDecision.kind === 'failure') {
          promptAbort.abort()
          await prompt
          current = slowDecision
        } else if (slowDecision.kind === 'prompt-failure') {
          await stopAttempt(options, mode, host, outcome)
          throw slowDecision.error
        } else if (slowDecision.choice === 'wait' || slowDecision.choice === 'dismissed') {
          current = await Promise.race([outcome, abort.promise])
          if (current === 'aborted') {
            await stopAttempt(options, mode, host, outcome)
            throw new DesktopStartupCancelledError()
          }
        } else {
          await stopAttempt(options, mode, host, outcome)
          if (slowDecision.choice === 'quit') throw new DesktopStartupCancelledError()
          mode = slowDecision.choice === 'safe-mode' ? 'safe' : mode
          continue
        }
      }

      if (current.kind === 'ready') {
        emitState(options, mode === 'normal' ? 'ready-normal' : 'ready-safe')
        return { host, origin: current.origin, safeMode: mode === 'safe' }
      }

      await stopAttempt(options, mode, host, outcome)
      emitState(options, mode === 'normal' ? 'failed-normal' : 'failed-safe')
      const promptAbort = new AbortController()
      const failurePrompt: Promise<PromptOutcome> = options.prompt({
        kind: 'failure',
        mode,
        error: current.error,
        signal: promptAbort.signal,
      }).then(
        choice => ({ kind: 'choice' as const, choice }),
        (error: unknown) => ({ kind: 'prompt-failure' as const, error }),
      )
      const failureDecision: PromptOutcome | 'aborted' = await Promise.race([failurePrompt, abort.promise])
      if (failureDecision === 'aborted') {
        promptAbort.abort()
        await failurePrompt
        throw new DesktopStartupCancelledError()
      }
      if (failureDecision.kind === 'prompt-failure') throw failureDecision.error
      if (failureDecision.choice === 'quit' || failureDecision.choice === 'dismissed' || failureDecision.choice === 'wait') {
        throw new DesktopStartupCancelledError()
      }
      mode = failureDecision.choice === 'safe-mode' ? 'safe' : mode
    }
  } finally {
    abort.dispose()
  }
}
