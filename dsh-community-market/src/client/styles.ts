const STYLE_ID = 'dsh-community-market/styles'

const css = `
.dshMarketRoot {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
  min-height: 460px;
  color: var(--dsw-alias-label-primary);
}

.dshMarketHeader,
.dshMarketViewBar,
.dshMarketSectionHead,
.dshMarketToolbar,
.dshMarketSourceActions,
.dshMarketOverlayHeader {
  display: flex;
  align-items: center;
  gap: 12px;
}

.dshMarketHeader,
.dshMarketSectionHead,
.dshMarketOverlayHeader {
  align-items: flex-start;
}

.dshMarketHeaderTitle,
.dshMarketSectionHead > div,
.dshMarketOverlayHeader > div {
  min-width: 0;
  flex: 1;
}

.dshMarketHeaderTitle h2,
.dshMarketSectionHead h2,
.dshMarketOverlayHeader h1 {
  margin: 0;
  font-size: 18px;
  line-height: 26px;
  font-weight: 600;
}

.dshMarketHeaderTitle p,
.dshMarketSectionHead p,
.dshMarketOverlayHeader p {
  margin: 3px 0 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 13px;
  line-height: 20px;
}

.dshMarketViewBar {
  justify-content: space-between;
}

.dshMarketViewSwitch {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.dshMarketCurrentSource a {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: inherit;
  text-decoration: none;
}

.dshMarketCurrentSource a:hover {
  text-decoration: underline;
}

.dshMarketMain,
.dshMarketContent {
  min-width: 0;
}

.dshMarketToolbar {
  margin-bottom: 16px;
}

.dshMarketCategories {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin: -4px 0 16px;
}

.dshMarketCategories > span:first-child {
  margin-right: 2px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}

.dshMarketSearch {
  min-width: 220px;
  flex: 1;
}

.dshMarketBanner {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 14px;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 20px;
}

.dshMarketSourceGuide {
  align-items: flex-start;
}

.dshMarketSourceGuide > span {
  min-width: 0;
}

.dshMarketGrid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.dshMarketCard {
  appearance: none;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 150px;
  padding: 15px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-3);
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.dshMarketCard:hover {
  border-color: var(--dsw-alias-border-l3);
  background: var(--dsw-alias-interactive-bg-hover);
  box-shadow: var(--dsw-shadow-lv1);
}

.dshMarketCard:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary);
  outline-offset: 2px;
}

.dshMarketCard:disabled {
  cursor: not-allowed;
  opacity: 0.62;
  box-shadow: none;
}

.dshMarketCardTop {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}

.dshMarketGlyph,
.dshMarketEmptyIcon {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  background: var(--dsw-alias-state-business-tertiary);
  color: var(--dsw-alias-state-business-primary);
}

.dshMarketGlyph {
  position: relative;
  overflow: hidden;
  width: 34px;
  height: 34px;
}

.dshMarketGlyphLarge {
  width: 56px;
  height: 56px;
  border-radius: 12px;
}

.dshMarketGlyph img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  background: var(--dsw-alias-bg-layer-3);
}

.dshMarketCardName {
  min-width: 0;
  flex: 1;
}

.dshMarketCardName strong,
.dshMarketCardName span {
  display: block;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.dshMarketCardName strong {
  font-size: 14px;
  line-height: 20px;
}

.dshMarketCardName span {
  margin-top: 2px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 17px;
}

.dshMarketSummary {
  display: -webkit-box;
  margin: 12px 0;
  overflow: hidden;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 19px;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}

.dshMarketTags {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: auto;
  overflow: hidden;
}

.dshMarketPagination {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 18px 0 4px;
}

.dshMarketPaginationError {
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
  text-align: center;
}

.dshMarketEmpty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 280px;
  padding: 24px;
  text-align: center;
}

.dshMarketEmptyIcon {
  width: 48px;
  height: 48px;
  margin-bottom: 14px;
}

.dshMarketEmpty h2 {
  margin: 0 0 6px;
  font-size: 16px;
  line-height: 23px;
}

.dshMarketEmpty p {
  max-width: 430px;
  margin: 0 0 16px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 13px;
  line-height: 20px;
}

.dshMarketSectionHead {
  margin-bottom: 16px;
}

.dshMarketIndexMeta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 14px;
  margin: -6px 0 14px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}

.dshMarketSources {
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.dshMarketAvailableSources {
  margin-top: 9px;
}

.dshMarketSource {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 13px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-3);
}

.dshMarketSource h3 {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 7px;
  margin: 0;
  font-size: 14px;
  line-height: 20px;
}

.dshMarketSource p {
  margin: 3px 0 0;
  overflow-wrap: anywhere;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}

.dshMarketSourceAttribution {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 10px;
  margin-top: 7px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 16px;
}

.dshMarketSourceAttribution a {
  color: var(--dsw-alias-label-secondary);
  text-decoration: underline;
  text-decoration-color: var(--dsw-alias-border-l3);
  text-underline-offset: 2px;
}

.dshMarketSourceAttribution a:hover {
  color: var(--dsw-alias-label-primary);
}

.dshMarketSourceMeta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px 10px;
  margin-top: 7px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 16px;
}

.dshMarketSourceMeta > span {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  overflow-wrap: anywhere;
}

.dshMarketSourceActions {
  justify-content: flex-end;
  gap: 7px;
}

.dshMarketReceipts {
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.dshMarketReceipt {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 14px;
  padding: 14px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-3);
}

.dshMarketReceiptMain {
  min-width: 0;
}

.dshMarketReceiptActions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px;
}

.dshMarketReceiptTitle,
.dshMarketReceiptMeta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
}

.dshMarketReceiptTitle {
  gap: 7px;
}

.dshMarketReceiptTitle h3 {
  margin: 0;
  font-size: 14px;
  line-height: 20px;
}

.dshMarketReceiptMeta {
  gap: 5px 12px;
  margin-top: 6px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}

.dshMarketReceiptMeta span {
  overflow-wrap: anywhere;
}

.dshMarketDetails {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.dshMarketItemSourceRow {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 4px;
  min-width: 0;
  margin-bottom: 14px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
  text-align: right;
}

.dshMarketItemSourceRow > :last-child {
  min-width: 0;
  overflow-wrap: anywhere;
}

.dshMarketItemSourceRow a {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 3px;
  color: var(--dsw-alias-label-secondary);
  text-decoration: underline;
  text-decoration-color: var(--dsw-alias-border-l3);
  text-underline-offset: 2px;
}

.dshMarketItemSourceRow a:hover {
  color: var(--dsw-alias-label-primary);
}

.dshMarketDetailsIntro {
  display: flex;
  align-items: flex-start;
  gap: 14px;
}

.dshMarketDetailsIntro > p {
  min-width: 0;
  flex: 1;
}

.dshMarketDetails p {
  margin: 0;
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
  line-height: 22px;
  white-space: pre-wrap;
}

.dshMarketDetails > div:last-child {
  padding-top: 14px;
  border-top: 1px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 19px;
}

.dshMarketManualInstall {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.dshMarketModal {
  max-height: calc(100vh - 48px);
  max-height: calc(100dvh - 48px);
}

.dshMarketWideModal {
  width: min(800px, calc(100vw - 48px));
}

.dshMarketConfirmModal {
  width: min(600px, calc(100vw - 48px));
}

.dshMarketSourceModal {
  width: min(600px, calc(100vw - 48px));
}

.dshMarketStatusModal {
  width: min(480px, calc(100vw - 48px));
}

.dshMarketModalContent {
  min-height: 0;
  overflow-y: auto;
}

.dshMarketModalActions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px;
  width: 100%;
}

.dshMarketManualInstall h3 {
  margin: 0 0 3px;
  font-size: 14px;
  line-height: 20px;
}

.dshMarketManualInstall p {
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 19px;
}

.dshMarketCommand {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.dshMarketCommand > span {
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}

.dshMarketCommand code {
  display: block;
  overflow-x: auto;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family-code, ui-monospace, SFMono-Regular, Consolas, monospace);
  font-size: 12px;
  line-height: 19px;
  white-space: pre;
}

.dshMarketOperationReview {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.dshMarketOperationFacts {
  display: grid;
  gap: 8px;
  margin: 0;
}

.dshMarketOperationFacts > div {
  display: grid;
  grid-template-columns: minmax(105px, 0.36fr) minmax(0, 1fr);
  gap: 12px;
}

.dshMarketOperationFacts dt,
.dshMarketOperationFacts dd {
  margin: 0;
  font-size: 13px;
  line-height: 20px;
}

.dshMarketOperationFacts dt {
  color: var(--dsw-alias-label-tertiary);
}

.dshMarketOperationFacts dd {
  overflow-wrap: anywhere;
  color: var(--dsw-alias-label-primary);
  font-weight: 600;
}

.dshMarketOperationWarning,
.dshMarketOperationSuccess,
.dshMarketOperationProgress {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 19px;
}

.dshMarketOperationSuccess {
  color: var(--dsw-alias-label-primary);
}

.dshMarketModalField {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.dshMarketModalField label {
  font-size: 13px;
  font-weight: 600;
}

.dshMarketError {
  margin-top: 8px;
  color: var(--dsw-alias-state-error-primary);
  font-size: 12px;
}

.dshMarketLauncher {
  flex: none;
  box-sizing: border-box;
  width: calc(100% + 4px);
  height: 42px;
  margin: 4px -2px;
  padding: 0 10px 0 8px;
  gap: 8px;
  justify-content: flex-start;
  overflow: hidden;
  border-radius: 12px;
  white-space: nowrap;
}

.dshMarketLauncher[data-wide='false'] {
  width: 36px;
  height: 36px;
  margin: 8px 0 10px;
  justify-content: center;
  gap: 0;
  padding: 0;
  border-radius: 50%;
}

.dshMarketOverlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  pointer-events: auto;
}

.dshMarketOverlayMask {
  position: absolute;
  inset: 0;
  border: 0;
  background: var(--dsw-alias-bg-mask-1);
  backdrop-filter: var(--dsw-mask-blur);
}

.dshMarketOverlayPanel {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  width: min(800px, 100%);
  height: min(700px, 100%);
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border: 1px solid var(--dsw-alias-border-inverted);
  border-radius: 24px;
  background: var(--dsw-alias-bg-layer-2);
  box-shadow: var(--dsw-shadow-lv3);
}

.dshMarketOverlayHeader {
  flex: none;
  padding: 20px 18px 14px 24px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}

.dshMarketOverlayBody {
  min-width: 0;
  min-height: 0;
  flex: 1;
  overflow: auto;
  padding: 20px 24px 24px;
}

@media (max-width: 680px) {
  .dshMarketOverlay {
    padding: 0;
  }

  .dshMarketOverlayPanel {
    width: 100%;
    height: 100%;
    border-radius: 0;
  }

  .dshMarketHeader,
  .dshMarketViewBar,
  .dshMarketSectionHead,
  .dshMarketToolbar,
  .dshMarketSource,
  .dshMarketSourceActions {
    align-items: stretch;
  }

  .dshMarketHeader,
  .dshMarketViewBar,
  .dshMarketSectionHead,
  .dshMarketToolbar {
    flex-wrap: wrap;
  }

  .dshMarketSearch {
    min-width: 100%;
    order: 2;
  }

  .dshMarketGrid,
  .dshMarketSource,
  .dshMarketReceipt {
    grid-template-columns: 1fr;
  }

  .dshMarketOperationFacts > div {
    grid-template-columns: 1fr;
    gap: 2px;
  }

  .dshMarketSourceActions {
    justify-content: flex-start;
    flex-wrap: wrap;
  }
}
`

export function installMarketStyles(): () => void {
  const existing = document.querySelector<HTMLStyleElement>(`style[data-plugin="${STYLE_ID}"]`)
  if (existing !== null) return () => {}
  const style = document.createElement('style')
  style.dataset.plugin = STYLE_ID
  style.textContent = css
  document.head.append(style)
  return () => { style.remove() }
}
