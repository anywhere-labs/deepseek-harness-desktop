# Agent Note: Desktop composer prompt history

Status: implemented

English | [中文](2026-08-20-desktop-composer-prompt-history.zh.md)

## Problem

The upstream composer leaves `Up` and `Down` to native textarea movement whenever an `@` or `/` candidate menu does not consume them. DSH Desktop needs session-local recall of submitted prompts and slash-command lines without changing its pinned DeepSeek Harness checkout or replacing the complete composer.

## Decision

The desktop Client installs one effect in both compatibility and advanced modes. The effect listens after the upstream React key handler. It only handles an unmodified arrow event that the candidate menu did not consume, and starts backward history navigation only when the caret is at the start of the composer. Once history navigation is active, `Down` returns toward the newest entry and finally restores the pre-navigation draft.

The effect records non-empty Enter submissions and click submissions that clear the composer, so stopping a running turn does not add an unsent draft. Before its first submission or navigation in a session, it derives history from that session's loaded user, steering, and command nodes. History is keyed by the active session; consecutive identical entries are stored once.

History restoration resolves the existing `sessions` and `conversation` services through `ctx.get()`, then calls the conversation input resolver's normal `setDraft()` write path. It does not assign the textarea value, synthesize an input event, or copy the upstream `InputBar`. As a result, the input machine remains the draft authority and restoring a slash command does not reopen a candidate menu. The arrow listener runs in capture phase after checking for a candidate menu, so it does not rely on React event-prevention timing.

## Verification

The desktop prompt-history unit suite covers backward and forward traversal, restoration of the preceding draft, per-session isolation, empty-submit rejection, duplicate suppression, and reset after an ordinary edit. The focused unit test passes.

The package typecheck currently fails before source checking completes because installed `dsh-client-runtime` declarations define `Context.sessions` twice with incompatible types. This feature avoids that property and uses the service lookup path, but the dependency declaration conflict remains outside this change.

## Consequences

Desktop users can recall the current session's loaded submitted text in either presentation mode, including after a desktop restart, while the official composer still owns candidate-menu arrows, submission admission, draft state, and all rendering. Session logs remain the durable message record, and the desktop capability does not add another persistence format.
