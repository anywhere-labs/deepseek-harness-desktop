/**
 * Edition-local adapter between the shared Desktop sources and the core job
 * registry's completion stream.
 *
 * Both Desktop editions ride dsh 0.1.7, which removed `JobRegistry#onJobDone` and the
 * `JobSnapshot` projection in favour of one filtered event stream:
 * `jobs.events.subscribe(filter, listener)` delivers `registered`, `progress`,
 * `stopping`, `settled`, `removed`, and `output` events carrying a `JobView`.
 * Desktop only ever wanted terminal states, so the adapter narrows the stream
 * to the same shape stable's completion listener hands out.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-jobs'

/** Terminal state of one background job, narrowed to what Desktop notifies on. */
export type DesktopJobOutcome = 'completed' | 'failed' | 'other'

/** Narrow a core job status to the outcomes Desktop raises attention for. */
function desktopJobOutcome(status: string): DesktopJobOutcome {
  if (status === 'completed' || status === 'failed') return status
  return 'other'
}

/**
 * Observe unattended job settlements under this context's scope.
 * @param ctx - a context with the `jobs` service injected.
 * @param listener - receives each settled job's narrowed outcome.
 * @returns the disposer unregistering the observer.
 */
export function observeDesktopJobOutcomes(
  ctx: Context,
  listener: (outcome: DesktopJobOutcome) => void,
): () => void {
  return ctx.jobs.events.subscribe({ owners: 'scope' }, (event) => {
    if (event.type !== 'settled') return
    // Waiting callers already collect the result; teardown has no live owner to notify.
    if (event.awaited || event.cause === 'teardown') return
    listener(desktopJobOutcome(event.job.status))
  })
}
