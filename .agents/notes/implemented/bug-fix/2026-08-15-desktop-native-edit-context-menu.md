# Agent Note: Native desktop edit context menu

English | [中文](2026-08-15-desktop-native-edit-context-menu.zh.md)

Status: implemented

## Problem

The desktop application hides its application menu and the reused Web renderer does not provide a context menu. Mouse users therefore cannot discover or invoke standard text editing actions such as paste from an editable field, even though the corresponding keyboard shortcuts remain available.

## Decision

The Electron main process handles the renderer's `context-menu` event and builds an operating-system-native menu from `ContextMenuParams.editFlags`. Editable fields expose undo, redo, cut, copy, paste, delete, and select all with the availability reported by Chromium. Read-only content exposes copy for a non-empty selection and select all when Chromium permits it.

The menu uses Electron roles, so edit commands target the focused renderer frame without a preload bridge or additional renderer permissions. Link, media, download, navigation, and developer actions remain outside this text-editing menu.

## Alternatives considered

**Build a custom menu in the Web renderer.** This would duplicate platform menu behavior and require Web UI state, styling, accessibility, and layering work for a desktop-only capability.

**Restore a visible application Edit menu.** A global menu would make the commands available but would not satisfy the pointer-local interaction requested by desktop users, and it would change the intentionally hidden application chrome.

## Consequences

Desktop users receive familiar pointer access to text editing while the renderer remains isolated and sandboxed. The menu deliberately follows Chromium's edit availability, so an action that cannot apply stays disabled or absent. Unit tests pin menu composition independently from Electron window startup; packaged interaction remains covered by platform smoke testing.
