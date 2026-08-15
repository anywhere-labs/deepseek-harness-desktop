# @deepseek-ai/dsh-client-ui-polish

English | [中文](README.zh.md)

Composer polish button: the `conversation.input.right` entry that sits immediately **left of the model select** in the composer's tool row. It rewrites and expands the current draft through an isolated throwaway session mirroring the session's own provider/model selection ([`dsh-polish`](../../interaction/polish/README.md)) — the visible conversation is never touched — and replaces the draft with the returned text for the user to review before sending.

The caption is the bare `润色` / `Polish`, switching to `润色中…` / `Polishing…` while the polish turn runs. The button disables on an empty draft and while a polish is in flight; failures announce through the shared transient Toast.

## Registration

- **Slot**: `conversation.input.right` (id `polish`, order 10) — declared and typed by ui-conversation's composer-bar entry.
- **Dependencies**: the polish Remote (`ctx.remote.polish`) mounted by the Client assembly (`@deepseek-ai/dsh-api-remotes`); the session standard kit's `useInput`/`inputActions` for the live draft and the single draft write path.
- **Composition**: `packages/bundle/web-app/cordis.patch.yml` mounts this package beside `dsh-polish` and `ui-model-selection`.

## Model Experience

### The polish turn

#### What the model sees

The polish instruction and the verbatim draft as one user message in the throwaway session (see `dsh-polish`); the model's reply is never sent automatically — it replaces the composer draft for the user to review.

#### Token effect

One model request per click in the throwaway session; nothing is retained in the visible session's log.

#### KV Cache effect

The throwaway context neither reuses nor invalidates the visible session's prefix cache.

## Known Limitations and Deferred Work

- **Cold sessions are not polished** — the polish Remote requires a live target agent; the Web GUI always operates on live sessions.
