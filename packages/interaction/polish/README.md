# @deepseek-ai/dsh-polish

English | [中文](README.zh.md)

Draft polishing in an isolated throwaway session: rewrite and expand a user message while keeping its meaning, using the same provider/model/credential resolution the target session already has. The polish request goes to a fresh agent created for exactly one turn — the target session's log is never appended to, so the visible conversation stays clean and the draft never becomes a real message — and that agent is disposed when the reply lands. The caller (the Web composer's polish button) replaces the composer draft with the returned text for the user to review before sending.

## Remote API

The service registers one Typert Remote method under the `polish` namespace, mounted by the Client assembly (`@deepseek-ai/dsh-api-remotes`):

| Method | Request | Result |
|---|---|---|
| `polish` | `{ sessionId, message }` | `{ ok: true, value: { text } }` or a closed failure |

`polish` requires a **live** agent for `sessionId` (it mirrors that session's provider/model); cold sessions are not resumed for a polish turn (`session-not-found` otherwise). The draft is trimmed, must be non-empty (`message-blank`), and must not exceed the configured `maxMessageChars` (`message-too-long`). The throwaway agent runs one turn; a reply with no text reports `no-result`, and a failure to create or drive the throwaway session reports `polish-session-failed` with the underlying message.

## Config

| Field | Default | Meaning |
|---|---|---|
| `maxMessageChars` | `20000` | Maximum input draft length in characters. |

## Model Experience

### Polish prompt

#### What the model sees

One user message with the polish instruction and the verbatim draft, delivered to the throwaway session as a plugin-sourced `user/message`; the model's reply lands as an ordinary `assistant/message` in that session, which is then disposed. The instruction fixes the meaning, asks for a clearer and more complete rewrite in the original language, and requires the answer to be the polished text only — no explanation, prefix, quotes, or tool calls. The returned text is never sent automatically; the caller places it in the composer for the user to review.

#### Token effect

One model request per click, paid by the throwaway session's token meter; nothing is retained in the target session's log.

#### KV Cache effect

The throwaway session is a fresh context, so the polish turn does not reuse the target session's prefix cache; it also never invalidates it, because the target log is untouched.

## Known Limitations and Deferred Work

- **No session-log record of the polish turn** — the throwaway session is disposed, so a polish is not reconstructable from the visible session. The target session's log stays byte-identical, which is the point; if auditability ever outweighs cleanliness, a durable record would need a new event kind.
- **Cold sessions are not polished** — resuming a persisted session to mirror its selection is deliberately out of scope; the Web GUI always operates on live sessions.
