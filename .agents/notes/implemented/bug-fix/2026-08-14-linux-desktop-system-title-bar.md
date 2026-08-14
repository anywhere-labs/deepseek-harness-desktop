# Agent Note: Linux desktop uses the standard system title bar

Status: implemented

English | [中文](2026-08-14-linux-desktop-system-title-bar.zh.md)

## Problem

The frameless Linux window shipped no system window controls. A frameless Electron window on Linux gets neither the Windows Window Controls Overlay nor the macOS traffic lights, so users could not minimize, maximize, or close the window from window chrome and had to rely on window-manager shortcuts or the tray menu. The [desktop chrome decision](../architecture/2026-08-14-electron-loopback-web-supervisor.md) kept Linux frameless because Electron provides no native glass material there, but it did not account for the missing caption buttons.

## Decision

`createWindowOptions()` in `apps/desktop/src/window-options.ts` returns a native frame (`frame: true`) for every platform except macOS, so Linux shows the standard system title bar and caption buttons. Windows keeps `titleBarStyle: 'hidden'` with the Window Controls Overlay; Linux gets no `titleBarStyle`, `titleBarOverlay`, or transparent options and renders the ordinary opaque page under the system chrome. The Web entry no longer applies the desktop presentation marker to Linux, so the client supplies no drag regions or title-bar inset there. macOS is unchanged: frameless hidden-inset traffic lights over a transparent surface.

## Verification

`apps/desktop/tests/window-options.spec.ts` pins the native frame on Linux and the unchanged macOS and Windows chrome options; `apps/web/tests/desktop-marker.spec.ts` pins that the Linux renderer stays unmarked behind its system title bar.

## Alternatives considered

**Keep Linux frameless and draw custom window controls in the page.** This preserves the custom look but requires renderer-side minimize/maximize/close buttons, IPC wiring, and per-desktop-environment placement. The standard title bar is the smallest change that restores usable window controls.

**Use the Window Controls Overlay on Linux.** The overlay is Windows-only; Electron draws no caption buttons for it on Linux.

**Leave Linux as-is pending official support.** The frameless window is already in daily use on Linux; the frame change removes a usability defect without claiming release support.

## Consequences

Linux windows regain native minimize/maximize/close behavior and draggable system chrome. The desktop presentation marker covers only macOS and Windows, so Linux pages keep the ordinary Web layout with no title-bar inset or drag bands. Frameless custom chrome and native glass material remain macOS- and Windows-only presentation.
