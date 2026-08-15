# Agent Note: Session rollback rewinds the event log at a turn boundary

Status: implemented

English | [中文](2026-08-15-session-rollback-rewind.zh.md)

## Problem

The Web GUI needs a rollback: the user picks one assistant message and the session — context and model messages — restores to before that point, with an optional best-effort revert of the code changes the dropped span made. The session log is append-only and is the source of truth, so a user rollback cannot be presentation-only, and cutting the log is not a plain file operation. The agent loop's lifecycle teardown appends `agent/inbox/spliced` tail records asynchronously (write-behind), so a truncation that lands before those writes drain leaves events after the cut. The persistence coordinator keeps per-session cursors and live/prepared reservations that truncation must respect or invalidate. A cut inside a turn would leave an open `turn/start` with no closer, which cold repair then "fixes" with synthetic closers — the opposite of a rollback.

## Decision

Rollback is implemented as a rewind through four layers, each owning one invariant:

1. **Persistence truncation** — `SessionPersistence.truncate(id, toSeq)` keeps events with `seq < toSeq`. `PersistenceCoordinator.truncate` validates a non-negative safe-integer `toSeq`, refuses a live or prepared identity, refuses a `toSeq` past the stored cursor, serializes under the per-session chain, and drains the live controller's pending write-behind before rewriting — so no delayed append can land past the cut. The JSONL backend re-encodes the surviving prefix and atomically replaces the file (rename + dir fsync on POSIX; remove + publish on win32), and the SQLite backend deletes the tail rows and bumps `revision` in one transaction. Backends without the hook refuse loudly.
2. **Agent rewind** — `ctx.agentLoop.rewind(agent, toSeq)` flushes the session, disposes the agent (running every registered teardown, which is what emits the inbox-splice tail), then truncates, then resumes the same identity with `clear` as the start source. The truncation therefore sees the complete post-dispose log.
3. **The rollback service** — `@deepseek-ai/dsh-rollback` exposes one `@Remote('rollback')` verb. It resolves the picked message seq to its `turn/start` (a turn boundary, so the surviving prefix ends on the previous `turn/end` and stays balanced), optionally collects the dropped span's `tool/result` `meta.diffs` in reverse application order, reverse-applies each hunk best-effort (exact `newText` match; a file edited after the hunk records a failure, never a guess), and then rewinds. Failures form a closed vocabulary: `session-not-found`, `message-seq-out-of-range`, `no-turn`, `rewind-failed`.
4. **The leading assistant-message action** — ui-conversation declares a new `conversation.chat.assistant-leading-actions` list seat rendered before the built-in copy control, and `@deepseek-ai/dsh-client-ui-rollback` contributes the rollback entry: an icon button (its own `IconRollbackOutline16`), a confirmation dialog with the **also roll back code** checkbox (unchecked by default), and a result Toast that reports the cut plus how many hunks were reverted and how many failed.

## Alternatives considered

- **Presentation-only rollback** (hide the messages in the UI): rejected — the durable log and replay would still contain the dropped span, so a reconnect or reload resurrects it; the session log is the source of truth.
- **Mid-turn cuts with repair events**: rejected — dropping a turn must stay balanced without synthetic closers; cutting at `turn/start` needs no repair and keeps cold inspection honest.
- **Code revert as fatal-or-all**: rejected — the filesystem may have moved on (the model or the user edited a file after the recorded hunk); reverting what still matches and reporting the rest is the honest outcome, never a blocked rollback.
- **Reusing the trailing `assistant-actions` strip** (between copy and branch): rejected — the button belongs left of copy, and moving the whole strip would relocate the existing feedback controls; a leading seat keeps both layouts stable.

## Consequences

- The cut is always a turn boundary, so the surviving log is balanced and needs no repair events; the session resumes the same identity and continues from the cut.
- Rollback is durable: persistence truncation means a restart restores the session at the cut, not the pre-rollback tail.
- Code reversion is best-effort: partial failures are returned as `codeFailures` and shown in the success Toast; the file system is never guessed at.
- One rollback at a time: the confirmation dialog's action disables while the rewind is in flight; later turns become available after the resume.
- The normal append-only path is unchanged; truncation is an explicit user operation that rewrites the JSONL prefix once (see [session persistence](../../../../packages/session/session-persistence-jsonl/README.md)), which is the single exception to the never-rewrite rule of [2026-06-14-session-persistence.md](2026-06-14-session-persistence.md).
