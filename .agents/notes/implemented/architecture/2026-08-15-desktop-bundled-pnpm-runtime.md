# Agent Note: Bundled pnpm for desktop plugins

English | [中文](2026-08-15-desktop-bundled-pnpm-runtime.zh.md)

## Problem

DSH Desktop packages pnpm so the generated DSH terminal can manage profile plugins without a system Node.js installation. That terminal owns a child-specific `PATH`, so Cordis Host plugins and subprocesses started by the running desktop generation cannot discover the bundled package manager. A plugin that invokes `pnpm` would therefore behave differently in the terminal and in the application runtime.

The solution must not put Electron's Node mode into the Host environment. `ELECTRON_RUN_AS_NODE` changes how Electron executables start and can break unrelated Electron children when inherited. Exposing the terminal's complete command directory would also shadow a user's `node` and `dsh` commands for every plugin process.

## Decision

On packaged macOS and Linux launches, the launcher first runs the configured absolute `zsh`, `bash`, or `fish` in interactive login mode. It recovers the final exported `PATH` and fills only missing locale, toolchain, package-manager, and virtual-environment values from a fixed allowlist. Capture input and output reuse the upstream subprocess scrub, while explicit launch values remain authoritative except for `PATH`. Unsupported shells and failed, oversized, malformed, or timed-out captures retain the inherited environment.

The launcher then captures the layered launch-environment snapshot, generates a private runtime-command directory below Electron user data, and prepends only its public `pnpm` command directory to the Electron main process `PATH` before profile preparation and Cordis boot. The immutable launch snapshot records the effective startup environment after any packaged-Unix shell recovery but before Desktop adds its generated command directory. Direct third-party libraries and the DSH subprocess provider inherit that runtime command through `process.env`.

The public runtime directory contains only `pnpm` on POSIX or `pnpm.cmd` on Windows. A sibling private helper directory contains the Electron-backed `node` command used by pnpm lifecycle scripts. The pnpm wrapper prepends that helper only inside its own child environment, sets `NODE` so pnpm derives `npm_node_execpath` from the helper instead of Electron's executable, and locally supplies the Electron runtime, target version, and headers URL used to build native dependencies for the Host runtime.

Electron Node mode is set only while the signed application executable starts as Node. A generated prelude removes every casing of `ELECTRON_RUN_AS_NODE` before pnpm or a lifecycle script runs, so descendants do not accidentally start unrelated Electron applications in Node mode. Electron Node mode and the npm ABI variables are scoped to the pnpm subprocess tree; the bundled runtime does not add `ELECTRON_RUN_AS_NODE`, npm configuration, `PNPM_HOME`, `node`, or `dsh` to the ordinary Host environment. A user's allowlisted login-shell export may independently supply `PNPM_HOME`; that value remains below the product's public pnpm shim in `PATH`.

The command-path installation returns an idempotent disposer owned by the Host Cordis fiber. It removes the generated directory from the current process `PATH` and preserves unrelated environment values. It also runs explicitly on partial boot failures. No system PATH, shell startup file, profile manifest, profile patch, or `.env` document is modified.

## Verification

Focused tests cover private atomic files, crash-residue cleanup, symlink rejection, POSIX and Windows quoting, PATH key casing, idempotent installation and disposal, public-directory contents, private Node placement, and the absence of Electron Node-mode or ABI variables in the parent environment. Login-shell tests cover randomly framed capture, zsh/bash/fish invocation, deadline and size bounds, fixed-variable selection, official scrub names, explicit-launch precedence, fallback behavior, and the ordering of shell recovery, launch snapshot, and product command installation. The built CLI smoke invokes the fixed pnpm version through the generated wrapper and runs an offline lifecycle script that verifies `NODE`, `npm_node_execpath`, and the cleared Node-mode variable. Loader smoke verifies that a third-party Host plugin sees the public runtime command directory during activation while the launch snapshot remains free of the generated product command. The packaged-runtime gate requires both the runtime-environment artifact and the physical unpacked pnpm entry. A signed packaged application launched through Finder or another graphical launcher remains a target-platform smoke rather than a headless-test claim.

Windows batch commands require a command interpreter. Upstream `dsh plugin` already uses `shell: true` on Windows, and PowerShell or Command Prompt resolves `pnpm.cmd` normally. A third-party plugin that calls Node `spawn('pnpm', { shell: false })` cannot execute a batch shim reliably; a lifecycle script that directly executes its `.cmd` `npm_node_execpath` with `shell: false` has the same restriction. Complete support for those non-portable calls would require a native signed launcher and remains target-platform work.

## Alternatives considered

**Add the complete terminal shim directory to Host PATH.** This shadows `node` and `dsh` for every plugin and makes active-profile terminal policy part of unrelated Host subprocesses.

**Set Node-mode and ABI variables on the Electron process.** Every plugin and child would inherit launcher-only state, including unrelated Electron applications.

**Put the product-generated command path into the launch-environment snapshot.** The snapshot may contain the selected user login environment, but a generated product command is not an inherited, project, or user `.env` value.

**Require a system pnpm installation.** This contradicts the packaged desktop distribution and makes plugin behavior depend on the machine's Node toolchain.

## Consequences

Host plugins can resolve the pinned bundled pnpm from startup onward, including through the ordinary DSH subprocess service. User commands outside DSH Desktop remain unchanged, the plugin runtime does not acquire a global `node` replacement, and pnpm's native dependency builds target the same Electron version as the Host.
