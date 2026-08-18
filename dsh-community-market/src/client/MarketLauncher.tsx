import {
  Button,
  IconCordisPluginOutline14,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { createMarketViewStore } from './market-view-store.js'

export type MarketLauncherProps = PropsRuntime<'sidebar.footer.action'>
  & PropsStore<ReturnType<typeof createMarketViewStore>>
  & PropsLocale<'community-market'>

export function MarketLauncher({ wide, useStore, actions, t }: MarketLauncherProps) {
  const open = useStore(state => state.open)
  return (
    <Tooltip label={t('tab')} delayMs={500} disabled={wide}>
      <Button
        variant="ghost"
        className="dshMarketLauncher"
        data-wide={wide}
        aria-label={t('tab')}
        aria-haspopup="dialog"
        aria-expanded={open}
        icon={<IconCordisPluginOutline14 size={wide ? 16 : 18} />}
        onClick={() => actions.open()}
      >
        {wide ? t('tab') : null}
      </Button>
    </Tooltip>
  )
}
