/**
 * PolishButton's injected face. The target 'conversation.input.right' seat is
 * declared (children table) and typed by ui-conversation's composer-bar entry;
 * this package only contributes one list entry, so no SlotMap merge lives
 * here. The live draft and the setDraft verb arrive through the framework
 * session kit (useInput/inputActions); inject carries only the Remote verbs,
 * bound to the entry's session at registration time.
 */

/** Settled outcome of one polish call, normalized for the button surface. */
export type PolishOutcome =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly code: string; readonly message: string }

/** Injected business face of the composer polish entry (session-bound). */
export interface PolishActions {
  /**
   * The session's current model display label for the button caption;
   * empty when the session has no resolvable selection.
   * @returns the model label, or '' on any failure.
   */
  modelOf: () => Promise<string>
  /**
   * Polish and expand one draft through the session's own agent channel.
   * @param message - the verbatim draft.
   * @returns the polished text or a normalized failure.
   */
  polish: (message: string) => Promise<PolishOutcome>
}
