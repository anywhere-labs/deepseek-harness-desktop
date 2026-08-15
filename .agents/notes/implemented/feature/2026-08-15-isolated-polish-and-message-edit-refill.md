# Agent Note: Polish runs in a throwaway session; sent user messages are edited in place

Status: implemented

English | [中文](2026-08-15-isolated-polish-and-message-edit-refill.zh.md)

## Problem

Two product gaps surfaced from real use. First, draft polishing delivered the polish request as a plugin-sourced `user/message` into the **visible** session and read back the first assistant reply: the conversation gained a real logged turn the user never sent, the polish turn could race a concurrent human turn, and the model label was hard-coded into the button caption. The user wants the polish button to be just `润色`/`Polish`, and the polish itself to happen somewhere invisible: a separate session that receives the user message, returns the polished text, and is discarded — the composer draft is replaced, nothing is ever sent. Second, sent user messages cannot be edited: the edit stub was deliberately dropped ([drop-user-message-edit-stub](../../../.agents/notes/implemented/simplification/2026-07-31-drop-user-message-edit-stub.md)), leaving no way to take a previous message back for revision.

## Decision

**Polish runs in a hidden throwaway session.** `dsh-polish` no longer appends to the target session. `PolishService.polish` creates a fresh agent (`ctx.agents.create` with a `randomUUID` session id) that inherits the target agent's `provider`/`model` options, marks the session `meta.hidden` (so `session.list` and every derived surface exclude it), delivers the polish instruction as a plugin-sourced `user/message` there, waits for quiescence, takes the first non-empty assistant text, and disposes the handle in `finally` — the session never persists and never appears in the UI. The target session's log stays byte-identical; the target must still be live (`session-not-found` otherwise). A failure to create or drive the throwaway session returns `polish-session-failed` with the underlying message; a reply with no text returns `no-result`. The `model` Remote method and the `PolishModelRequest`/`PolishModelResult` vocabulary are deleted, and the button caption is the bare `润色`/`Polish` (`润色中…`/`Polishing…` while busy).

**Editing a sent user message rewrites it in place.** `MessageIconActions` gains an `onEdit` control rendered before copy; the user message renderer swaps the bubble for a textarea preloaded with the message's full text. Saving calls the `messageEdit` Remote (`dsh-message-edit`), which appends a replacement `user/message` carrying the ORIGINAL message id with a `replace` surface operation shadowing the target: the surface fold (and therefore every later model request) sees the new text, and the UI folds the replacement into the same message node via the message Definition's `update` path. The log stays append-only; the turn that already consumed the old wording is not replayed.

## Alternatives considered

- **Keep the polish turn in the visible session** (status quo): rejected — it pollutes the conversation with a turn the user never sent, races human turns, and cannot be described as "invisible".
- **Call the LLM directly from the service** (bypass the agent loop): rejected — the agent loop owns provider/model resolution, credentials, retries, and prompt assembly; a throwaway agent reuses all of it with one `create` call.
- **Composer refill editing** (load the message into the composer, revise and resend as a new message): rejected once the user clarified the intent — an edited message must stay the SAME message, not spawn a duplicate. In-place editing is implementable on the existing surface machinery: the fold already supports positional replacement (compaction uses it), and reusing the original message id keeps every reference stable.
- **Rewrite the logged event in place**: rejected — the append-only log is the durable contract; a replacement event keeps both texts and stays replay-faithful.

## Consequences

- The visible conversation is untouched by polishing: no phantom user message, no race with concurrent turns, no extra tokens in the session log, and the throwaway session is excluded from `session.list` via `meta.hidden`.
- The throwaway polish turn is not reconstructable from the visible log — accepted, and documented as a limitation in `dsh-polish`; a durable record would need a new event kind.
- The polish button is language-neutral (`润色`/`Polish`) with no model label; the deleted `model` Remote shrinks the surface.
- Edited messages keep their id and position: no duplicate bubble, stable references, and later model requests rebuilt from the surface see the new text. The assistant reply that already responded to the old wording is not replayed — accepted and documented; true replanning of the affected turn stays deferred.
