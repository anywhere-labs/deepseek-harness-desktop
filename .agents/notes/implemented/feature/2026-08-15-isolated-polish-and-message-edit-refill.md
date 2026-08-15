# Agent Note: Polish runs in a throwaway session; sent user messages refill the composer

Status: implemented

English | [中文](2026-08-15-isolated-polish-and-message-edit-refill.zh.md)

## Problem

Two product gaps surfaced from real use. First, draft polishing delivered the polish request as a plugin-sourced `user/message` into the **visible** session and read back the first assistant reply: the conversation gained a real logged turn the user never sent, the polish turn could race a concurrent human turn, and the model label was hard-coded into the button caption. The user wants the polish button to be just `润色`/`Polish`, and the polish itself to happen somewhere invisible: a separate session that receives the user message, returns the polished text, and is discarded — the composer draft is replaced, nothing is ever sent. Second, sent user messages cannot be edited: the edit stub was deliberately dropped ([drop-user-message-edit-stub](../../../.agents/notes/implemented/simplification/2026-07-31-drop-user-message-edit-stub.md)), leaving no way to take a previous message back for revision.

## Decision

**Polish runs in a throwaway session.** `dsh-polish` no longer appends to the target session. `PolishService.polish` creates a fresh agent (`ctx.agents.create` with a `randomUUID` session id) that inherits the target agent's `provider`/`model` options, delivers the polish instruction as a plugin-sourced `user/message` there, waits for quiescence, takes the first non-empty assistant text, and disposes the handle in `finally` — the session never persists and never appears in the UI. The target session's log stays byte-identical; the target must still be live (`session-not-found` otherwise). A failure to create or drive the throwaway session returns `polish-session-failed` with the underlying message; a reply with no text returns `no-result`. The `model` Remote method and the `PolishModelRequest`/`PolishModelResult` vocabulary are deleted, and the button caption is the bare `润色`/`Polish` (`润色中…`/`Polishing…` while busy).

**Editing a sent user message refills the composer.** `MessageIconActions` gains an `onEdit` control rendered before copy; the user message renderer wires it to the session standard kit's `inputActions.setDraft` with the message's plain text (hidden when the message has no text). This is deliberately **not** in-place history editing: the message is loaded into the composer, the user revises and sends a new message. True mutation of a settled logged message plus host replay behavior stays deferred per the earlier decision.

## Alternatives considered

- **Keep the polish turn in the visible session** (status quo): rejected — it pollutes the conversation with a turn the user never sent, races human turns, and cannot be described as "invisible".
- **Call the LLM directly from the service** (bypass the agent loop): rejected — the agent loop owns provider/model resolution, credentials, retries, and prompt assembly; a throwaway agent reuses all of it with one `create` call.
- **In-place message editing** (mutate the logged user message and replay later turns): rejected — event-sourced logs have no cheap rewrite path, and replaying consumed turns is the rollback-scale machinery the earlier drop decision deferred; composer refill covers the actual need (revise and resend) with zero log impact.

## Consequences

- The visible conversation is untouched by polishing: no phantom user message, no race with concurrent turns, no extra tokens in the session log.
- The throwaway polish turn is not reconstructable from the visible log — accepted, and documented as a limitation in `dsh-polish`; a durable record would need a new event kind.
- The polish button is language-neutral (`润色`/`Polish`) with no model label; the deleted `model` Remote shrinks the surface.
- Sent user messages are editable again as composer refill; the history stays authoritative, and a revised message sends as a new message.
