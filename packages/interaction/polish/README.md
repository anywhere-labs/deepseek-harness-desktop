# @deepseek-ai/dsh-polish

English | [中文](README.zh.md)

Draft polishing over the session's own agent channel: rewrite and expand a user message while keeping its meaning, using the exact provider, model, and credentials the session is already on. The polish request is delivered as a plugin-sourced `user/message` and the model reply lands as an ordinary `assistant/message`, so the operation is fully reconstructable from the session log and consumes no new protocol — the caller (the Web composer's polish button) replaces the draft with the returned text for the user to review before sending.

## Remote API

The service registers two Typert Remote methods under the `polish` namespace, mounted by the Client assembly (`@deepseek-ai/dsh-api-remotes`):

| Method | Request | Result |
|---|---|---|
| `polish` | `{ sessionId, message }` | `{ ok: true, value: { text } }` or a closed failure |
| `model` | `{ sessionId }` | `{ label }` — the session's current model label for the button caption |

`polish` requires a **live** agent for `sessionId`; cold sessions are not resumed for a polish turn (`session-not-found` otherwise). The draft is trimmed, must be non-empty (`message-blank`), and must not exceed the configured `maxMessageChars` (`message-too-long`). After the followup the service waits for the agent to reach quiescence and returns the first non-empty assistant message appended after the request; a turn whose reply carries no text reports `no-result`.

## Config

| Field | Default | Meaning |
|---|---|---|
| `maxMessageChars` | `20000` | Maximum input draft length in characters. |

## Model Experience

### Polish prompt

#### What the model sees

One user message with the polish instruction and the verbatim draft. The instruction fixes the meaning, asks for a clearer and more complete rewrite in the original language, and requires the answer to be the polished text only — no explanation, prefix, quotes, or tool calls. The returned text is never sent automatically; the caller places it in the composer for the user to review.

#### Token effect

One model request plus the retained draft and reply in the session log. The reply stays in history until compaction, like any assistant message.

#### KV Cache effect

Append-only: the new user message follows the reusable request prefix and does not invalidate prior cache entries.

## Known Limitations and Deferred Work

- **Concurrent human turns race the result read** — the polish reply is the first non-empty assistant message after the request; a human turn admitted while the polish turn runs appends later, so its reply never shadows the polish result, but a human message admitted before the polish turn that completes after it can precede the polish reply in the log. The composer disables the button while a polish is in flight, which makes the race unreachable from the shipped UI.
- **Cold sessions are not polished** — resuming a persisted session for a polish turn is deliberately out of scope; the Web GUI always operates on live sessions.
