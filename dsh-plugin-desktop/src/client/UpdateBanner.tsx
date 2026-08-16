/** Dismissible frame notice for available and downloaded desktop updates. */

import { useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './contracts.ts'
import type { DesktopUpdateInjected } from './UpdateRow.tsx'
import css from './UpdateBanner.module.css'

/** Full frame-overlay props. */
export type UpdateBannerProps = PropsRuntime<'shell.overlay'>
  & PropsLocale<'settings.desktopUpdate'> & DesktopUpdateInjected

/**
 * Render an update notice while a release is available or ready to install.
 * @param props - slot runtime, locale, state hook, and update actions.
 * @returns a dismissible banner or null for all other phases.
 */
export function UpdateBanner(props: UpdateBannerProps) {
  const state = props.useUpdate(value => value)
  const noticeKey = state.phase === 'available' || state.phase === 'downloaded'
    ? `${state.phase}:${state.availableVersion ?? ''}`
    : undefined
  const [dismissed, setDismissed] = useState<string | undefined>()
  if (noticeKey === undefined || dismissed === noticeKey) return null

  const downloaded = state.phase === 'downloaded'
  const manual = state.installMode !== 'automatic'
  const title = props.t(downloaded ? 'banner.downloaded' : 'banner.available', {
    version: state.availableVersion ?? '',
  })
  const action = downloaded
    ? { label: props.t('action.install'), run: props.install }
    : manual
      ? { label: props.t('action.release'), run: props.openReleasePage }
      : { label: props.t('action.download'), run: props.download }

  return (
    <div className={css.positioner} role="status" data-update-banner={state.phase}>
      <div className={css.banner}>
        <div className={css.copy}>
          <div className={css.title}>{title}</div>
          <div className={css.detail}>
            {props.t(downloaded
              ? 'banner.downloadedDetail'
              : manual ? 'banner.availableManualDetail' : 'banner.availableDetail')}
          </div>
        </div>
        <button type="button" className={css.action} onClick={() => { void action.run() }}>
          {action.label}
        </button>
        <button
          type="button"
          className={css.dismiss}
          aria-label={props.t('banner.dismiss')}
          onClick={() => { setDismissed(noticeKey) }}
        >
          ×
        </button>
      </div>
    </div>
  )
}
