# @deepseek-ai/dsh-client-ui-polish

English | [中文](README.zh.md)

Composer polish button: the `conversation.input.right` entry that sits immediately **left of the model select** in the composer's tool row. It rewrites and expands the current draft through the session's own agent channel ([`dsh-polish`](../../interaction/polish/README.md)) — the same provider, model, and credentials the session already uses — and replaces the draft with the returned text for the user to review before sending.

The caption shows the session's current model label (`润色 deepseek v4 flash` / `Polish deepseek v4 flash`), falls back to the bare `润色` / `Polish` when no label resolves, and switches to `润色中…` / `Polishing…` while the polish turn runs. The button disables on an empty draft and while a polish is in flight (which also closes the result-read race documented by `dsh-polish`); failures announce through the shared transient Toast.

## Registration

- **Slot**: `conversation.input.right` (id `polish`, order 10) — declared and typed by ui-conversation's composer-bar entry.
- **Dependencies**: the polish Remote (`ctx.remote.polish`) mounted by the Client assembly (`@deepseek-ai/dsh-api-remotes`); the session standard kit's `useInput`/`inputActions` for the live draft and the single draft write path.
- **Composition**: `packages/bundle/web-app/cordis.patch.yml` mounts this package beside `dsh-polish` and `ui-model-selection`.

## Model Experience

### The polish turn

#### What the model sees

The polish instruction and the verbatim draft as one user message (see `dsh-polish`); the model's reply is never sent automatically — it replaces the composer draft for the user to review.

#### Token effect

One model request per click, retained in the session log until compaction.

#### KV Cache effect

Append-only; the polish turn does not invalidate the reusable request prefix.

## Known Limitations and Deferred Work

- **Cold sessions are not polished** — the polish Remote requires a live agent; the Web GUI always operates on live sessions.
- **The caption label is read once per session** — a model switch while the button stays mounted keeps the old label until the next session visit; the label refreshes on the next mount.
