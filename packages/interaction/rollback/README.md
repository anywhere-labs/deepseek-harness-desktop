# @deepseek-ai/dsh-rollback

English | [中文](README.zh.md)

Session rollback over the agent-loop rewind: restore a session — context and model messages — to before one message, optionally reverting the file changes the dropped span recorded on `edit`/`write` tool results. The caller (the Web assistant-message rollback button) picks a message by seq; the service cuts at that message's **turn start**, so the surviving log ends on the previous `turn/end` and stays balanced with no repair events.

The cut is durable: persistence truncates the stored log (JSONL rewrites the surviving prefix atomically; SQLite deletes the tail rows in one transaction), and the live agent is disposed and resumed as the same identity, so the session continues from the cut point. The rewind ordering is deliberate — flush, dispose (which appends the inbox-splice tail), truncate, resume — so no delayed write can land past the cut.

Code reversion is best-effort, never fatal: the dropped span's `tool/result` `meta.diffs` are collected in reverse application order and each hunk is reverse-applied by exact `newText` match. A file edited after the recorded hunk, or a hunk outside the session workspace, is reported as a failure; the rollback itself still succeeds. The caller reports how many hunks were reverted and how many failed.

## Remote API

The service registers one Typert Remote method under the `rollback` namespace, mounted by the Client assembly (`@deepseek-ai/dsh-api-remotes`):

| Method | Request | Result |
|---|---|---|
| `rollback` | `{ sessionId, messageSeq, code? }` | `{ ok: true, value: { cutSeq, codeReverted, codeFailures } }` or a closed failure |

Failures form a closed vocabulary: `session-not-found` (no live agent), `message-seq-out-of-range` (the seq is not a message in the current log), `no-turn` (the seq is inside no turn), and `rewind-failed` (the loop rewind threw; the session is untouched but files may be partially reverted).

## Model Experience

### Rollback and the model

#### What the model sees

Nothing: rollback is a user action on already-completed turns. The dropped span is gone from the log — the cut is the picked message's `turn/start` — so the model never sees it again; the surviving prefix is byte-identical.

#### Token effect

Dropping events frees their tokens from the durable log and from every future request.

#### KV Cache effect

The prefix is stable; truncation never rewrites earlier events, so the reusable request prefix is unaffected. Code reversion happens on the filesystem, outside the session log.

## Known Limitations and Deferred Work

- **Live sessions only** — the rollback Remote requires a live agent; resuming a persisted session for a rollback is deliberately out of scope.
- **Code reversion is hunk-text based** — a file edited again after the recorded hunk may no longer contain the exact `newText`, and that hunk is reported as failed rather than guessed at.
- **One rollback at a time** — the loop disposes and resumes the agent; a concurrent rollback of the same session is refused by the live-agent guard, and a second rollback after the first simply targets the shortened log.
