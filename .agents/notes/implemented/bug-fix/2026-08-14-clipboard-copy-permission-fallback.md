# Agent Note: Desktop copy controls blocked by deny-all permission policy

Status: implemented

English | [中文](2026-08-14-clipboard-copy-permission-fallback.zh.md)

## Problem

The desktop shell installs a deny-all session permission policy before the
first renderer loads (`setPermissionCheckHandler(() => false)`).
`navigator.clipboard.writeText()` performs a `clipboard-sanitized-write`
permission check, so every copy control in the Web UI — message bubble, code
block, terminal, diff, search result, hover card, JSON tree — rejects with
`NotAllowedError` in the desktop app. The renderer helper `writeClipboard`
treated a rejecting async API as a hard failure: it ran the
`execCommand('copy')` fallback only when `navigator.clipboard.writeText` was
entirely absent, so on the desktop the fallback never ran and clicking copy
silently did nothing.

## Decision

Two layers change together.

`apps/desktop/src/main.ts` (`hardenSession`) allows exactly one permission —
`clipboard-sanitized-write` — in both the permission-check and
permission-request handlers; everything else stays denied, preserving the
hardening intent.

`packages/client/ui-primitives/src/clipboard.ts` (`writeClipboard`) falls
through to the `execCommand('copy')` path when the async API exists but
rejects, so a host whose policy denies the async API still copies through the
legacy synchronous path, which does not consult the permission system.
`JsonTree` routes its copy through `writeClipboard` instead of calling
`navigator.clipboard.writeText` directly, gaining the same fallback and an
honest failure state.

## Alternatives considered

**Allow the permission only in the desktop shell.** Rejected as the sole fix:
the renderer fallback also protects every other policy-restricted host (iframe
embeds, future web deployments) and gives `JsonTree` an honest failure state
instead of an unreachable catch.

**Renderer-only fallback.** Rejected because the shell denial is the root
cause: the primary async path would stay broken there, and any host without an
`execCommand('copy')` path would still fail.

**Keep returning false on rejection.** Rejected because it is the observed
defect: copy silently fails with no user feedback.

## Consequences

Copy works again in the desktop app through the async API with the
`execCommand('copy')` fallback as defense in depth; the Web UI copies on any
host where `writeText` exists but rejects; `JsonTree` reports an honest
failure state when both paths refuse. The shell's hardening posture is
unchanged except for the single clipboard-write permission. Unit coverage
pins the new branches: rejection followed by execCommand success, rejection
followed by execCommand refusal, and the existing missing-API paths.
