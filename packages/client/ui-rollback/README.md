# @deepseek-ai/dsh-client-ui-rollback

English | [中文](README.zh.md)

Assistant-message rollback button: the `conversation.chat.assistant-leading-actions` entry that sits **left of the copy button** in a finalized assistant message's action row. Clicking it opens a confirmation dialog; confirming rewinds the session to before that message through the rollback Remote ([`dsh-rollback`](../../interaction/rollback/README.md)) — the context and model messages are restored, and the session continues from the earlier point.

The dialog offers an optional **also roll back code** checkbox (unchecked by default): when checked, the file changes the dropped span recorded on `edit`/`write` tool results are reverse-applied first, best-effort — hunks that cannot be applied are reported, never fatal. Success and failure announce through the shared transient Toast; the success toast includes how many code changes were undone and how many could not be.

The rollback button renders once per turn, on the closing assistant message that owns the turn's action row — the same rule that governs the trailing `assistant-actions` strip. Interruption-frozen partials carry no `messageId` and therefore no rollback control.

## Registration

- **Slot**: `conversation.chat.assistant-leading-actions` (id `rollback`, order 10) — declared and typed by ui-conversation's turn-tail entry, rendered before the built-in copy control.
- **Dependencies**: the rollback Remote (`ctx.remote.rollback`) mounted by the Client assembly (`@deepseek-ai/dsh-api-remotes`).
- **Composition**: `packages/bundle/web-app/cordis.patch.yml` mounts this package beside `dsh-rollback`.

## Model Experience

### Rollback and the model

#### What the model sees

Nothing: rollback is a user action on already-completed turns. The session log is truncated at the picked message's `turn/start`, so the model never sees the dropped events again.

#### Token effect

Dropping events frees their tokens from the durable log and from every future request; the surviving prefix is unchanged.

#### KV Cache effect

The prefix is stable; truncation never rewrites earlier events, so the reusable request prefix is unaffected. Code reversion happens on the filesystem, outside the session log.

## Known Limitations and Deferred Work

- **Live sessions only** — the rollback Remote requires a live agent; the Web GUI always operates on live sessions.
- **Code reversion is hunk-text based** — a file edited again after the recorded hunk may no longer contain the exact `newText`, and that hunk is reported as failed rather than guessed at.
- **One rollback at a time** — the confirmation dialog's action disables while the rewind is in flight; later turns become available again once the session resumes at the cut point.
