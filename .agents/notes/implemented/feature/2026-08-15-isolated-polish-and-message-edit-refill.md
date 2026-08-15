# Agent Note: Polish is a direct model call; sent user messages are edited in place

Status: implemented

English | [中文](2026-08-15-isolated-polish-and-message-edit-refill.zh.md)

## Problem

Two product gaps surfaced from real use. First, draft polishing delivered the polish request as a plugin-sourced `user/message` into the **visible** session and read back the first assistant reply: the conversation gained a real logged turn the user never sent, the polish turn could race a concurrent human turn, and the model label was hard-coded into the button caption. The user wants the polish button to be just `润色`/`Polish`, and the polish itself to happen invisibly: the composer draft is replaced, nothing is ever sent, and no session is created at all. Second, sent user messages cannot be edited: the edit stub was deliberately dropped ([drop-user-message-edit-stub](../../../.agents/notes/implemented/simplification/2026-07-31-drop-user-message-edit-stub.md)), leaving no way to take a previous message back for revision.

## Decision

**Polish is ONE direct model call — no session, no log entry.** `dsh-polish` no longer appends to the target session and creates no throwaway agent. `PolishService.polish` resolves the target agent's `provider`/`model` options and makes a single streaming request through `ctx.llm.prepareCall`, exactly "asking the model directly": the instruction plus the verbatim draft in one `user/message`, text-delta chunks accumulated into the reply. The target session's log stays byte-identical; the target must still be live (`session-not-found` otherwise). A call failure returns `polish-failed` with the underlying message; a reply with no text returns `no-result`. The `model` Remote method and the `PolishModelRequest`/`PolishModelResult` vocabulary are deleted, and the button caption is the bare `润色`/`Polish` (`润色中…`/`Polishing…` while busy). Earlier polish attempts that left persisted throwaway sessions behind are cleaned up by the new session deletion.

**Editing a sent user message rewrites it in place.** `MessageIconActions` gains an `onEdit` control rendered before copy; the user message renderer swaps the bubble for a textarea preloaded with the message's full text (the edit box uses the standard input tokens — a border that was previously dropped for referencing an undefined theme token). Saving calls the `messageEdit` Remote (`dsh-message-edit`), which appends a replacement `user/message` carrying the ORIGINAL message id with a `replace` surface operation shadowing the target: the surface fold (and therefore every later model request) sees the new text, and the UI folds the replacement into the same message node via the message Definition's `update` path. The log stays append-only; the turn that already consumed the old wording is not replayed. **Live and cold sessions both edit**: a live session appends through its agent (the event broadcasts to viewers), a cold persisted session appends through `sessionPersistence` (no agent is resumed just to edit text). The client folds the replacement locally from the returned seq — a cold session never broadcasts, and the seq guard drops the duplicate when a live broadcast also arrives (the fold reads the replacement marker's presence, not its extent, so the client rebuilds the event from the request it already made).

## Alternatives considered

- **Keep the polish turn in the visible session** (status quo): rejected — it pollutes the conversation with a turn the user never sent, races human turns, and cannot be described as "invisible".
- **Run polish in a hidden throwaway session** (intermediate implementation): rejected once the user pushed back — even a hidden session is a real session (a list entry until hidden filtering, a persisted artifact, lifecycle overhead); the user explicitly wants no session at all. The direct call uses the same provider/model/credential resolution through `ctx.llm.prepareCall` without the loop's session machinery, which a one-shot text rewrite does not need.
- **Composer refill editing** (load the message into the composer, revise and resend as a new message): rejected once the user clarified the intent — an edited message must stay the SAME message, not spawn a duplicate. In-place editing is implementable on the existing surface machinery: the fold already supports positional replacement (compaction uses it), and reusing the original message id keeps every reference stable.
- **Rewrite the logged event in place**: rejected — the append-only log is the durable contract; a replacement event keeps both texts and stays replay-faithful.
- **Require a live agent for edits** (initial implementation): rejected once editing from a reopened (cold) session failed in real use — a user edits old messages in sessions they re-open, and resuming an agent just to rewrite text would run startup instructions and title generation for a text edit. The persistence append path edits cold logs directly.

## Consequences

- The visible conversation is untouched by polishing: no phantom user message, no race with concurrent turns, no extra tokens in the session log, and no session object exists at any point.
- The polish turn is not reconstructable from any log — accepted, and documented as a limitation in `dsh-polish`; a durable record would need a new event kind.
- The polish button is language-neutral (`润色`/`Polish`) with no model label; the deleted `model` Remote shrinks the surface.
- Edited messages keep their id and position: no duplicate bubble, stable references, and later model requests rebuilt from the surface see the new text. The assistant reply that already responded to the old wording is not replayed — accepted and documented; true replanning of the affected turn stays deferred.
- Editing works on reopened sessions without resuming their agents; the returned event folds locally, so a cold session's bubble updates immediately.
- Session deletion (see the session-deletion note) removes the leftover throwaway sessions older polish attempts persisted.
