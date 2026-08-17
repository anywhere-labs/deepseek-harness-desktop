# Agent Note: Desktop file logging

Status: implemented

English | [中文](2026-08-16-desktop-logging.zh.md)

## Problem

The desktop Host runs the Cordis root inside the Electron main process, so every log line — `ctx.logger` output through `logger-console` and the explicit `process.stderr.write` calls in the bootstrap and Electron adapter — lands on the process stdout/stderr. In a packaged GUI application that stream is invisible, so developers and reporters cannot retrieve the logs.

## Decision

Add a Cordis `Exporter` that writes formatted log records to files under `app.getPath('userData')/logs/`, registered through `ctx.logger.exporter(...)` in the desktop bootstrap. It does not wrap or redirect `console.*`, `process.stdout`, or `process.stderr`.

Three modules implement it:

- `log-level.ts` — pure verbosity helpers: `LogType`, `LogLevel`, `shouldEmit(type, threshold)`, `isErrorType(type)`.
- `log-files.ts` — a synchronous append-only sink (`appendFileSync`) that writes `dsh-YYYY-MM-DD.log` (all levels) and `dsh-YYYY-MM-DD.error.log` (warn and error), rotates a file past 10MB into `.1`, `.2`, …, switches files when the local date changes, restores the active segment from disk after a restart, and deletes oldest owned files while the directory exceeds 200MB.
- `file-exporter.ts` — `FileExporter implements Exporter`, rendering each `Message` as `<local timestamp> [LEVEL] [name] <body>` via `Logger.format`, filtering by the configured threshold, and routing to the sink.

The `dsh-desktop.logLevel` settings field (`debug | info | warn | error`, default `info`) extends the existing `dsh-desktop` namespace. The bootstrap reads it once after `boot()` and subscribes to `settings/updated` to update the exporter threshold in place.

## Alternatives considered

**Wrap `console.*` or `process.stdout` / `process.stderr`.** This causes recursion when the sink itself logs, duplicates every `ctx.logger` line (once from the console exporter, once from the stream wrap), and breaks Electron's devtools and attached-debugger console. The Cordis `Exporter` seam receives structured `Message` records with type, level, timestamp, and name, so a file target needs none of that.

**A single unbounded log file.** Without per-file and directory caps, a long-running session or a noisy plugin fills the disk. The per-day naming plus 10MB rotation plus 200MB directory cap bound growth while keeping logs inspectable by date and severity.

**Reuse the console exporter's renderer.** Its colored, label-aligned output is tuned for a terminal; the file target renders a plainer timestamped line so the file stays readable in editors and paste-through.

## Consequences

Logs persist under the desktop user-data directory and can be inspected after a packaged run. The verbosity threshold is configurable per the standard settings service and applies to both the full and error files. The `logLevel` field is read at startup and on `settings/updated`, so a change applies without a restart.

A startup header line (app version, platform, Node version, run timestamp) opens each day's log, and files older than seven days are purged at launch alongside the 200MB directory cap. The cap is re-enforced while records are written, byte accounting uses UTF-8 bytes, and an oversized record is truncated on a code-point boundary. Cleanup only owns `dsh-*.log` names and tolerates disappearing or temporarily locked Windows files. A linked log directory is rejected, linked or non-file occupants are skipped, and logging initialization failure degrades to masked stderr rather than blocking application startup.

Electron-main-scope failures bypass Cordis `ctx.logger` through a `DesktopLogger` interface: the `ElectronStderrLogger` writes to the sink and mirrors to `process.stderr` for dev visibility. It is injected into `ElectronDesktopRuntime`, which routes its former `process.stderr.write` calls, the `launchWindowsUpdateInstaller` child-process errors, and the `render-process-gone` / `did-fail-load` renderer events through it. `main.ts` installs the shared fail-loud rejection path and one dedicated `uncaughtException` handler that records the first fatal error before requesting controlled shutdown. Electron `child-process-gone` events are also recorded, and child/renderer exit codes include both their signed value and hexadecimal bit pattern so Windows NTSTATUS values such as `0xc0000005` remain recognizable. Sink failures fall back to stderr and do not replace the original failure.

JavaScript handlers cannot execute after a native main-process crash. The bootstrap therefore starts Electron Crashpad with `uploadToServer: false`, keeping minidumps local, and writes an active-run marker under `userData/crash-evidence/`. Coordinated shutdown removes the marker; the next launch logs a surviving or unreadable marker as evidence that the prior process did not shut down cleanly. Crashpad or marker initialization failures are logged but do not block startup.

Every file-boundary log line passes through a secret-masking layer that covers `sk-`-style keys, long hex/base64 tokens, bearer/basic authorization, cookie headers, quoted or unquoted named secret fields (including rendered JSON), and credentials or sensitive query values in HTTP URLs.

The default profile loads `dsh-plugin-desktop/diagnostics`, which contributes an **Export Diagnostics…** native tray command on macOS and Windows. Before creating an archive, `desktopRuntime.exportDiagnostics()` shows a localized privacy confirmation explaining that logs can contain local paths and workspace/session identifiers and that crash dumps can contain fragments of process memory. Confirmed exports run in a short-lived Node worker so archive reads and compression do not block Electron's main thread. The worker prioritizes local regular `.dmp` files and then recent owned logs under a shared 50MB evidence cap, adds a system-info summary with omitted-file counts, atomically publishes the zip under `userData/diagnostics/`, rejects linked input/output/crash-dump directories, tolerates disappearing or locked files, and retains the three newest archives. The runtime coalesces concurrent requests, reveals a successful archive in the system file manager, and presents a native error dialog on failure.

A settings-page log viewer with manual clear is not yet built; it is a separate follow-up.
