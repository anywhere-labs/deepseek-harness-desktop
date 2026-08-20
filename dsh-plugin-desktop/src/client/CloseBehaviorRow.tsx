/**
 * Close-behavior preference row registered into the General section item slot:
 * title plus a selector menu choosing minimize-to-tray or quit on window close.
 */
import { useState } from 'react'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronDownOutline14, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { DesktopCloseBehavior } from '../runtime.ts'
import type { createCloseBehaviorRowStore } from './close-behavior-settings-store.ts'
import css from './CloseBehaviorRow.module.css'

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
  const labelOf = (id: DesktopCloseBehavior): string =>
    id === 'tray' ? t('closeBehavior.tray') : t('closeBehavior.quit')

  return (
    <div className={css.row}>
      <div className={css.rowText}>
        <div className={css.title}>{t('closeBehavior.title')}</div>
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
            className={css.selector}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => { setOpen(v => !v) }}
          >
            {labelOf(value)}
            <IconChevronDownOutline14 className={css.chevron} />
          </button>
        )}
      />
    </div>
  )
}
