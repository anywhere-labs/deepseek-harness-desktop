# Agent Note: Desktop release discovery and terminal environment

Status: implemented

English | [中文](2026-08-15-desktop-release-discovery-and-terminal.zh.md)

## Problem

DSH Desktop needs two native operations that do not belong in the upstream Web presentation. Users need to discover a newer stable desktop release without monitoring the repository, and installer-only users need a terminal where the ordinary `dsh --profile desktop` plugin workflow can run without a separately installed DSH CLI or pnpm.

These operations must preserve the product boundaries established by compatibility and advanced mode. The pinned upstream checkout stays unchanged, compatibility keeps the official Web client without overrides, and the sandboxed renderer receives no Electron, Node, filesystem, process, or terminal capability. The desktop package must also avoid changing the user's global `PATH` or shell startup files.

GitHub release discovery, updater metadata, and installation are owned by the separate [Desktop GitHub updates decision](2026-08-16-desktop-github-updates.md). This note retains the composition shared with the isolated terminal and the terminal environment decision.

## Decision

Desktop-native operations are separate Cordis Host contributions around one Electron adapter. The profile composes `desktop-shell`, `desktop-terminal`, and `desktop-updates` after the ordinary Web bundle. The Electron runtime owns the physical tray and exposes an ordered item registry; each Host plugin registers its command inside `ctx.effect()` and removes it when that generation disposes. The shell retains window and mode lifecycle, while the terminal and update plugins own only their respective command state.

This Host composition is identical in compatibility and advanced mode. The terminal adds no Client face, preload bridge, Electron IPC method, or renderer-global API; the update Client uses the existing loopback carrier described in its owning decision. Tray menu construction groups contributed commands without inspecting upstream or third-party Web elements. Linux disables the terminal row in the profile, and direct activation of that Host plugin fails instead of advertising a command that cannot launch.

## Stable release update handoff

The update controller, settings contribution, GitHub metadata, platform trust requirements, release workflow, and Host-before-installer ordering are defined by the [Desktop GitHub updates decision](2026-08-16-desktop-github-updates.md). `desktop-updates` remains an effect-scoped Host contribution in the same profile generation as the shell and terminal.

## Isolated terminal environment

The launcher configures the Electron adapter once with the resolved active profile directory and DSH home before Host plugins can contribute terminal commands. On macOS and Windows, `desktop-terminal` registers **Open DSH Terminal**. Each invocation regenerates private launch files below the application's user-data `cli` directory and opens an independent system terminal with the profile directory as its working directory.

The generated `bin` directory contains `dsh`, `pnpm`, and `node` shims. They reuse the packaged Electron executable in Node mode instead of depending on a system Node installation. Electron Builder emits the production dependency tree under `app.asar.unpacked`, and the desktop CLI and pnpm shims enter that physical tree; profile fallback symlinks therefore point to real package directories rather than virtual ASAR paths. The `dsh` shim starts Node mode with `--expose-internals`, which retains the internal ESM hooks required by ordinary profiles and HMR, then enters a desktop-owned bootstrap. Within this dedicated terminal, that bootstrap supplies the profile selected when the terminal opened only when an invocation has no profile selection, including bare `dsh`, `dsh --dump-config`, and plugin subcommands; an explicit `--profile` and the upstream `web` alias remain authoritative. It then removes every casing of `ELECTRON_RUN_AS_NODE` before importing the fixed unpacked `@deepseek-ai/dsh` CLI entry. The generic Node and pnpm shims enable Node mode only in their own child process trees. The pnpm shim additionally scopes `npm_config_runtime=electron`, the packaged Electron version, and the Electron headers URL so native dependencies installed into the selected profile target the running Electron ABI.

The terminal child starts with Electron Node mode removed, `DSH_HOME` fixed to the launcher's active home, the desktop profile as its working directory, and the generated `bin` directory prepended only to that child's `PATH`. The Electron main process environment, operating-system environment, and user shell files are not modified. The welcome text identifies the DSH Desktop version, profile, profile directory, and DSH home, then shows a configuration dump plus plugin add, remove, and update commands and the required application-restart reminder.

On macOS, LaunchServices opens a generated `welcome.command`. The controlled interactive zsh or bash startup reads the user's ordinary interactive rc file first, then removes Electron Node mode and restores the desktop-owned home and shim path so a user rc cannot accidentally discard them. On Windows, the launcher resolves PowerShell 7, Windows PowerShell, then Command Prompt and prefers a new Windows Terminal window to host the selected shell. If `wt.exe` is unavailable, a generated batch broker uses the built-in `start` command to allocate a visible console. Windows command files and the PowerShell welcome source contain ASCII only; localized profile names and paths cross into them through the Unicode child environment instead of depending on the active code page. The Electron process invokes every launcher with an executable plus argv and `shell: false`; synchronous launch failures, asynchronous spawn errors, and unsuccessful broker exits reach a native error dialog. The generated PowerShell or batch welcome file performs the final environment setup.

The system terminal is an explicit local-user capability, not a renderer or model capability. Web content cannot invoke the command through JavaScript, and no raw process handle or terminal stream crosses the loopback Web carrier. Plugin installation still executes with the local user's ordinary authority and changes the persistent desktop profile, so the welcome text requires a desktop restart before the active Cordis generation can use those changes.

## Verification

Update verification belongs to the [Desktop GitHub updates decision](2026-08-16-desktop-github-updates.md). The shared tray registry remains covered here through ordered, refreshable, and disposable Host contributions without opening a real window.

Headless terminal tests inspect generated macOS and Windows files, quoting of spaces and shell metacharacters, ASCII Windows templates carrying localized paths through the child environment, private POSIX modes, `DSH_HOME` and `PATH` isolation, `--expose-internals`, default-desktop argument injection without overriding explicit profiles or the `web` alias, removal of inherited Electron Node mode, interactive shell startup, Windows Terminal selection, the visible-console broker, PowerShell and Command Prompt fallback, launcher error handling, and fail-loud rejection of unsupported platforms or unsafe generated-script values. The packaged-runtime gate requires the terminal and update modules plus desktop CLI bootstrap in `app.asar`, and requires the upstream DSH CLI, Web runtime sentinels, and bundled pnpm entry as physical files under `app.asar.unpacked` before signing.

The tests do not launch graphical terminals, display operating-system dialogs, request either production download endpoint, replace a macOS application, install a third-party native package, verify Authenticode, or execute a signed installer. Those behaviors remain target-platform checks on packaged macOS and Windows artifacts.

## Alternatives considered

**Embed a terminal in the Web renderer.** An embedded terminal would require a renderer UI, preload and IPC protocol, pseudo-terminal ownership, process teardown, and a larger security surface. The requested plugin-management workflow needs only an explicit system terminal with a controlled environment.

**Spawn PowerShell or Command Prompt as a detached Electron child.** Electron's embedded Node process hides console children, while the Windows detached-process flag does not allocate a new console. That combination can leave an interactive shell running without a visible window. Windows Terminal is therefore the primary host, with a generated `cmd start` broker as the compatibility fallback.

**Modify the user's global `PATH` or shell rc.** Global mutation would outlive the application, create conflicts with other DSH or Node installations, and need an uninstall repair path. Private generated shims keep ownership and cleanup within DSH Desktop.

**Require system Node, DSH, and pnpm.** That would preserve the installer-only gap this feature is intended to close and make behavior depend on unrelated host versions. The packaged Electron Node mode and bundled CLI entries provide a version-matched environment.

**Hardcode every command in the Electron tray builder.** A monolithic native menu would couple unrelated operations and bypass Cordis disposal. Effect-scoped item registration preserves plugin ownership, deterministic ordering, and future Host composition.

## Consequences

Packaged DSH Desktop provides the ordinary desktop-profile plugin workflow without changing the upstream checkout, weakening renderer isolation, or modifying global shell state. The generated CLI environment remains local to terminals opened from the tray.

The desktop package owns the bundled pnpm version and generated shim behavior, which increases the packaged runtime closure and must remain aligned with Electron's ABI. Linux retains compatibility but has no desktop terminal until a separate platform design is implemented. Update consequences belong to the [Desktop GitHub updates decision](2026-08-16-desktop-github-updates.md).
