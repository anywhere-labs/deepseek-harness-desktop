import { useSyncExternalStore } from 'react'
import { IconCordisPluginOutline14, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { MarketController } from './controller.js'

export type MarketLauncherProps = PropsRuntime<'sidebar.footer.action'>
  & PropsLocale<'community-market'>
  & { controller: MarketController }

export function MarketLauncher({ wide, controller, t }: MarketLauncherProps) {
  const opened = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  return (
    <Tooltip label={t('launcher')} delayMs={500} disabled={wide}>
      <button
        type="button"
        className="dshMarketLauncher"
        data-wide={wide}
        data-active={opened}
        aria-label={t('launcher')}
        onClick={() => controller.open()}
      >
        <IconCordisPluginOutline14 size={wide ? 16 : 18} />
        {wide && <span>{t('launcher')}</span>}
      </button>
    </Tooltip>
  )
}
