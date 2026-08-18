# Agent Note: Desktop compatibility mode

Status: implemented

English | [中文](2026-08-15-desktop-compatibility-mode.zh.md)

## Problem

DSH Desktop needs native application lifecycle while compatibility mode remains the unmodified official Web presentation. The package must still publish a Client face because advanced mode uses desktop-owned presentation, but loading that same artifact in compatibility must not make the safe path depend on product-owned root, layout, sidebar, or styles.

## Decision

The `desktop-shell` Cordis row exposes `mode: compatibility | advanced`, and the standard `dsh-desktop` settings namespace defaults `mode` to `compatibility`. The desktop package declares both `dsh.bundle` and `dsh.client`; its Client face is discovered in both modes.

In compatibility mode, the Client validates the Host-supplied mode and platform URL markers, then returns without installing any effects. It does not provide or replace the `layout` service, register a `root` or `sidebar` occupant, install styles, or alter the conversation surface. Only an advanced generation calls the advanced-shell installer.

The final compatibility composition keeps the official `ui-layout`, `ui-sidebar`, and `ui-conversation` Loader rows enabled. The official `dsh-web-app` graph therefore owns the root and complete presentation. The validated URL markers let the shared Client artifact select its bounded branch without exposing any Electron capability.

The persistent `desktop` profile still contains `dsh-base`, `dsh-web-app`, and user-installed bundles in their preserved order. Third-party client plugins use ordinary `dsh.client` metadata and are discovered by the official Web client module graph. Electron does not maintain a second plugin roster.

The launcher adds one platform safety overlay after user patches. On Windows it pins the browse directory-picker row so the complete in-app panel remains available. The desktop workspace patches that panel with one icon-only native chooser action backed by a same-origin desktop route and Electron `dialog.showOpenDialog`; it does not load the upstream koffi worker in the Electron process. macOS and Linux keep the upstream adaptive row.

The `desktop-shell` row registers a native shell specification while the profile is activating. It does not await global Loader settlement from inside its own Loader entry. The launcher mounts that registration only after `app-boot` returns, which preserves the activation audit and complete official, desktop, and third-party client manifest before the first renderer request.

## Mode persistence and restart boundary

The DSH home `settings.yaml` document is the single durable source for `dsh-desktop.mode`. The launcher reads the file resolved by the active `dsh-settings-file` row before composition. The Host plugin registers the same namespace and schema with the standard settings service and declares `applies: restart`. There is no second value in the profile manifest.

Users select the other mode from the application tray or edit the same `settings.yaml` document by hand. The tray calls the registered scope's narrow `settings.update({ mode })` path, while the file provider observes manual changes. A watcher compares the committed mode with the active generation and requests one orderly restart when they differ.

Cordis disposal releases Client effects, Host rows, the tray, and the window before the exit coordinator calls `app.relaunch()` after a successful zero-code shutdown. Compatibility never hot-replaces official slots inside a live generation. Linux keeps the tray mode command disabled and rejects advanced mode rather than silently falling back.

## Native lifecycle and security

The compatibility adapter creates a normal `BrowserWindow` and omits custom-frame, title-bar, transparency, vibrancy, and native-material options. macOS suppresses visible page-title updates. Windows retains its native caption icon and fixed `DeepSeek Harness Desktop` caption while removing the window menu bar. The operating system owns native title-bar color and appearance.

The application keeps the unmodified iOS Default icon on Windows and Linux. macOS uses a build-derived copy with a transparent visual inset, and the same platform-selected path feeds packaging, the live Dock, and the window specification. The tray uses a macOS template derived from the brand SVG and fixed brand-blue images on Windows and Linux. Compatibility retains renderer isolation, the Chromium sandbox, disabled Node integration, exact-origin navigation, tray ownership, close-to-hide behavior, single-instance activation, and bounded Cordis disposal on explicit quit.

## Verification

Package tests require the `./client` export and ordinary `dsh.client` dependency edges. Profile tests verify that compatibility keeps the official layout, sidebar, and conversation rows enabled and composes the Windows browse picker. Route, runtime, and client-bridge tests cover same-origin validation, native-dialog selection and cancellation, and the panel bridge lifecycle. Client tests also validate the mode and platform markers, scoped advanced layout behavior, and presentation isolation.

Host tests verify standard namespace registration, the narrow tray `settings.update({ mode })` path, restart only after a changed value, and Linux validation before persistence. Runtime tests verify that registration does not re-enter Loader settlement and that `BrowserWindow` construction starts only after the launcher mounts the registered generation. Window-option tests reject advanced-native options from the compatibility constructor.

Headless Loader smokes activate the Host shell and a profile-local third-party plugin, then boot the published Web profile without importing Electron or opening a window. The desktop deploy root directly supplies every required first-party peer in its production dependency graph; a closure check rejects missing declarations.

## Alternatives considered

**Publish a separate Client identity only for advanced mode.** That would split one package's browser artifact across profile-specific identities and add another roster rule. A shared artifact with a validated, effect-free compatibility branch keeps package discovery ordinary and makes the boundary explicit.

**Let the desktop Client replace root or sidebar in both modes.** Shared presentation ownership would make compatibility depend on the advanced shell and reduce its value as the upstream-reference path. The advanced installer is therefore called only for an advanced generation.

**Patch the official UI.** An upstream patch would violate the pinned-submodule boundary and make browser DSH aware of Electron product policy. Compatibility instead leaves the official presentation graph intact.

**Ship a copied Web frontend inside the Electron package.** A copied client roster would duplicate Cordis composition and require desktop releases to track every upstream client change. Compatibility instead loads the active profile's official Web surface.

**Open the window as soon as the Web server binds.** A bound socket supplies an authoritative port but does not prove that the frontend fallback, boot-manifest injection, or later client entries are active. The launcher therefore uses completed `app-boot` activation as the mount point.

**Hot-swap modes after a settings change.** The modes differ in Loader rows, service ownership, root slot declarations, and native `BrowserWindow` options. Restarting at the settings boundary gives one coherent generation instead of mutating those axes independently.

## Consequences

Compatibility mode remains the upstream-reference presentation and gains native lifecycle without desktop-owned renderer presentation. It tracks official UI and third-party client behavior while persistence and restart policy stay in the Host standard settings service.

The compatibility client graph includes the desktop Client artifact and validated environment markers, but that artifact is effect-free after validation. Frameless windows, translucent materials, desktop geometry, theme projection, and renderer chrome remain exclusive to the separately documented [advanced shell](2026-08-15-desktop-advanced-shell.md).
