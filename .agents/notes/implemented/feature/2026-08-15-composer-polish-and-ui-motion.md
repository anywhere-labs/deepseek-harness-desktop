# Agent Note: Composer polish over the session's own agent channel

Status: implemented

English | [中文](2026-08-15-composer-polish-and-ui-motion.zh.md)

## Problem

The Web GUI composer offered no way to improve a draft before sending. Users
who wanted clearer, more complete messages had to rewrite by hand or send and
iterate, wasting a turn. The natural affordance — a "polish" button next to
the model select — needs a host-side operation that rewrites a draft with the
exact provider, model, and credentials the session is already using, and a
client-side entry that puts the result back into the composer for review.

## Decision

A new host package `dsh-polish` (`packages/interaction/polish`) registers a
Typert Remote namespace (`polish`/`polish`, `polish`/`model`) that rewrites a
draft **through the session's own agent channel**: the request is delivered as
a plugin-sourced `user/message` (`source: { kind: 'plugin', plugin:
'dsh-polish' }`), the model reply lands as an ordinary `assistant/message`,
and the service returns the first non-empty assistant message appended after
the request. The operation is therefore fully reconstructable from the session
log (model-visible means logged), uses no new protocol, and requires no
credential plumbing — the loop's existing provider/model/credential resolution
applies as for any turn. Cold sessions are not resumed for a polish turn.

A new client package `dsh-client-ui-polish` (`packages/client/ui-polish`)
contributes the `conversation.input.right` list entry (id `polish`, order 10)
that renders immediately left of the model select. The caption shows the
session's current model label (`润色 deepseek v4 flash`), the button disables
on an empty draft and while a polish turn is in flight (the same-render
reentry guard uses a ref, since React state cannot disable until the next
render), and on success the returned text replaces the composer draft for the
user to review before sending. Failures announce through the shared transient
Toast.

The same change introduces the unified motion vocabulary in ui-theme
(`src/styles/motion.css`): duration/easing tokens, three standard entrance
keyframes, keyframe-name variables (CSS Modules localize bare animation-name
identifiers, so component sheets consume `--dsw-motion-rise-in` etc. through
`var()`), and the global `prefers-reduced-motion` degradation. Core
conversation surfaces consume it: every chat node (message, tool card, command
row, turn tail) rises in on mount, the hero, the details/todo/queue panels,
and the composer's control transitions. The polish button's own hover/busy
transitions ride the same tokens, which is why the two halves land in one
change.

## Alternatives considered

### A standalone LLM call outside the session log

A side request through the adapter registry that never touches the log would
avoid polluting history, but it would (a) duplicate credential/model
resolution logic, (b) bypass the "model-visible means logged" invariant for
the returned text, and (c) diverge from the user's explicit choice to reuse
the agent channel. Rejected.

### A new session event type for polish records

Extending `SessionEventMap` with a `polish/*` pair would make the operation
explicit but adds a merge-extensible vocabulary entry, replay surface, and
persistence catalog entry for what is already expressible as an ordinary
user/assistant message pair with a distinguishing source. The generic pair is
what compaction, replay, and the UI already understand. Rejected.

### Resuming cold sessions for polish

Resuming a persisted session just to rewrite a draft is expensive and the Web
GUI always operates on live sessions. `session-not-found` is returned
otherwise. Deferred, not rejected.

## Consequences

- One model request per click, retained in the log until compaction like any
  assistant message; the returned text is never sent automatically.
- The polish reply is the first non-empty assistant message after the request;
  a concurrent human turn admitted while the polish turn runs appends later
  and cannot shadow it, but one admitted before the polish turn and completing
  after it can precede the reply in the log. The composer disables the button
  while a polish is in flight, which makes the race unreachable from the
  shipped UI.
- The button caption label is read once per session; a model switch while the
  button stays mounted keeps the old label until the next mount.
- Host packages that expose Remote types to the client must import
  cross-boundary ids through subpaths (`@deepseek-ai/dsh-session/types`), not
  the package root: the root declaration merges `Context.sessions` as
  `SessionStore`, which collides with the client runtime's `ISessions` inside
  the Client aggregate program when the host package's declarations are loaded
  through the Remote chain.
