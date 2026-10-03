/** Desktop settings section styles, installed independently of presentation mode. */
import { DESKTOP_PACKAGE_NAME } from '../product-identity.ts'

const STYLE_ID = 'dsh-desktop-settings-styles'

const CSS = `
.dshDesktopSettings {
  display: flex;
  flex-direction: column;
  gap: 24px;
  width: min(100%, 880px);
  padding: 2px 0 36px;
  color: var(--dsw-alias-label-primary);
}
.dshDesktopSettingsHeader h2,
.dshDesktopSettingsGroup h3 {
  margin: 0;
  font-weight: 600;
}
.dshDesktopSettingsHeader h2 { font-size: 22px; line-height: 1.35; }
.dshDesktopSettingsGroup h3 { font-size: 16px; line-height: 1.4; }
.dshDesktopSettingsHeader p,
.dshDesktopSettingsGroupIntro,
.dshDesktopSettingsHint {
  margin: 6px 0 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 1.6;
}
.dshDesktopSettingsGroup {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-top: 20px;
  border-top: 1px solid var(--dsw-alias-border-l1);
}
.dshDesktopSettingsList { display: grid; gap: 8px; }
.dshDesktopSettingsChoice,
.dshDesktopSettingsToggleRow {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-width: 0;
  padding: 13px 14px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
}
.dshDesktopSettingsChoice {
  box-sizing: border-box;
  width: 100%;
  color: inherit;
  cursor: default;
  text-align: left;
  font: inherit;
}
.dshDesktopSettingsChoice[data-actionable="true"] { cursor: pointer; }
.dshDesktopSettingsChoice[data-actionable="true"]:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dshDesktopSettingsChoice:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 2px;
}
.dshDesktopSettingsChoice[data-selected="true"] {
  border-color: var(--dsw-alias-brand-primary);
  box-shadow: 0 0 0 1px var(--dsw-alias-brand-primary);
}
.dshDesktopSettingsChoice[aria-disabled="true"]:not([data-selected="true"]) { opacity: .58; }
.dshDesktopSettingsChoiceCopy { display: block; flex: 1; min-width: 0; }
.dshDesktopSettingsToggleLabel { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.dshDesktopSettingsChoiceAside { flex: 0 0 auto; margin-left: 12px; }
.dshDesktopSettingsDeleteConfirm { display: flex; align-items: flex-end; flex-direction: column; gap: 8px; max-width: 320px; }
.dshDesktopSettingsDeleteWarning { color: var(--dsw-alias-state-warning-primary); font-size: 12px; line-height: 1.4; text-align: right; }
.dshDesktopSettingsDeleteActions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
.dshDesktopSettingsChoiceTitle {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 14px;
  font-weight: 500;
}
.dshDesktopSettingsChoiceBody {
  display: block;
  margin-top: 3px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 1.5;
}
.dshDesktopSettingsChoiceLink {
  color: var(--dsw-alias-brand-primary);
  text-decoration: underline;
  text-decoration-thickness: 1px;
  text-underline-offset: 2px;
}
.dshDesktopSettingsChoiceLink:hover { text-decoration-thickness: 2px; }
.dshDesktopSettingsChoiceTitle .dshDesktopSettingsChoiceLink {
  text-decoration: none;
}
.dshDesktopSettingsChoiceTitle .dshDesktopSettingsChoiceLink:hover {
  opacity: .82;
}
.dshDesktopSettingsBadge {
  display: inline-flex;
  align-items: center;
  min-height: 20px;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  font-weight: 400;
}
.dshDesktopSettingsForm {
  display: flex;
  align-items: flex-end;
  gap: 10px;
}
.dshDesktopSettingsField {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
}
.dshDesktopSettingsField > span { width: 100%; }
.dshDesktopSettingsInput {
  width: 100%;
  min-height: 36px;
  box-sizing: border-box;
  padding: 7px 11px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  outline: none;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
}
.dshDesktopSettingsInput:focus-visible {
  border-color: var(--dsw-alias-brand-primary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-brand-primary) 20%, transparent);
}
.dshDesktopSettingsButton {
  flex: 0 0 auto;
  min-height: 32px;
  padding: 5px 13px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 999px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
}
.dshDesktopSettingsButton:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dshDesktopSettingsButtonSecondary { color: var(--dsw-alias-label-secondary); }
.dshDesktopSettingsButtonDanger { color: var(--dsw-alias-state-error-primary); }
.dshDesktopSettingsButton:disabled { cursor: default; opacity: .55; }
.dshDesktopNativeActions[data-placement="settings"] {
  display: flex;
  align-items: center;
  gap: 8px;
}
.dshDesktopNativeActions[data-placement="settings"] .dshDesktopNativeActionMenuAnchor { position: relative; }
.dshDesktopNativeActions[data-placement="settings"] .dshDesktopActionMenu {
  position: absolute;
  z-index: 2147483001;
  top: calc(100% + 5px);
  right: 0;
  display: grid;
  grid-auto-flow: row;
  grid-template-columns: minmax(0, 1fr);
  min-width: 220px;
  padding: 5px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: 0 12px 32px color-mix(in srgb, #000 28%, transparent);
  -webkit-app-region: no-drag;
}
.dshDesktopNativeActions[data-placement="settings"] .dshDesktopActionMenuItem {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
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
  white-space: nowrap;
}
.dshDesktopNativeActions[data-placement="settings"] .dshDesktopActionMenuItem:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dshDesktopNativeActions[data-placement="settings"] .dshDesktopActionMenuItem:disabled { cursor: default; opacity: .45; }
.dshDesktopNativeActions[data-placement="settings"] .dshDesktopActionMenuItem svg { width: 14px; height: 14px; stroke-width: 1.8; }
.dshDesktopNativeActions[data-placement="settings"] .dshDesktopActionMenuItem span { flex: 1; }
.dshDesktopSettingsHeaderButton {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 14px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  line-height: 18px;
}
.dshDesktopSettingsHeaderButton svg { width: 14px; height: 14px; margin-left: 5px; }
.dshDesktopSettingsHeaderButton:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dshDesktopSettingsHeaderButton:disabled { cursor: not-allowed; opacity: .4; }
.dshDesktopNativeActionError {
  max-width: 260px;
  color: var(--dsw-alias-state-error-primary);
  font-size: 11px;
  line-height: 1.4;
}
.dshDesktopSettingsMaterialField {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 14px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
}
.dshDesktopSettingsMaterialCopy { min-width: 0; }
.dshDesktopSettingsSelect {
  flex: 0 0 auto;
  min-width: 150px;
  min-height: 32px;
  padding: 4px 28px 4px 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
}
.dshDesktopSettingsSelect:disabled { opacity: .55; }
.dshDesktopSettingsNotice,
.dshDesktopSettingsError,
.dshDesktopSettingsSuccess {
  margin: 0;
  padding: 10px 12px;
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.55;
}
.dshDesktopSettingsNotice { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); }
.dshDesktopSettingsError { color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); }
.dshDesktopSettingsSuccess { color: var(--dsw-alias-state-success-primary); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent); }
.dshDesktopSettingsToggle {
  flex: 0 0 auto;
  position: relative;
  width: 40px;
  height: 22px;
  padding: 2px;
  border: none;
  border-radius: 999px;
  background: var(--dsw-alias-border-l2);
  cursor: pointer;
  transition: background-color var(--ds-transition-duration-fast) var(--ds-ease-in-out);
}
.dshDesktopSettingsToggle[aria-checked="true"] {
  background: var(--dsw-alias-brand-primary);
}
.dshDesktopSettingsToggle:disabled { cursor: default; opacity: .5; }
.dshDesktopSettingsToggle:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 2px;
}
.dshDesktopSettingsToggleKnob {
  display: block;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--dsw-alias-label-primary-foreground);
  box-shadow: 0 1px 2px rgba(0, 0, 0, .24);
  transform: translateX(0);
  transition: transform var(--ds-transition-duration-fast) var(--ds-ease-in-out);
}
.dshDesktopSettingsToggle[aria-checked="true"] .dshDesktopSettingsToggleKnob {
  transform: translateX(18px);
}
.dshDesktopSettingsDetails {
  display: grid;
  gap: 8px;
  padding-left: 14px;
  border-left: 2px solid var(--dsw-alias-border-l1);
}
.dshDesktopSettingsUpdateRow {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 13px 14px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
}
.dshDesktopSettingsLanStatus {
  display: grid;
  gap: 3px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
}
.dshDesktopSettingsLanStatus[data-state="ready"] .dshDesktopSettingsBadge {
  color: var(--dsw-alias-state-success-primary);
}
.dshDesktopSettingsLanStatus[data-state="failed"] .dshDesktopSettingsBadge {
  color: var(--dsw-alias-state-error-primary);
}
.dshDesktopSettingsLanStatus code,
.dshDesktopSettingsLanFingerprint code {
  overflow-wrap: anywhere;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 11px;
}
.dshDesktopSettingsLanFingerprint {
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 1.5;
}
.dshDesktopCopilotCard {
  display: grid;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 9px;
  background: var(--dsw-alias-bg-layer-1);
}
.dshDesktopCopilotCopy strong { font-size: 13px; font-weight: 600; }
.dshDesktopCopilotCopy p,
.dshDesktopCopilotStatus,
.dshDesktopCopilotNotice p {
  margin: 4px 0 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 1.5;
}
.dshDesktopCopilotNotice {
  display: grid;
  gap: 7px;
  padding: 10px;
  border-radius: 7px;
  background: var(--dsw-alias-bg-layer-2);
}
.dshDesktopCopilotNotice a { color: var(--dsw-alias-brand-primary); font-size: 12px; }
.dshDesktopCopilotCode {
  width: fit-content;
  padding: 5px 9px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 6px;
  color: var(--dsw-alias-label-primary);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 18px;
  font-weight: 700;
  letter-spacing: .08em;
}
.dshDesktopCopilotPrompt,
.dshDesktopCopilotPrompt label { display: grid; gap: 8px; }
.dshDesktopCopilotPrompt label { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dshDesktopCopilotPrompt input,
.dshDesktopCopilotPrompt select {
  min-width: 0;
  min-height: 34px;
  box-sizing: border-box;
  padding: 6px 9px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 7px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
}
.dshDesktopCopilotActions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 7px; }
.dshDesktopCopilotButton {
  min-height: 30px;
  padding: 4px 11px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 999px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
}
.dshDesktopCopilotButton:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dshDesktopCopilotButton:disabled { cursor: default; opacity: .5; }
.dshDesktopCopilotButtonSecondary { color: var(--dsw-alias-label-secondary); }
.dshDesktopCopilotModels { display: grid; gap: 8px; font-size: 12px; }
.dshDesktopCopilotModels > strong { font-size: 12px; font-weight: 600; }
.dshDesktopCopilotModels > p { margin: 0; color: var(--dsw-alias-label-secondary); }
.dshDesktopCopilotModels > ul { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
.dshDesktopCopilotModels li {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 12px;
  min-width: 0;
  padding: 7px 9px;
  border-radius: 7px;
  background: var(--dsw-alias-bg-layer-2);
  overflow-wrap: anywhere;
}
.dshDesktopCopilotBadges {
  display: inline-flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 4px;
}
.dshDesktopCopilotCategory {
  flex: 0 0 auto;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-secondary);
}
.dshDesktopCopilotModels > .dshDesktopCopilotButton { justify-self: start; }
.dshDesktopCopilotError { margin: 0; color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 1.5; }
.dshDesktopSettingsUrls {
  display: grid;
  gap: 5px;
  padding: 12px 14px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1);
}
.dshDesktopSettingsUrls a {
  width: fit-content;
  max-width: 100%;
  overflow-wrap: anywhere;
  color: var(--dsw-alias-brand-primary);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
}
.dshDesktopSettingsUrlRow {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
}
.dshDesktopSettingsUrlRow a {
  flex: 1;
  min-width: 0;
  width: auto;
  white-space: nowrap;
  overflow-x: auto;
  overflow-wrap: normal;
  padding-block: 4px;
  text-decoration: none;
}
.dshDesktopSettingsUrlCopy {
  display: grid;
  place-items: center;
  flex: none;
  width: 32px;
  height: 32px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.dshDesktopSettingsUrlCopy:hover { background: var(--dsw-alias-bg-layer-2); }
.dshDesktopSettingsUrlCopy:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.dshDesktopSettingsUrlCopy:disabled { opacity: 0.5; cursor: wait; }
.dshDesktopSettingsDialogBackdrop {
  position: fixed;
  z-index: 2147483002;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 24px;
  background: color-mix(in srgb, #000 55%, transparent);
}
.dshDesktopSettingsDialog {
  width: min(440px, 100%);
  box-sizing: border-box;
  padding: 20px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 14px;
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: 0 24px 64px color-mix(in srgb, #000 38%, transparent);
}
.dshDesktopSettingsDialog h3 { margin: 0; color: var(--dsw-alias-state-error-primary); font-size: 16px; }
.dshDesktopSettingsDialog p { margin: 12px 0 0; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 1.65; }
.dshDesktopSettingsDialogActions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }
@media (max-width: 720px) {
  .dshDesktopSettingsChoice,
  .dshDesktopSettingsUpdateRow,
  .dshDesktopSettingsToggleRow { align-items: flex-start; }
  .dshDesktopSettingsForm { align-items: stretch; flex-direction: column; }
}
`

/** Install one scoped stylesheet; tolerate headless Client boot. */
export function installDesktopSettingsStyles(owner: string = DESKTOP_PACKAGE_NAME): () => void {
  if (typeof document === 'undefined') return () => {}
  const existing = document.getElementById(STYLE_ID)
  if (existing !== null) return () => {}
  const style = document.createElement('style')
  style.id = STYLE_ID
  // The upstream loader claims every untagged stylesheet for the next module
  // it materializes, then removes it when that unrelated plugin is unloaded.
  style.dataset.plugin = owner
  style.dataset.pluginCss = `${owner}/desktop-settings`
  style.textContent = CSS
  document.head.appendChild(style)
  return () => { style.remove() }
}
