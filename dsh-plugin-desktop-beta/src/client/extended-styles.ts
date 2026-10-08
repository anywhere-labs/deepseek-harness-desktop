/** Independent frame shared by compatibility and inverted-L extended modes. */

import {
  EXTENDED_INNER_CORNER_RADIUS,
  DESKTOP_FRAME_HEIGHT,
  MACOS_TRAFFIC_LIGHT_SAFE_WIDTH,
  WINDOWS_CAPTION_CONTROLS_WIDTH,
} from '../window-chrome.ts'

const STYLE_ID = 'dsh-desktop-framed-styles'

const CSS = `
html:has(body:is([data-dsh-desktop-mode="compatibility"], [data-dsh-desktop-mode="extended"])),
body:is([data-dsh-desktop-mode="compatibility"], [data-dsh-desktop-mode="extended"]) {
  width: 100%;
  height: 100%;
}
body:is([data-dsh-desktop-mode="compatibility"], [data-dsh-desktop-mode="extended"]) {
  --dsh-desktop-frame-height: 0px;
  margin: 0;
  overflow: hidden;
  background: transparent !important;
}
body:is([data-dsh-desktop-mode="compatibility"], [data-dsh-desktop-mode="extended"]) #root {
  box-sizing: border-box;
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  width: auto;
  height: auto;
  padding-top: 0;
  overflow: hidden;
  transform: translateZ(0);
}
/* The custom frame owns the top band. A shell overlay is the containing block
   for fixed plugin surfaces, so they cannot escape into Desktop chrome. */
body:is([data-dsh-desktop-mode="compatibility"], [data-dsh-desktop-mode="extended"])
  [data-shell-overlay] {
  overflow: hidden;
  transform: translateZ(0);
}
/* Full-viewport dialogs portalled directly to body still belong to content. */
body:is([data-dsh-desktop-mode="compatibility"], [data-dsh-desktop-mode="extended"])
  > [role="presentation"]:has(> [aria-modal="true"]),
body:is([data-dsh-desktop-mode="compatibility"], [data-dsh-desktop-mode="extended"])
  > [aria-modal="true"] {
  top: var(--dsh-desktop-frame-height) !important;
  transform: translateZ(0);
}
body[data-dsh-desktop-mode="extended"] .dshDesktopSidebarSurface {
  /* #1006: never redeclare the theme-owned --dsw-specific-sidebar-fill here; background only. */
  border-right-color: transparent;
  background: transparent !important;
}
body[data-dsh-desktop-mode="extended"] .dshDesktopFrame {
  background: var(--dsh-desktop-frame-fill);
}
body[data-dsh-desktop-mode="extended"] .dshDesktopConversationSurface {
  box-sizing: border-box;
  overflow: hidden;
  border-top: 1px solid var(--dsw-alias-border-l1);
  border-left: 1px solid var(--dsw-alias-border-l1);
  border-top-left-radius: ${EXTENDED_INNER_CORNER_RADIUS}px;
  background: var(--dsw-alias-bg-base);
  background-clip: padding-box;
}
body[data-dsh-desktop-mode="extended"] .dshDesktopDetailsSurface {
  box-sizing: border-box;
  border-top: 1px solid var(--dsw-alias-border-l1);
}
body:is([data-dsh-desktop-mode="compatibility"], [data-dsh-desktop-mode="extended"])
  [data-dsh-desktop-content-viewport],
body:is([data-dsh-desktop-mode="compatibility"], [data-dsh-desktop-mode="extended"])
  [data-dsh-desktop-frame="titlebar"] {
  isolation: isolate;
}
body:is([data-dsh-desktop-mode="compatibility"], [data-dsh-desktop-mode="extended"])[data-dsh-desktop-material="off"] {
  --dsh-desktop-frame-fill: var(--dsw-alias-bg-layer-1);
}
body[data-dsh-desktop-mode="compatibility"]:not([data-dsh-desktop-material="off"]) {
  --dsh-desktop-frame-fill: color-mix(in srgb, var(--dsw-alias-bg-base) 54%, transparent);
}
body[data-dsh-desktop-mode="extended"]:not([data-dsh-desktop-material="off"]) {
  --dsh-desktop-frame-fill: color-mix(in srgb, var(--dsw-alias-bg-base) 18%, transparent);
}
.dshDesktopFrameTitlebar {
  position: fixed;
  z-index: 2147483647;
  top: 0;
  right: 0;
  left: 0;
  display: flex;
  align-items: center;
  box-sizing: border-box;
  height: ${DESKTOP_FRAME_HEIGHT}px;
  background: var(--dsh-desktop-frame-fill);
  color: var(--dsw-alias-label-primary);
  user-select: none;
  -webkit-app-region: drag;
}
.dshDesktopFrameTitlebar[data-platform="darwin"] {
  padding: 0 8px 0 ${MACOS_TRAFFIC_LIGHT_SAFE_WIDTH + 8}px;
}
.dshDesktopFrameTitlebar[data-platform="win32"] {
  padding: 0 ${WINDOWS_CAPTION_CONTROLS_WIDTH + 8}px 0 8px;
}
.dshDesktopFrameIdentity {
  position: absolute;
  left: 50%;
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
  transform: translateX(-50%);
  pointer-events: none;
}
.dshDesktopFrameProduct { font-size: 13px; font-weight: 600; white-space: nowrap; }
.dshDesktopFrameVersion {
  min-height: 22px;
  padding: 2px 5px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: default;
  font: inherit;
  font-size: 11px;
  pointer-events: auto;
  white-space: nowrap;
  -webkit-app-region: no-drag;
}
.dshDesktopFrameVersion:hover,
.dshDesktopFrameVersion[data-popup-open],
.dshDesktopFrameVersion:focus-visible {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.dshDesktopFrameVersion:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
.dshShadcnHoverCardPositioner {
  z-index: 2147483647;
  outline: none;
  -webkit-app-region: no-drag;
}
.dshShadcnHoverCardContent {
  transform-origin: var(--transform-origin);
  transition: opacity 120ms ease, transform 120ms ease;
}
.dshShadcnHoverCardContent[data-starting-style],
.dshShadcnHoverCardContent[data-ending-style] {
  opacity: 0;
  transform: scale(.98);
}
.dshDesktopVersionPopover {
  display: grid;
  gap: 9px;
  box-sizing: border-box;
  width: 210px;
  padding: 10px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: 0 12px 32px color-mix(in srgb, #000 28%, transparent);
  -webkit-app-region: no-drag;
}
.dshDesktopVersionPopoverHeader {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
}
.dshDesktopVersionPopoverHeader strong {
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  font-weight: 600;
}
.dshDesktopVersionCheckButton {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  min-height: 30px;
  padding: 5px 9px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 7px;
  background: color-mix(in srgb, var(--dsw-alias-bg-base) 48%, transparent);
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  -webkit-app-region: no-drag;
}
.dshDesktopVersionCheckButton:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dshDesktopVersionCheckButton:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
.dshDesktopVersionCheckButton:disabled { cursor: default; opacity: .55; }
.dshDesktopVersionCheckButton svg { width: 14px; height: 14px; stroke-width: 1.8; }
.dshDesktopVersionCheckError {
  color: var(--dsw-alias-state-error-primary);
  font-size: 11px;
  line-height: 1.4;
}
.dshDesktopFrameMode {
  display: inline-flex;
  align-items: center;
  min-height: 22px;
  padding: 2px 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 999px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  font: inherit;
  font-size: 11px;
  pointer-events: auto;
  white-space: nowrap;
  -webkit-app-region: no-drag;
}
.dshDesktopFrameMode:hover,
.dshDesktopFrameMode[data-popup-open],
.dshDesktopFrameMode:focus-visible {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.dshDesktopFrameMode:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
.dshDesktopModePopover {
  width: 292px;
  gap: 7px;
}
.dshDesktopModePopoverHeader {
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  font-weight: 600;
}
.dshDesktopModeOptions {
  display: grid;
  gap: 3px;
}
.dshDesktopVersionPopover .dshDesktopModeOption {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr);
  align-items: start;
  box-sizing: border-box;
  width: 100%;
  height: auto;
  min-height: 50px;
  padding: 7px 8px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
  text-align: left;
  white-space: normal;
  -webkit-app-region: no-drag;
}
.dshDesktopVersionPopover .dshDesktopModeOption:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
}
.dshDesktopVersionPopover .dshDesktopModeOption:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: -1px;
}
.dshDesktopVersionPopover .dshDesktopModeOption:disabled {
  cursor: default;
  opacity: .55;
}
.dshDesktopModeOption > svg {
  width: 16px;
  height: 16px;
  margin-top: 1px;
  stroke-width: 1.8;
}
.dshDesktopModeOptionCopy {
  display: grid;
  min-width: 0;
  gap: 2px;
}
.dshDesktopModeOptionCopy strong {
  font-size: 12px;
  font-weight: 600;
  line-height: 1.3;
}
.dshDesktopModeOptionCopy small {
  color: var(--dsw-alias-label-secondary);
  font-size: 10px;
  font-weight: 400;
  line-height: 1.35;
}
.dshDesktopFrameActions {
  position: relative;
  display: flex;
  align-items: center;
  min-width: 0;
  -webkit-app-region: no-drag;
}
.dshDesktopFrameTitlebar[data-platform="darwin"] .dshDesktopFrameActions { margin-left: auto; }
.dshDesktopFrameTitlebar[data-platform="win32"] .dshDesktopFrameActions { margin-right: auto; }
.dshDesktopNativeActions { display: flex; align-items: center; gap: 6px; -webkit-app-region: no-drag; }
.dshDesktopNativeActions[data-placement="titlebar"] {
  position: relative;
  gap: 3px;
}
.dshDesktopTitlebarIconButton {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 7px;
  background: color-mix(in srgb, var(--dsw-alias-bg-base) 34%, transparent);
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  -webkit-app-region: no-drag;
}
.dshDesktopTitlebarIconButton:hover:not(:disabled),
.dshDesktopTitlebarIconButton[aria-expanded="true"] {
  border-color: var(--dsw-alias-border-l2);
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.dshDesktopTitlebarIconButton:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
.dshDesktopTitlebarIconButton:disabled { cursor: default; opacity: .45; }
.dshDesktopTitlebarIconButton svg,
.dshDesktopActionMenuItem svg { width: 14px; height: 14px; stroke-width: 1.8; }
.dshDesktopNativeActionMenuAnchor { position: relative; }
.dshDesktopActionMenu {
  position: absolute;
  z-index: 1;
  top: calc(100% + 5px);
  display: grid;
  min-width: 190px;
  padding: 5px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: 0 12px 32px color-mix(in srgb, #000 28%, transparent);
  -webkit-app-region: no-drag;
}
.dshDesktopFrameTitlebar[data-platform="darwin"] .dshDesktopActionMenu { right: 0; }
.dshDesktopFrameTitlebar[data-platform="win32"] .dshDesktopActionMenu { left: 0; }
.dshDesktopActionMenuItem {
  display: flex;
  align-items: center;
  gap: 9px;
  min-height: 32px;
  padding: 5px 9px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  text-align: start;
}
.dshDesktopActionMenuItem:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dshDesktopActionMenuItem:disabled { cursor: default; opacity: .45; }
.dshDesktopActionMenuItem span { flex: 1; }
.dshDesktopNativeActions[data-placement="titlebar"] .dshDesktopNativeActionError {
  position: absolute;
  top: calc(100% + 5px);
  width: max-content;
  padding: 7px 9px;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, transparent);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
}
.dshDesktopFrameTitlebar[data-platform="darwin"] .dshDesktopNativeActionError { right: 0; }
.dshDesktopFrameTitlebar[data-platform="win32"] .dshDesktopNativeActionError { left: 0; }
.dshDesktopNativeActionError {
  max-width: 260px;
  color: var(--dsw-alias-state-error-primary);
  font-size: 11px;
  line-height: 1.4;
}
`

export function installExtendedStyles(): () => void {
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.dataset.plugin = 'dsh-plugin-desktop'
  style.dataset.pluginCss = 'dsh-plugin-desktop/framed-shell'
  style.textContent = CSS
  document.head.appendChild(style)
  return () => { style.remove() }
}
