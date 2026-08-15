# Agent Note: File-open clicks always report their outcome through the composer notice

Status: implemented

English | [中文](2026-08-15-open-file-feedback-composer-notice.zh.md)

## Problem

Clicking a produced-file chip or a tool-row file link calls `openFile` in the ui-conversation chat-view inject, which resolves the path against the session cwd and calls `workspaces.openPath`, swallowing every rejection with `.catch(() => {})`. A failure therefore looks exactly like a dead link: the click does nothing and no error surfaces anywhere. Two failure modes share the symptom. On a Windows host without `powershell.exe` on PATH, `execFile` rejects with ENOENT and the RPC returns an error that the `.catch` discards. When the default application exists but silently discards the request — an app that cannot open a WSL `\\wsl.localhost` UNC path yet exits 0 — `openNativePath` resolves, the RPC reports `{opened: true}`, and every layer believes the open succeeded. The user-visible gap is the same in both: no feedback and no reason.

## Decision

`openFile` now routes both outcomes to the per-session composer notice channel through `inputHub.shell(sessionId).notify(...)`: success reports `produced.open.succeeded`, failure reports `produced.open.failed` with the thrown error's message. The success copy says "handed {name} to the OS to open" and never claims the file opened, because `opened: true` cannot distinguish a real open from a silently discarded request. The failure copy carries the Host reason (`workspaces.openPath` throws `path open failed: <message>`). The change stays inside the single `openFile` choke point; the `(path) => void` signature and every consumer (ui-deliverables chips, ui-tool rows, "show in folder") are unchanged.

The notice channel is set-once — nothing cleared it, so a notice stayed on the composer forever. The strip is now transient like the prompt-error toast: `SessionInputShell.clearNotice()` clears the store, the composer-bar inject exposes it as `clearNotice`, and InputBar runs a `seq`-keyed timer that restarts the 6-second hold on a replacement notice and otherwise dismisses the strip. The success copy's tail explains why no app-chooser appeared: Windows shows the chooser only for an unassociated extension, so an absent window or chooser means the file type has a default app that could not open this path; the copy closes with the full path so the user can open it manually.

Both behaviors are gated by `feedbackPatchEnabled()` (`src/client/fork-flags.ts`): `openFile` falls back to the official silent `.catch(() => {})` and the injected `clearNotice` becomes a no-op when the flag returns false, restoring the official client. Flip that function to false — or delete the fork — on the next upstream merge.

## Alternatives considered

**A viewport-fixed toast store and banner in the chat view.** Rejected: new store plus banner machinery, while the composer notice is already visible where the produced-file row sits — the chips close a finished turn, just above the composer. The existing notice channel is the documented outlet for "detached command results and business notifications".

**Make `openFile` return a Promise so each consumer shows its own inline status.** Rejected: changes the owner-prop contract across ui-conversation, ui-deliverables, and ui-tool and their ~12 test files for the same user-visible outcome.

**A stricter Host probe of the default application.** Rejected: it cannot detect an app that accepts the path but silently fails (exit 0), which is the WSL/UNC case; and for an unassociated extension it would replace the useful OS "choose an app" dialog with a product error.

## Consequences

Every open click now produces a composer notice that auto-dismisses after six seconds — the transient lifetime applies to every notice (command failures, steering failures, file-open), matching the prompt-error toast. The honest success wording makes the silently-failing-app case visible for the first time: the user sees "handed X to the OS to open" while nothing opens, and the copy's tail tells them the file type already has a default app that could not open the path and names the full path for manual opening — pointing at the default program rather than the product. The detection ceiling is unchanged — an app that exits 0 without showing anything is still indistinguishable from a real open, which is why the success copy stays conservative and explains rather than claims. The unassociated-extension case keeps its OS dialog. Both behaviors ship behind `feedbackPatchEnabled()` so the fork can be switched off to restore the official client. Unit coverage lives in `apply-inject.client.spec.tsx` (success, failure, and flag-off silent notices) and `input-bar.client.spec.tsx` (auto-dismiss clears the store; flag-off keeps it); a real-composition assertion in `apps/web/tests/produced-files.e2e.ts` clicks a chip and expects the notice.
