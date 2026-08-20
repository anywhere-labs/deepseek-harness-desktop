/**
 * Close-behavior preference row registered into the General section item slot:
 * title plus a selector menu choosing minimize-to-tray or quit on window close.
 */
import { useEffect, useState } from 'react'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronDownOutline14, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { DesktopCloseBehavior } from '../runtime.ts'
import type { createCloseBehaviorRowStore } from './close-behavior-settings-store.ts'

/** Row stylesheet kept as a plain string so the package client bundle stays self-contained. */
const ROW_STYLES = `
.dshCloseBehaviorRow { display: flex; align-items: center; gap: 8px; padding: 16px 0; border-bottom: 1px solid var(--dsw-alias-border-l2); }
.dshCloseBehaviorRowText { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; padding-right: 48px; }
.dshCloseBehaviorRowTitle { font-size: 14px; font-weight: 400; line-height: 22px; color: var(--dsw-alias-label-primary); }
.dshCloseBehaviorRowSelector { display: inline-flex; align-items: center; gap: 12px; height: 36px; padding: 0 14px; border: none; border-radius: 18px; background: var(--dsw-alias-bg-module-platform); font: inherit; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-primary); cursor: pointer; }
.dshCloseBehaviorRowSelector:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dshCloseBehaviorRowChevron { flex: none; }
`

/** Style-tag identity used to guard single injection (mirrors the advanced-shell pattern). */
const ROW_STYLE_TAG = 'dsh-plugin-desktop/close-behavior-row'

/** Inject the row stylesheet once; safe for no-DOM hosts and re-mounts. */
function installRowStyles(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css="${ROW_STYLE_TAG}"]`) !== null) return
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-plugin-desktop'
  style.dataset.pluginCss = ROW_STYLE_TAG
  style.textContent = ROW_STYLES
  document.head.appendChild(style)
}

/** Injected business face: the preference write (t rides the standard locale seat). */
export interface CloseBehaviorRowInjected {
  /** Persist the selected close behavior to the dsh-desktop scope. */
  setCloseBehavior: (value: DesktopCloseBehavior) => void
}

/** Full component props: runtime share + store share + locale seat + injected face. */
export type CloseBehaviorRowComponentProps =
  PropsRuntime<'settings.general.item'> & PropsStore<ReturnType<typeof createCloseBehaviorRowStore>>
  & PropsLocale<'settings.desktop'> & CloseBehaviorRowInjected

/** The two selectable close behaviors in display order. */
const OPTIONS: DesktopCloseBehavior[] = ['tray', 'quit']

/**
 * Render the close-behavior row.
 * @param props - composed slot props.
 * @returns the row element tree.
 */
export function CloseBehaviorRow({ t, setCloseBehavior, useStore }: CloseBehaviorRowComponentProps) {
  const value = useStore(s => s.value)
  const [open, setOpen] = useState(false)
  useEffect(installRowStyles, [])
  const labelOf = (id: DesktopCloseBehavior): string =>
    id === 'tray' ? t('closeBehavior.tray') : t('closeBehavior.quit')

  return (
    <div className="dshCloseBehaviorRow">
      <div className="dshCloseBehaviorRowText">
        <div className="dshCloseBehaviorRowTitle">{t('closeBehavior.title')}</div>
      </div>
      <Menu
        open={open}
        onClose={() => { setOpen(false) }}
        items={OPTIONS.map(id => ({ id, label: labelOf(id) }))}
        selectedId={value}
        onSelect={(id) => {
          setCloseBehavior(id as DesktopCloseBehavior)
          setOpen(false)
        }}
        align="end"
        portal
        anchor={(
          <button
            type="button"
            className="dshCloseBehaviorRowSelector"
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => { setOpen(v => !v) }}
          >
            {labelOf(value)}
            <IconChevronDownOutline14 className="dshCloseBehaviorRowChevron" />
          </button>
        )}
      />
    </div>
  )
}
