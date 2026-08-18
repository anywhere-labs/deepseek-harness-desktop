# Agent Note: Desktop advanced shell

Status: implemented

English | [中文](2026-08-15-desktop-advanced-shell.zh.md)

## Problem

DSH Desktop needs a native-material presentation on macOS and Windows without editing the pinned upstream checkout or copying the official Web application. The presentation changes several axes together: native window construction, root/sidebar slot ownership, the `layout` service, and document-level theme projection. Applying only part of that set, or changing it inside a running renderer, would leave Host composition and Client presentation inconsistent.

Mode selection must use one durable source whether a user chooses the application tray command or edits the settings file by hand, and every change must cross the same restart boundary.

## Decision

Advanced mode is a complete desktop-owned generation selected by `dsh-desktop.mode: advanced`. It remains on the upstream loopback Web carrier and ordinary Client module loader; only explicitly owned presentation and native-window seams change.

### One settings source

The DSH home `settings.yaml` document is the single source of truth. The launcher resolves it through the active `@deepseek-ai/dsh-settings-file` row and reads `dsh-desktop.mode` before it produces the final Loader patches. It does not persist a parallel mode in the profile manifest, Electron preferences, command-line flags, or another desktop file.

The `desktop-shell` Host plugin registers `settingsNamespace('dsh-desktop')` with a schema containing `mode: compatibility | advanced` and `applies: restart`. The tray calls that registered scope's narrow `settings.update({ mode })` path. A user may instead edit the same `settings.yaml` document directly; the file provider and registered namespace observe that one durable value.

Linux supports compatibility only. It does not mount a system tray, and an advanced value is rejected rather than being mapped to a different presentation.

### Restart is the composition boundary

A settings watcher compares the committed mode with the active generation and requests one Electron restart when they differ. The restart coordinator marks the exit for relaunch, then routes through the ordinary bounded shutdown path. Cordis disposal first releases Client effects, Host rows, the tray, and the `BrowserWindow`; `app.relaunch()` is invoked only when that generation completes a zero-code final exit. A failed generation exits without relaunch, repeated restart requests are idempotent, and the existing forced-shutdown deadline still bounds disposal.

The application never hot-swaps mode. Native material options are fixed at `BrowserWindow` construction, and the active Client graph must agree with the Loader rows and root slot declarations selected before boot.

### Advanced Client composition

After bundle, profile, and home patches are composed, the launcher verifies the expected official row identities. Its final advanced overlay disables the official `ui-layout` row and explicitly keeps `ui-sidebar` and `ui-conversation` enabled. Compatibility keeps all three official rows enabled.

The desktop Client validates the Host-supplied mode and platform URL markers before installing advanced effects. For one plugin-fiber lifetime it provides the `layout` service through Cordis reflection, backed by `DesktopLayoutState`. That service owns sidebar toggle and details open/close transitions and disappears with the same effect that installed it.

The Client registers the `root` occupant and declares child seats for `sidebar`, `conversation`, `details`, and additive `shell.overlay` entries. The unchanged official `ui-sidebar` remains the sidebar occupant and keeps ownership of its workspace, settings, and additive footer-action seats. The unchanged `ui-conversation` plugin continues to own the conversation and details surfaces. Third-party features can contribute to the same documented seats as in compatibility mode.

The desktop frame owns only geometry and chrome: a collapsible sidebar column, a center floor, an optional details column, resize handles, and native drag regions. It does not copy sidebar controls, session, workspace, conversation, settings, or feature state.

### Theme projection

Disabling official layout removes the presentation layer that normally projects the active theme onto the document. Advanced mode therefore includes a narrow `DesktopThemePresenter`. It reads the ordinary upstream theme service, applies its resolved color scheme and token values to the document, maintains the dark-theme marker and `theme-color` metadata, and subscribes to standard `theme/change` events. Disposal removes only the attributes, tokens, and metadata owned by that presenter.

The native adapter separately reads the registered `ui-theme.preference` after Host boot settles and applies its built-in `light`, `dark`, or `system` value to Electron before constructing an advanced window. It observes committed preference changes for the active generation so macOS vibrancy and Windows native material use the same appearance source as the built-in Client theme. Releasing the generation restores the preceding Electron appearance. A client-only third-party theme id has no Host preference to mirror and therefore does not change native material appearance.

### Native materials

On macOS the advanced `BrowserWindow` uses `titleBarStyle: hiddenInset`, positioned traffic lights, a transparent background, `vibrancy: sidebar`, and `visualEffectState: followWindow`. The renderer keeps a transparent sidebar surface over the native vibrancy and adds a traffic-light inset around the official sidebar. Its 90 CSS-pixel collapsed column centers the official 56-pixel rail. The sidebar surface is non-draggable, while a desktop-owned transparent strip above its content and to the right of the traffic lights provides a 32 CSS-pixel window drag target. A separate caption row reserves 20 CSS pixels above the conversation and details columns, while its transparent native drag hit region also remains 32 CSS pixels high. The desktop shell therefore keeps the compact visual inset without inspecting or rearranging feature-owned Header nodes. Semantic controls and explicit no-drag contributions remain interactive; custom pointer targets in the top 32 pixels must opt out of the native drag region.

The desktop sidebar surface scopes the official sidebar-fill token to transparent. The official sidebar and session list keep their component behavior, scrolling, spacing, and fade without painting the opaque Web fill over native material.

On Windows the advanced window uses a hidden title bar with native title-bar overlay controls, a transparent background, `backgroundMaterial: mica`, native shadow, rounded corners, and a thick resizable frame. Electron supports the system-drawn material on Windows 11 22H2 and later. The official sidebar retains compatibility geometry and transitions, including its 56-pixel compact rail and 280-pixel default expanded width, while its transparent surface reveals Mica. The desktop frame owns a standard-height 32 CSS-pixel caption row across its conversation and details columns, reserves the native-control area inside that row, and places both complete slot surfaces on the next row. This caption geometry does not inspect or rearrange feature-owned header nodes, so upstream and third-party slot contributions move together. Controls, inputs, dialogs, and interactive content remain non-draggable.

Advanced mode is unsupported on Linux. The Host validation, tray, and native window constructor enforce the same boundary instead of silently falling back.

## Security and carrier boundary

Advanced mode does not add a preload script, Electron IPC transport, or Node capability to the renderer. It retains `contextIsolation`, the Chromium sandbox, disabled Node integration, exact-loopback-origin navigation, and external-link delegation to the operating system. The HTTP/WebSocket carrier and third-party package discovery remain the same as compatibility mode.

## Verification

Profile tests write `dsh-desktop.mode: advanced` to a temporary `settings.yaml` and verify projection into `desktop-shell`, disabled official layout, and enabled official sidebar and conversation rows. Host tests cover the shared settings namespace, changed-value restart, tray update path, and pre-persistence Linux rejection. Client tests cover environment validation, scoped layout-service disposal, platform-specific rail geometry, Windows outer-slot caption geometry, and theme projection. Type checking validates the desktop declarations against the published rc.6 slot and service contracts.

Window-option and Electron-runtime tests verify macOS hidden-inset vibrancy, Windows Mica/native controls, built-in native-theme initialization and live updates, generation-scoped appearance restoration, Linux rejection, and the tray's opposite-mode update. Shutdown tests verify relaunch only after successful zero-code disposal and no relaunch for a failed generation. Client and Host bundles build headlessly; graphical native-material appearance remains a target-machine verification boundary.

## Alternatives considered

**Patch the official layout or sidebar in place.** This would modify upstream-owned implementation or make browser DSH depend on Electron presentation rules. Replacing only the layout row and hosting the official sidebar inside a transparent desktop-owned surface preserves component compatibility.

**Keep official layout active and shadow only its root occupant.** The official plugin would still provide the `layout` service and own root child declarations, creating split ownership and ambiguous disposal. Advanced mode replaces that service and root declaration while leaving the independent sidebar occupant active.

**Copy conversation, workspace, or other feature surfaces into the desktop package.** Those are feature surfaces, not desktop chrome. Keeping their official plugins active avoids duplicated state and lets upstream and third-party improvements flow into the desktop composition.

**Write a separate Electron preference from the tray.** Two stores could disagree. The tray therefore updates the Host's registered `dsh-desktop` namespace, and manual edits target the same `settings.yaml` document.

**Hot-reload the Client shell after changing mode.** This cannot atomically reconstruct native window materials, Loader rows, service ownership, and root declarations. A bounded relaunch is the smallest coherent transition.

**Offer advanced mode on Linux without native materials.** Persisting one mode name with materially different platform semantics would make configuration misleading. Linux exposes compatibility only until an explicit Linux advanced design exists.

## Consequences

DSH Desktop gains a native-material macOS and Windows presentation without modifying the upstream submodule, copying the Web application, or introducing a second plugin or transport system. Tray changes and manual `settings.yaml` edits converge on one durable value, and a restart creates a coherent Host, Client, and native-window generation.

The desktop package now owns real Client presentation code and must track the published slot, theme, and service contracts it uses. Advanced mode deliberately has a different presentation-row composition from browser Web and compatibility mode. Native appearance also depends on operating-system support and must be verified on real target machines; Linux remains compatibility-only.
