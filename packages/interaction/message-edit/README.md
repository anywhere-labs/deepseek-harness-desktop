# @deepseek-ai/dsh-message-edit

English | [中文](README.zh.md)

In-place user-message editing over the session surface. Editing a settled user message appends a replacement `user/message` that carries the ORIGINAL message id and a `replace` surface operation shadowing the target event: the surface fold — and therefore every later model request — sees the new text, the UI folds the replacement into the same message node (no second bubble), and the append-only log keeps both texts. The replacement is a plain `{ kind: 'user' }` message with only the text the caller supplied; the original message's non-text blocks (images, attachments) are preserved as they were.

The message is located by its stable id on the CURRENT surface, so consecutive edits of the same message keep working — each edit targets the previous replacement.

## Remote API

The service registers one Typert Remote method under the `messageEdit` namespace, mounted by the Client assembly (`@deepseek-ai/dsh-api-remotes`):

| Method | Request | Result |
|---|---|---|
| `messageEdit` | `{ sessionId, messageId, text }` | `{ ok: true, value: { seq } }` or a closed failure |

`messageEdit` edits a **live** session through its agent (the appended event broadcasts to viewers) or a **cold** persisted session through session persistence — a reopened conversation is editable without resuming its agent; a session with neither answers `session-not-found`. The text is trimmed, must be non-empty (`message-blank`), and must not exceed the configured `maxMessageChars` (`message-too-long`). The target must be a plain user message still on the surface — a message compacted away, injected as context, or from a non-user source is refused (`message-not-found`). The client folds the replacement locally from the returned seq (a cold session never broadcasts; the seq guard drops the duplicate when a live broadcast also arrives).

## Config

| Field | Default | Meaning |
|---|---|---|
| `maxMessageChars` | `20000` | Maximum replacement text length in characters. |

## Model Experience

### The edit replacement

#### What the model sees

The next model request is rebuilt from the folded surface (`foldSurface`), so the model sees the edited text in the user role at the original message's position; the pre-edit text is not in the request. History the model already produced from the old text is not rewritten — editing changes the message going forward, it does not replay the turn that consumed the old wording.

#### Token effect

The replacement is one new event in the log; requests built after the edit carry the new text instead of the old, so retained tokens reflect the edited version from then on.

#### KV Cache effect

The edited message sits at the same log position with a different text, so the reusable request prefix is invalidated at that point; earlier events are untouched.

## Known Limitations and Deferred Work

- **The turn that consumed the original wording is not replayed** — the assistant reply that already responded to the pre-edit text stays as it was; only future requests see the edit. True replanning of the affected turn is deferred.
- **Text-only edits** — the editor rewrites the message's text blocks; a message with non-text blocks keeps them, and the UI hides the edit control when there is no text to edit.
