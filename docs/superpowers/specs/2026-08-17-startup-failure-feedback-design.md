# Startup Failure Feedback

## Status

Approved design. Implementation is intentionally separate from this document.

## Context

The Electron bootstrap catches profile, Host, and native-shell startup failures after `app.whenReady()`, but currently reports them only to `stderr`. In a packaged GUI launch, users do not have a visible console and may see the application disappear without an explanation. The existing runtime already supports native notifications and error dialogs for later renderer/plugin failures; startup failures should use the same user-visible channels.

## Goals

- Make post-ready startup failures visible through both a system notification and a native error dialog.
- Preserve the existing profile failure marking, rollback, relaunch, and exit-code behavior.
- Persist the complete failure stack in a bounded, discoverable log file.
- Keep user-facing text concise and avoid putting a full stack or configuration content in the dialog.
- Make formatting and persistence independently testable without booting Electron.

## Non-goals

- Changing which profile is selected or how rollback decisions are made.
- Adding a recovery window, profile picker, or retry action to the startup failure dialog.
- Changing failures that occur before Electron is ready; those remain covered by the existing fail-loud process handling.
- Replacing the existing renderer boot recovery dialog.

## Design

### Failure report module

Add `dsh-plugin-desktop/src/startup-failure.ts` as a pure, Electron-independent module. It owns:

- Normalizing an `unknown` thrown value into a short message and full stack text.
- Capturing timestamp, platform, profile name, and recovery outcome.
- Building the short notification body and the detailed dialog text.
- Writing the latest report to a caller-provided log path through an injectable writer, so file I/O failure can be tested without touching the real user directory.

The report stores the absolute log path but does not copy the full stack into the notification or dialog. The dialog tells the user where the full diagnostic is located.

### Electron bootstrap integration

In `src/main.ts`, import `dialog` from Electron and call a single startup-failure reporting helper at the beginning of the existing `catch` block, after `profileStartup` has been determined but before profile state is mutated.

The integration will:

1. Resolve `app.getPath('logs')/dsh-plugin-desktop-startup.log`.
2. Build a report with the active profile and thrown cause.
3. Overwrite the log with the latest report. A failed write is sent to `stderr` and does not stop presentation.
4. Send one concise system notification through `runtime.updates.notify`.
5. Show one synchronous `dialog.showErrorBox` with the failure reason, log path, and whether the last-known-good profile will be reopened.
6. Continue through the existing state marking and shutdown/relaunch code after the dialog closes.

The existing recovery notification remains for the successful post-rollback path. The failure path will use its new combined message instead of emitting a second, duplicate recovery notification.

### User-visible behavior

The notification title is `Unable to Start DSH Desktop` and its body is limited to the profile and recovery outcome. The error dialog uses the same title and includes:

- The failed profile name.
- The error message.
- The recovery action, if any.
- The absolute startup log path.

If notifications are unsupported or either presentation call throws, the other presentation attempt still runs and the failure is written to `stderr`.

## Data flow

```text
startup catch
  -> normalize unknown cause
  -> build report (profile, platform, recovery decision, log path)
  -> write latest startup log (best effort)
  -> system notification (best effort)
  -> native error dialog (best effort)
  -> existing profile failure / rollback / shutdown flow
```

## Testing

Add `dsh-plugin-desktop/tests/startup-failure.spec.ts` covering:

- `Error` and non-`Error` thrown values.
- Stable short message and full stack generation.
- Log content and overwrite behavior.
- Writer failure being non-fatal.
- Notification and dialog text containing the profile, recovery result, and log path without embedding the full stack.

Run the targeted spec, the package typecheck, the full package Vitest suite, and the existing profile/loader smoke checks. The implementation is complete only when all of these pass.

## Acceptance criteria

- A profile boot failure after Electron readiness produces a system notification and a native error dialog before exit or relaunch.
- The dialog gives the user a concrete absolute log path.
- The latest failure log contains the complete stack and context.
- Normal startup and automatic last-known-good recovery retain their current behavior.
- Notification, dialog, or log-write failures do not mask the original startup failure.
