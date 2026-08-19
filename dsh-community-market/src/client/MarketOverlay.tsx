import { useEffect, useRef } from 'react'
import {
  Button,
  IconCloseOutline16,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { MarketSurface, type MarketView } from './MarketSettingsTab.js'
import type { createMarketViewStore } from './market-view-store.js'

export type MarketOverlayProps = PropsRuntime<'shell.overlay'>
  & PropsStore<ReturnType<typeof createMarketViewStore>>
  & PropsLocale<'community-market'>
  & { readLocale: () => string; initialView?: MarketView }

export function MarketOverlay({ useStore, actions, readLocale, t, initialView }: MarketOverlayProps) {
  const open = useStore(state => state.open)
  const panel = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!open) return
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (document.querySelectorAll('[role="dialog"]').length > 1) return
      actions.close()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [actions, open])

  if (!open) return null
  return (
    <div className="dshMarketOverlay" role="dialog" aria-modal="true" aria-label={t('title')}>
      <button className="dshMarketOverlayMask" type="button" aria-label={t('closeMarket')} onClick={() => actions.close()} />
      <section ref={panel} className="dshMarketOverlayPanel">
        <header className="dshMarketOverlayHeader">
          <div>
            <h1>{t('title')}</h1>
            <p>{t('subtitle')}</p>
          </div>
          <Tooltip label={t('closeMarket')}>
            <Button
              variant="ghost"
              size="sm"
              aria-label={t('closeMarket')}
              icon={<IconCloseOutline16 />}
              onClick={() => actions.close()}
            />
          </Tooltip>
        </header>
        <div className="dshMarketOverlayBody">
          <MarketSurface
            {...(initialView === undefined ? {} : { initialView })}
            readLocale={readLocale}
            showHeader={false}
            t={t}
          />
        </div>
      </section>
    </div>
  )
}
