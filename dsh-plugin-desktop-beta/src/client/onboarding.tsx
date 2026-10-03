/** Sequence existing Desktop setup content inside the official onboarding surface. */
import { useEffect, useState, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings-account/client'
import { Button, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DesktopOnboardingBridge, DesktopOnboardingSnapshot } from '../setup-onboarding-bridge.ts'

export type SetupNavigation = PropsRuntime<'onboarding.desktop.before'>['renderNavigation']
export type SetupContent = (snapshot: DesktopOnboardingSnapshot, locale: 'zh' | 'en', finish: DesktopOnboardingBridge['finish'], renderNavigation: SetupNavigation) => ReactNode

function pendingSnapshot(value: DesktopOnboardingSnapshot | null): DesktopOnboardingSnapshot | null {
  return value?.required || value?.accountPending || value?.restartPending ? value : null
}

export function registerDesktopOnboarding(ctx: Context, content: SetupContent): void {
  const bridge = (window as unknown as { dshDesktopSetup?: DesktopOnboardingBridge }).dshDesktopSetup
  if (!bridge) return
  ctx.slots.inject('onboarding.desktop.before', () => ctx.slots.register({
    name: 'onboarding.desktop.before', inject: () => ({ bridge, content, zh: ctx.locale.getLocale().active.startsWith('zh') }),
  }, DesktopOnboarding))
}

function DesktopOnboarding({ bridge, content, zh, renderSurface, renderLoading, renderNext, renderNavigation, accountStatus, openLogin }: PropsRuntime<'onboarding.desktop.before'> & {
  bridge: DesktopOnboardingBridge; content: SetupContent; zh: boolean
}) {
  const [snapshot, setSnapshot] = useState<DesktopOnboardingSnapshot | null>()
  const [error, setError] = useState('')
  const [revision, refresh] = useState(0)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let disposed = false
    void bridge.read().then(value => {
      if (disposed) return
      setError('')
      setSnapshot(pendingSnapshot(value))
    }).catch(cause => { if (!disposed) setError(String(cause)) })
    return () => { disposed = true }
  }, [bridge, revision])
  useEffect(() => {
    if (!snapshot?.accountPending || snapshot.required || accountStatus !== 'credential-stored') return
    let disposed = false
    void bridge.dismissAccount(snapshot.profile).then(async () => {
      const next = snapshot.restartPending ? pendingSnapshot(await bridge.read()) : null
      if (!disposed) setSnapshot(next)
    }).catch(cause => { if (!disposed) setError(String(cause)) })
    return () => { disposed = true }
  }, [bridge, snapshot, accountStatus])
  if (error) return renderSurface(<div role="alert" style={{ padding: 48 }}>
    <p>{error}</p><Button onClick={() => { setError(''); setSnapshot(undefined); refresh(value => value + 1) }}>{zh ? '重试' : 'Retry'}</Button>
  </div>)
  if (snapshot === undefined) return renderLoading()
  if (snapshot === null) return renderNext()
  if (!snapshot.required && !snapshot.accountPending) {
    // Use the official transient portal; onboarding-only styles are inactive
    // once this continuation returns to the ordinary shell.
    const apply = async () => {
      if (busy || !bridge.applyPending) return
      setBusy(true)
      try { await bridge.applyPending(snapshot.profile); setSnapshot(null) }
      catch (cause) { setError(String(cause)) }
      finally { setBusy(false) }
    }
    return <>{renderNext()}<Toast tone="success" holdMs={8000}
      text={zh ? '桌面设置已保存，下次重启后生效。' : 'Desktop settings saved. They will take effect after restarting.'}
      actions={[{ label: zh ? '立即重启' : 'Restart now', onClick: () => { void apply() } }]}
      onDone={() => { setSnapshot(null) }} /></>
  }
  if (!snapshot.required) {
    if (accountStatus === 'credential-stored') return renderLoading()
    const dismiss = async (login: boolean) => {
      if (busy) return
      setBusy(true)
      try {
        await bridge.dismissAccount(snapshot.profile)
        const next = snapshot.restartPending ? pendingSnapshot(await bridge.read()) : null
        setSnapshot(next)
        if (login) openLogin()
      } catch (cause) { setError(String(cause)) }
      finally { setBusy(false) }
    }
    return renderSurface(<section className="dshDesktopAccountSetup" aria-labelledby="desktop-account-title" aria-busy={busy}>
      <div>
        <h1 id="desktop-account-title">{zh ? '桌面设置已完成' : 'Desktop setup is complete'}</h1>
        <p>{zh ? `登录 DeepSeek，开始使用 Profile「${snapshot.profile}」。` : `Sign in to DeepSeek to get started with Profile “${snapshot.profile}”.`}</p>
        <p>{zh ? '登录后，如当前 Profile 尚未完成官方引导，将继续进行设置。你也可以在登录窗口中选择使用 API Key，或稍后登录。' : 'After sign-in, any unfinished official setup for this Profile will continue. You can also choose an API key in the sign-in dialog, or sign in later.'}</p>
        {accountStatus === 'error' && <p role="alert">{zh ? '暂时无法读取登录状态，可以稍后在账号菜单中登录。' : 'Account status is unavailable. You can sign in later from the account menu.'}</p>}
        <div className="dshDesktopAccountActions">
          <Button variant="primary" disabled={busy || accountStatus !== 'signed-out'} onClick={() => { void dismiss(true) }}>{zh ? '登录 DeepSeek' : 'Sign in to DeepSeek'}</Button>
          <Button variant="outline" disabled={busy} onClick={() => { void dismiss(false) }}>{zh ? '暂时跳过' : 'Not now'}</Button>
        </div>
      </div>
    </section>)
  }
  return renderSurface(<div className="dshDesktopSetupContent" data-platform={snapshot.input.platform}>{content(snapshot, zh ? 'zh' : 'en', async (profile, selection) => {
    await bridge.finish(profile, selection)
    // Stable/Beta keep this renderer alive; Next still applies through its Host restart.
    if (snapshot.edition === 'desktop') {
      try { setSnapshot(pendingSnapshot(await bridge.read())) }
      catch (cause) { setError(String(cause)) }
    }
    else setSnapshot(selection === undefined ? null : undefined)
  }, renderNavigation)}</div>)
}
