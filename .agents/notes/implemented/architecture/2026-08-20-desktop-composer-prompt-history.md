# Agent Note: Desktop composer prompt history

Status: implemented

English | [中文](2026-08-20-desktop-composer-prompt-history.zh.md)

## Problem

The upstream composer leaves `Up` and `Down` to native textarea movement whenever an `@` or `/` candidate menu does not consume them. DSH Desktop needs session-local recall of submitted prompts and slash-command lines without changing its pinned DeepSeek Harness checkout or replacing the complete composer.

## Decision

The desktop Client installs one effect in both compatibility and advanced modes. Its document-bubbling listener runs after the upstream React key handler and handles only an unmodified arrow event that the composer did not prevent. It starts backward history navigation only when the caret is at the start of the composer. Once history navigation is active, `Down` returns toward the newest entry and finally restores the pre-navigation draft.

The effect derives history from the active session's loaded user, steering, and command nodes whenever navigation starts. Only a node accepted into the session record enters the recall view, so an optimistic composer clear and a later rejected submission never add an unsent draft. History is keyed by the active session; consecutive identical entries are stored once.

History restoration resolves the existing `sessions` and `conversation` services through `ctx.get()`, then calls the conversation input resolver's normal `setDraft()` write path. It does not assign the textarea value, synthesize an input event, or copy the upstream `InputBar`. As a result, the input machine remains the draft authority and restoring a slash command does not reopen a candidate menu. The bubbling arrow listener respects the standard composer's `preventDefault()` result, so candidate-menu ownership follows the upstream input machine rather than a copied DOM heuristic.

## Verification

The desktop prompt-history unit suite covers backward and forward traversal, restoration of the preceding draft, per-session isolation, durable-node refresh, duplicate suppression, rejected submission exclusion, candidate-menu and IME key ownership, and effect disposal. The focused unit test passes.

The package typecheck currently fails before source checking completes because installed `dsh-client-runtime` declarations define `Context.sessions` twice with incompatible types. This feature avoids that property and uses the service lookup path, but the dependency declaration conflict remains outside this change.

## Consequences

Desktop users can recall the current session's loaded accepted text in either presentation mode, including after a desktop restart, while the official composer still owns candidate-menu arrows, submission admission, draft state, and all rendering. Session logs remain the durable message record, and the desktop capability does not add another persistence format.
