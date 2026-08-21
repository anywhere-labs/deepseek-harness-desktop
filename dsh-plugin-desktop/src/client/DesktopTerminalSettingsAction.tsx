/** Settings-header action for opening the launcher-owned DSH Terminal. */

import { useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { DesktopSettingsApi } from './desktop-settings-api.ts'

/** Registration-side capability for the terminal action. */
export interface DesktopTerminalSettingsActionInjected {
  readonly api: Pick<DesktopSettingsApi, 'openTerminal'>
}

/** Renderer-composed terminal action props. */
export type DesktopTerminalSettingsActionProps =
  PropsRuntime<'settings.action'>
  & PropsLocale<'desktop.settings'>
  & InjectFace<DesktopTerminalSettingsActionInjected>

/** Open DSH Terminal without exposing launcher details to the renderer. */
export function DesktopTerminalSettingsAction({ api, t }: DesktopTerminalSettingsActionProps) {
  const [opening, setOpening] = useState(false)
  const [failed, setFailed] = useState(false)

  const open = (): void => {
    if (opening) return
    setOpening(true)
    setFailed(false)
    void api.openTerminal().catch(() => { setFailed(true) }).finally(() => { setOpening(false) })
  }

  return (
    <div className="dshDesktopSettingsTerminalAction">
      {failed && (
        <span className="dshDesktopSettingsTerminalError" role="alert">{t('openTerminalError')}</span>
      )}
      <button
        type="button"
        className="dshDesktopSettingsHeaderButton"
        disabled={opening}
        onClick={open}
      >
        {t(opening ? 'openingTerminal' : 'openTerminal')}
      </button>
    </div>
  )
}
