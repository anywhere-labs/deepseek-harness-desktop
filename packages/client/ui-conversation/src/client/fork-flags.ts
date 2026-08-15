/**
 * Fork gate over official dsh client behavior. Returns true (this fork's
 * open-file feedback and notice auto-dismiss active) by default; tests stub
 * it to false to pin the official fallback. Flip the body to false — or
 * delete the fork — on the next upstream merge to restore official behavior.
 * @returns whether the fork's feedback patch is active.
 */
export function feedbackPatchEnabled(): boolean {
  return true
}
