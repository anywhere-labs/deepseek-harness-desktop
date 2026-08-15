# @deepseek-ai/dsh-polish

English | [中文](README.zh.md)

Draft polishing as a direct model call: rewrite and expand a user message while keeping its meaning, using the same provider/model/credential resolution the target session already has. The polish request makes ONE streaming model call through `ctx.llm.prepareCall` — no session is created, no log entry is written, and the visible conversation is never touched. The caller (the Web composer's polish button) replaces the composer draft with the returned text for the user to review before sending.

## Remote API

The service registers one Typert Remote method under the `polish` namespace, mounted by the Client assembly (`@deepseek-ai/dsh-api-remotes`):

| Method | Request | Result |
|---|---|---|
| `polish` | `{ sessionId, message }` | `{ ok: true, value: { text } }` or a closed failure |

`polish` resolves the target `sessionId`'s agent to read its provider/model selection; a session with no live agent answers `session-not-found` (a cold selection is deliberately not resumed). The draft is trimmed, must be non-empty (`message-blank`), and must not exceed the configured `maxMessageChars` (`message-too-long`). The streaming reply is accumulated as text; a reply with no text reports `no-result`, and a call failure reports `polish-failed` with the underlying message.

## Config

| Field | Default | Meaning |
|---|---|---|
| `maxMessageChars` | `20000` | Maximum input draft length in characters. |

## Model Experience

### Polish prompt

#### What the model sees

One user message with the polish instruction and the verbatim draft, sent as a single direct request on the target session's provider/model selection. The instruction fixes the meaning, asks for a clearer and more complete rewrite in the original language, and requires the answer to be the polished text only — no explanation, prefix, quotes, or tool calls. The returned text is never sent automatically; the caller places it in the composer for the user to review.

#### Token effect

One model request per click, billed to the configured credential; nothing is retained in the target session's log.

#### KV Cache effect

The direct call uses a fresh request context, so it does not reuse the target session's prefix cache; it also never invalidates it, because the target log is untouched.

## Known Limitations and Deferred Work

- **No session-log record of the polish turn** — the direct call writes nothing durable, so a polish is not reconstructable from any session log. The target session's log stays byte-identical, which is the point; if auditability ever outweighs cleanliness, a durable record would need a new event kind.
- **Cold sessions are not polished** — resolving a persisted session's selection without resuming it is deliberately out of scope; the Web GUI always operates on live sessions.
