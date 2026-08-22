const VISION_STYLES = `
.dshVisionModelRoot { position: relative; min-width: 0; }
.dshVisionModelTrigger { display: flex; align-items: center; gap: 5px; min-width: 0; max-width: min(360px, 45cqw); height: 28px; padding: 0 5px 0 8px; border: 0; border-radius: 8px; background: transparent; color: var(--dsw-alias-label-secondary); font: 500 13px/20px inherit; cursor: pointer; }
.dshVisionModelTrigger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dshVisionModelTrigger:focus-visible { outline: 2px solid var(--dsw-alias-border-l3); outline-offset: 1px; }
.dshVisionModelTrigger:disabled { color: var(--dsw-alias-label-dimmed); cursor: default; }
.dshVisionModelTriggerLabel { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshVisionTriggerMark { display: grid; place-items: center; flex: 0 0 16px; width: 16px; height: 16px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 4px; color: var(--dsw-alias-label-caption); font-size: 10px; line-height: 1; }
.dshVisionChevron { flex: 0 0 auto; color: var(--dsw-alias-label-caption); transition: transform 120ms ease; }
.dshVisionChevron[data-open] { transform: rotate(180deg); }
.dshVisionModelMenu { position: absolute; right: 0; bottom: calc(100% + 8px); z-index: 30; width: max-content; min-width: min(300px, calc(100vw - 32px)); max-width: min(460px, calc(100vw - 32px)); max-height: min(440px, calc(100vh - 96px)); overflow: auto; padding: 5px; border: 1px solid var(--dsw-alias-border-inverted); border-radius: 8px; background: var(--dsw-specific-menu); box-shadow: var(--dsw-shadow-lv3); color: var(--dsw-alias-label-primary); }
.dshVisionMenuStatus { padding: 9px; color: var(--dsw-alias-label-tertiary); font-size: 13px; line-height: 20px; }
.dshVisionMenuError, .dshVisionMenuWarning { display: flex; align-items: center; gap: 7px; margin-bottom: 4px; padding: 7px 8px; border-radius: 6px; background: var(--dsw-alias-interactive-bg-hover-danger); color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 18px; }
.dshVisionMenuWarning { background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-state-warn-label); }
.dshVisionMenuError span { flex: 1; min-width: 0; }
.dshVisionMenuError button { border: 0; background: transparent; color: inherit; font: 600 12px/18px inherit; cursor: pointer; }
.dshVisionModelGroup + .dshVisionModelGroup { margin-top: 4px; }
.dshVisionModelGroupTitle { position: sticky; top: 0; z-index: 1; padding: 5px 8px 3px; background: var(--dsw-specific-menu); color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; font-weight: 500; }
.dshVisionModelOption, .dshVisionEffortOption { box-sizing: border-box; display: flex; align-items: center; gap: 8px; width: 100%; min-height: 40px; padding: 6px 8px; border: 0; border-radius: 6px; background: transparent; color: inherit; text-align: left; cursor: pointer; }
.dshVisionModelOption:hover:not(:disabled), .dshVisionModelOption:focus-visible, .dshVisionEffortOption:hover:not(:disabled), .dshVisionEffortOption:focus-visible { background: var(--dsw-alias-interactive-bg-hover); outline: none; }
.dshVisionModelOption:disabled, .dshVisionEffortOption:disabled { color: var(--dsw-alias-label-dimmed); cursor: default; }
.dshVisionModelCopy { display: flex; flex: 1; flex-direction: column; min-width: 0; }
.dshVisionModelNameRow { display: flex; align-items: center; gap: 5px; min-width: 0; }
.dshVisionModelName { min-width: 0; overflow: hidden; font-size: 14px; line-height: 20px; font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
.dshVisionModelDescription { overflow: hidden; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; text-overflow: ellipsis; white-space: nowrap; }
.dshVisionBadge { flex: 0 0 auto; padding: 1px 5px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 4px; color: var(--dsw-alias-label-secondary); font-size: 10px; line-height: 14px; font-weight: 600; }
.dshVisionBadge[data-badge="experimental"] { border-color: var(--dsw-alias-state-warn-border); color: var(--dsw-alias-state-warn-label); }
.dshVisionModelCheck { display: grid; place-items: center; flex: 0 0 18px; }
.dshVisionEffortSection { margin-top: 5px; padding-top: 4px; border-top: 1px solid var(--dsw-alias-border-l1); }
.dshVisionEffortOption { min-height: 34px; font-size: 13px; line-height: 20px; }
.dshVisionEffortOption span { flex: 1; }
.dshVisionAttachments { display: flex; align-items: center; gap: 10px; min-width: 0; padding: 8px 10px 2px; }
.dshVisionAttachmentRail { display: flex; flex: 1; gap: 8px; min-width: 0; overflow-x: auto; scrollbar-width: none; }
.dshVisionAttachmentRail::-webkit-scrollbar { display: none; }
.dshVisionAttachment { position: relative; flex: 0 0 52px; width: 52px; height: 52px; }
.dshVisionAttachmentPreview { display: block; width: 52px; height: 52px; padding: 0; overflow: hidden; border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; background: var(--dsw-alias-bg-base); cursor: zoom-in; }
.dshVisionAttachmentPreview img { display: block; width: 100%; height: 100%; object-fit: cover; }
.dshVisionAttachmentRemove { position: absolute; top: -5px; right: -5px; display: grid; place-items: center; width: 18px; height: 18px; padding: 0; border: 1px solid var(--dsw-alias-border-l2); border-radius: 50%; background: var(--dsw-specific-menu); color: var(--dsw-alias-label-secondary); cursor: pointer; opacity: 0; }
.dshVisionAttachment:hover .dshVisionAttachmentRemove, .dshVisionAttachmentRemove:focus-visible { opacity: 1; }
.dshVisionAttachmentRemove:disabled { cursor: default; opacity: .45; }
.dshVisionAttachmentState { position: absolute; right: 4px; bottom: 4px; width: 8px; height: 8px; border: 2px solid var(--dsw-specific-menu); border-radius: 50%; background: var(--dsw-alias-label-tertiary); }
.dshVisionAttachment[data-delivery="preparing"] .dshVisionAttachmentState, .dshVisionAttachment[data-delivery="sending"] .dshVisionAttachmentState { background: var(--dsw-alias-state-info-primary); animation: dshVisionPulse 1s ease-in-out infinite; }
.dshVisionAttachment[data-delivery="failed"] .dshVisionAttachmentState { background: var(--dsw-alias-state-error-primary); }
.dshVisionDelivery { display: flex; flex: 0 0 auto; align-items: center; gap: 6px; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; white-space: nowrap; }
.dshVisionDeliveryDot { width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-label-tertiary); }
.dshVisionAttachments[data-delivery="preparing"] .dshVisionDeliveryDot, .dshVisionAttachments[data-delivery="sending"] .dshVisionDeliveryDot { background: var(--dsw-alias-state-info-primary); animation: dshVisionPulse 1s ease-in-out infinite; }
.dshVisionAttachments[data-delivery="failed"] .dshVisionDelivery { color: var(--dsw-alias-state-error-primary); }
.dshVisionAttachments[data-delivery="failed"] .dshVisionDeliveryDot { background: var(--dsw-alias-state-error-primary); }
.dshVisionRetry { padding: 0; border: 0; background: transparent; color: inherit; font: 600 12px/18px inherit; cursor: pointer; }
.dshVisionDropOverlay { position: absolute; z-index: 40; inset: 0; display: grid; place-items: center; border: 1px dashed var(--dsw-alias-border-l3); border-radius: 8px; background: color-mix(in srgb, var(--dsw-alias-bg-base) 92%, transparent); color: var(--dsw-alias-label-secondary); font-size: 13px; font-weight: 600; }
.dshVisionDropOverlay[data-disabled] { color: var(--dsw-alias-label-dimmed); }
.dshVisionLightbox { position: fixed; z-index: 1200; inset: 0; display: grid; place-items: center; padding: 40px; background: rgba(0, 0, 0, .78); }
.dshVisionLightbox img { max-width: min(100%, 1200px); max-height: 100%; object-fit: contain; }
.dshVisionLightbox > button { position: fixed; top: 18px; right: 18px; display: grid; place-items: center; width: 32px; height: 32px; padding: 0; border: 1px solid rgba(255,255,255,.3); border-radius: 50%; background: rgba(0,0,0,.45); color: white; cursor: pointer; }
@keyframes dshVisionPulse { 50% { opacity: .35; } }
@media (max-width: 640px) { .dshVisionDelivery { max-width: 112px; white-space: normal; } .dshVisionAttachments { align-items: flex-start; } }
@media (prefers-reduced-motion: reduce) { .dshVisionChevron { transition: none; } .dshVisionDeliveryDot, .dshVisionAttachmentState { animation: none !important; } }
`

export function installVisionStyles(): () => void {
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-plugin-desktop'
  style.dataset.pluginCss = 'dsh-plugin-desktop/vision'
  style.textContent = VISION_STYLES
  document.head.appendChild(style)
  return () => { style.remove() }
}
