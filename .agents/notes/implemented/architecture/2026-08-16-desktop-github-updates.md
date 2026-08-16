# Agent Note: Desktop GitHub updates

Status: implemented

English | [中文](2026-08-16-desktop-github-updates.zh.md)

## Problem

DSH Desktop needs a visible, actionable update path for long-lived tray processes. A single “check failed” result cannot tell a current installation from an offline machine, an incomplete GitHub Release, or a download problem. Manual replacement also leaves signed desktop packages without a direct upgrade path.

The updater must preserve the existing sandboxed renderer and Cordis lifecycle. Web content cannot receive filesystem paths, arbitrary navigation, Electron IPC, installer handles, or GitHub credentials. Installation must start only after the Host and its subprocesses have stopped.

GitHub Releases are usable as an update source only when a release contains the platform artifacts and updater metadata as one verified set. A partially uploaded release can make clients discover a version that cannot be downloaded or validated.

## Decision

DSH Desktop uses `electron-updater` with the GitHub provider fixed to `anywhere-labs/deepseek-harness-desktop`. It accepts stable upgrades only. Automatic download, install on ordinary quit, prereleases, downgrades, web installers, and differential downloads are disabled. The client never pulls source or carries a GitHub token.

The `desktop-updates` Host plugin owns one controller with `idle`, `checking`, `current`, `available`, `downloading`, `downloaded`, `error`, and `unsupported` states. It checks 60 seconds after activation and schedules the next check six hours after each completed attempt. Checks, downloads, cancellation, and installation are single-flight operations. Cancellation waits for provider cleanup before another download starts.

Target metadata declares `desktopUpdateMode: automatic | manual`. Automatic installation requires `automatic` on both the running package and the target metadata, a declared file size no larger than 1 GiB, sufficient cache volume space, and a full transfer that remains below the byte limit. A downloaded candidate remains usable across checks for the same release and is replaced when a newer release appears.

### Client and transport

The packaged renderer URL carries an `enabled` update marker. The desktop Client then registers a General-settings row and a dismissible `shell.overlay` notice. Development, unpackaged, and ordinary Web clients omit both contributions.

The Client uses the existing same-origin Connection transport and a fixed `/desktop-updates` RPC. The RPC accepts only empty-payload state, check, download, cancel, install, and open-release-page operations. Responses contain versions, progress, installation capability, and browser-safe failure categories. They contain no local paths or provider URLs. The external action opens one fixed GitHub Releases URL at most once per application process after a successful launch request.

Visible copy distinguishes the current stable version, network failure, missing GitHub updater files, insufficient storage, oversized artifacts, cancellation cleanup, installation startup, browser launch, and unknown provider failures. A missing `latest-mac.yml` or `latest.yml` offers the release page. Available and downloaded releases also create native notifications once per version in the current Host generation.

### Installation lifecycle

**Restart and update** marks the native runtime for update exit, hides the window, and requests the ordinary bounded Cordis shutdown. Host disposal releases updater RPC, timers, listeners, the active transfer, subprocess ownership, tray, and BrowserWindow before the final native exit. A successful zero-code update exit calls `quitAndInstall(false, true)`; an ordinary quit calls `app.exit` and never installs the cached release. Native handoff errors and a bounded handoff timeout fall back to a non-zero application exit.

### Release integrity

The tag-triggered release workflow accepts a stable `vMAJOR.MINOR.PATCH` tag only when both product manifests match and the tag commit belongs to `master`. Signing jobs run behind the protected `desktop-release-signing` environment. Every third-party action is pinned to a full commit SHA.

macOS publishes a signed and notarized arm64 DMG, ZIP, and `latest-mac.yml` with automatic capability. Windows publishes an x64 NSIS installer, blockmap, and `latest.yml`; a valid Authenticode build declares automatic capability, while an unsigned build declares manual capability and opens GitHub for installation. Manual Windows packaging removes certificate variables and verifies that the release artifact is unsigned.

The read-only aggregate job verifies the exact file set, version, updater URLs, file sizes, SHA-512 values, primary artifact hash, signing markers, notarization marker, and target capability. It emits SHA-256 sums and uploads one complete artifact. A separate publish job has no checkout or dependency install and receives `contents: write` only to create or resume a draft, replace its assets, and publish it. An existing public release is never replaced.

Version 2.0.1 is the bootstrap package and requires manual installation. Version 2.0.2 and later can use the complete automatic path when both artifacts declare automatic support.

## Verification

Controller tests cover current, available, progress, cancellation, immediate retry, byte limits, stale downloaded candidates, provider failures, listener isolation, and disposal. Client tests cover each status and action, bilingual copy, polling, transport failure, and omission from non-desktop environments. Host and Electron tests cover loopback RPC payload rejection, scheduling, notifications, fixed external navigation, updater configuration, free-space policy, Host-before-installer ordering, ordinary exit, synchronous handoff failure, and handoff timeout behavior.

Packaging tests cover updater entries in the runtime archive, macOS DMG and ZIP arguments, Windows manual and signed modes, metadata marking, tag/version equality, and full artifact hashes. The release workflow still requires target-machine installation acceptance with signed consecutive versions.

## Alternatives considered

**Pull the latest Git source in the installed application.** Source checkout does not produce a signed application or preserve package dependencies, native modules, notarization, and installer identity. Release artifacts remain the only update input.

**Keep the custom redirect downloader.** That path could recognize DMG and PE containers but could not bind a release to signed updater metadata or use the platform updater handoff. `electron-updater` removes that owned protocol and consumes the artifacts Electron Builder generates.

**Always open GitHub.** This keeps installation manual on signed platforms and gives no download progress or ready-to-restart state. The fallback remains for Linux and unsigned Windows packages.

**Expose Electron IPC through a preload bridge.** The existing loopback Connection already supplies method authorization, lifecycle ownership, and same-origin enforcement. A second transport would add another security and disposal path for one narrow feature.

**Publish platform assets directly from parallel jobs.** Clients could observe an incomplete release. The aggregate artifact and draft-first publish sequence make the visible release complete before it becomes stable.

## Consequences

Users receive explicit update status, in-app progress, cancellation, retry, and one-click installation where artifact trust permits it. Missing release metadata is a named operational state with a manual GitHub path, so it no longer collapses into a generic failure message.

Release construction now owns updater metadata, target capability, cross-platform artifact validation, and protected signing environments. macOS automatic updates depend on signing and notarization. Windows automatic updates depend on a valid Authenticode certificate; Linux and unsigned Windows remain manual. The 2.0.1 bootstrap also requires one manual transition before automatic upgrades are available.
