# Agent Note: The desktop shell owns bounded keyboard zoom

Status: implemented

English | [中文](2026-08-15-desktop-keyboard-zoom.zh.md)

## Problem

The desktop window relied on Chromium and the application menu for keyboard zoom even though the menu is hidden. On affected keyboard layouts, `Ctrl` plus did not increase the zoom while `Ctrl` minus continued decreasing it, leaving the interface too small to recover through the corresponding shortcut. Chromium also applies zoom by origin, so restarting the loopback-hosted desktop window could restore the unusable level.

## Decision

The Electron main process owns desktop keyboard zoom. Its `before-input-event` listener recognizes `Ctrl` or `Command` with `+`/`=`, `-`/`_`, and `0`, prevents Chromium's separate shortcut handling, and applies the command through `WebContents.setZoomLevel()`.

Zoom-out stops at level -3 and zoom-in stops at level 6, which keeps the scale within about 58% to 299% under Electron's `1.2 ^ level` formula. The zero shortcut restores level 0. After the loopback page finishes loading but before the hidden window is shown, the shell also restores level 0 so an origin-scoped Chromium value cannot survive a desktop restart.

The shortcut resolver and zoom arithmetic live in an Electron-independent module. The main process supplies only the keyboard event and `WebContents` operations, which lets unit tests cover layout-resolved plus and minus variants, both desktop modifiers, reset, limits, and unrelated input without launching a native window.

## Alternatives considered

- **Rely on Electron menu roles.** Zoom menu roles provide standard accelerators, but the desktop menu is hidden and the reported keyboard layout did not receive a working zoom-in path. Menu roles also do not establish the restart reset required for an already unusable same-origin zoom value.
- **Handle the shortcuts in the Web renderer.** That would make a desktop-only carrier behavior part of the shared Web client, and page handlers can run after native menu shortcuts. The Electron main process observes input before both page key events and menu shortcuts.
- **Keep Chromium's default limits and add only `Ctrl` plus.** This leaves recovery dependent on an implementation path that already behaved inconsistently and leaves the saved origin zoom unchanged after restart.

## Consequences

Desktop zoom behaves the same across supported platforms and keyboard layouts, remains usable under key repeat, and has two recovery paths: `Ctrl`/`Command` with `0`, or reopening the application. Recognized zoom shortcuts do not reach the Web page. Browser-served clients retain their existing browser-owned zoom behavior.

## Testing

The desktop zoom unit test covers `+` and `=` with Control, `+` with Command, both minus key values, upper and lower saturation, zero reset, fresh-window reset, and inputs that must remain unhandled. The desktop TypeScript programs verify that Electron's event and `WebContents` types satisfy the extracted interfaces.
