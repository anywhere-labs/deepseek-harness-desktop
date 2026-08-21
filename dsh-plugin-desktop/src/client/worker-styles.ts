const STYLE_ID = 'dsh-plugin-desktop/worker-pack'

const css = `
.dshWorkerRoot,
.dshMcpRoot {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
  color: var(--dsw-alias-label-primary);
}
.dshWorkerSection,
.dshMcpSection {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.dshWorkerSection h2,
.dshMcpSection h2,
.dshWorkerRoot h2,
.dshMcpRoot h2 {
  margin: 0;
  font-size: 16px;
  line-height: 24px;
  font-weight: 600;
}
.dshWorkerSection p,
.dshMcpSection p,
.dshWorkerLead,
.dshMcpLead {
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 13px;
  line-height: 20px;
}
.dshWorkerCard,
.dshMcpCard {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  padding: 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  background: var(--dsw-alias-bg-container);
}
.dshWorkerCard h3,
.dshMcpCard h3 {
  margin: 0;
  font-size: 14px;
  line-height: 22px;
  font-weight: 600;
}
.dshWorkerMeta,
.dshMcpMeta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 12px;
  align-items: center;
}
.dshWorkerCode,
.dshMcpCode {
  font-family: var(--ds-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 12px;
  line-height: 18px;
}
.dshWorkerActions,
.dshMcpActions,
.dshMcpFieldRow {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.dshMcpField {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.dshMcpField label {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
.dshMcpField input,
.dshMcpField textarea,
.dshMcpField select {
  width: 100%;
  box-sizing: border-box;
  min-height: 32px;
  padding: 6px 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-base);
  color: inherit;
  font: inherit;
}
.dshMcpField textarea {
  min-height: 72px;
  resize: vertical;
  font-family: var(--ds-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 12px;
}
.dshWorkerStatus[data-tone="error"],
.dshMcpStatus[data-tone="error"] {
  color: var(--dsw-alias-label-danger, #c43c3c);
}
.dshWorkerStatus[data-tone="ok"],
.dshMcpStatus[data-tone="ok"] {
  color: var(--dsw-alias-label-secondary);
}
`

/** Install the worker-pack and MCP settings stylesheet. */
export function installWorkerStyles(): () => void {
  const existing = document.getElementById(STYLE_ID)
  if (existing !== null) return () => { existing.remove() }
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = css
  document.head.appendChild(style)
  return () => { style.remove() }
}
