/** Shared by the official Plugins page and the in-app permission dialog. */
const STYLES = `
/* The slot anchor uses display:contents, so the page's direct-child width does not reach this flex item. */
.dshNextPluginControls { box-sizing: border-box; width: 100%; max-width: 960px; min-width: 0; display: grid; gap: 32px; color: var(--dsw-alias-label-primary); }
.dshNextPluginControls .dshDesktopSettingsGroup { padding-top: 0; border-top: 0; gap: 12px; }
.dshNextPluginControls h3 { font-size: 14px; line-height: 22px; font-weight: 500; }
.dshNextPluginControls .dshDesktopSettingsHint,
.dshNextPluginControls .dshDesktopSettingsGroupIntro { font-size: 13px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.dshNextPluginControls .dshDesktopSettingsGroupIntro { margin-top: 4px; }
.dshNextMarketHeader { display: flex; align-items: center; justify-content: space-between; gap: 20px; }
.dshNextMarketHeader > div { min-width: 0; }
.dshNextMarketHeader > [role="switch"] { flex: none; }
.dshNextMarketChoices { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.dshNextPluginSections { display: grid; gap: 2px; }
.dshNextPluginCard { position: relative; display: flex; align-items: center; min-width: 0; gap: 14px; margin: 0 -8px; padding: 8px; border-radius: 12px; }
.dshNextPluginCard:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dshNextPluginIcon { display: inline-flex; flex: none; align-items: center; justify-content: center; width: 48px; height: 48px; border: .5px solid var(--dsw-alias-border-l3); border-radius: 10px; color: var(--dsw-alias-label-secondary); }
.dshNextPluginCardMain { display: grid; flex: 1; min-width: 0; gap: 4px; }
.dshNextPluginCardOpen { width: max-content; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0; border: 0; background: transparent; color: inherit; text-align: left; font: inherit; font-size: 14px; line-height: 20px; font-weight: 500; cursor: pointer; }
.dshNextPluginCardOpen::after { content: ''; position: absolute; inset: 0; border-radius: 12px; }
.dshNextPluginCardOpen:focus-visible { outline: none; }
.dshNextPluginCardOpen:focus-visible::after { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.dshNextPluginCardDescription { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-tertiary); font-size: 13px; line-height: 18px; }
.dshNextPluginCardActions { position: relative; z-index: 1; flex: none; }
.dshNextPluginCardActions .dshNextPluginDetail, .dshNextPluginCardActions .dshNextComputerUse { display: block; }
.dshNextPluginCardActions .dshNextPluginActions { flex-wrap: nowrap; }
.dshNextPluginDetail, .dshNextComputerUse { display: grid; gap: 12px; }
.dshNextPluginActions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dshNextPluginCardActions [role="status"], .dshNextPluginCardActions [role="alert"] { display: block; max-width: 220px; white-space: normal; }
button.dshNextSettingsGear { width: 28px; padding: 0; }
.dshNextPluginSettingsNotice { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px 16px; border: 1px solid var(--dsw-alias-border-l1); }
.dshNextPluginSettingsNotice > span { flex: 1 1 220px; }
.dshNextPluginSettingsNotice > button { flex-shrink: 0; }
.dshNextPluginControls p { margin: 0; }
.dshNextPermissionsDialog[role="dialog"] { width: min(620px, calc(100vw - 48px)); max-height: calc(100dvh - 48px); overflow-y: auto; }
.dshNextPermissionList { display: grid; gap: 0; }
.dshNextPermissionRow { display: flex; justify-content: space-between; align-items: center; gap: 24px; padding: 18px 0; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.dshNextPermissionRow:last-child { border-bottom: 0; }
.dshNextPermissionCopy { min-width: 0; font-size: 14px; }
.dshNextPermissionRow .dshNextPluginActions { flex-shrink: 0; justify-content: flex-end; max-width: 210px; }
.dshNextPermissionStatus { display: flex; align-items: center; gap: 6px; margin-top: 8px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
@media(max-width: 560px) { .dshNextMarketChoices { grid-template-columns: 1fr; } .dshNextPluginCard { align-items: flex-start; flex-wrap: wrap; } .dshNextPluginCardMain { flex-basis: calc(100% - 68px); } .dshNextPluginCardActions { margin-left: 62px; } .dshNextPermissionRow { align-items: flex-start; flex-direction: column; gap: 12px; } .dshNextPermissionRow .dshNextPluginActions { max-width: none; } }
`

export function installPluginControlsStyles(): () => void {
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-desktop-next/plugin-controls'
  style.textContent = STYLES
  document.head.append(style)
  return () => style.remove()
}
