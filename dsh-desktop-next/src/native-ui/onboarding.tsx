/** AA-inspired first-run flow, using the existing Desktop theme and controls. */
import { lazy, Suspense, useEffect, useRef, useState, type CSSProperties } from 'react'
import { ArrowRight, Check, Keyboard, LifeBuoy, LoaderCircle, MousePointer2, Scan } from 'lucide-react'
import { Button } from '../../../dsh-plugin-desktop-beta/src/native-ui/components/ui/button.tsx'
import { Switch } from '../../../dsh-plugin-desktop-beta/src/native-ui/components/ui/switch.tsx'
import { RadioGroup, RadioGroupItem } from '../../../dsh-plugin-desktop-beta/src/native-ui/components/ui/radio-group.tsx'
import { Alert, AlertDescription } from '../../../dsh-plugin-desktop-beta/src/native-ui/components/ui/alert.tsx'
import { DesktopFrame } from '../../../dsh-plugin-desktop-beta/src/native-ui/shared/DesktopFrame.tsx'
import type { DesktopBridge, DesktopState } from '../desktop-contract.ts'
import type { SetupNavigation } from '../../../dsh-plugin-desktop-beta/src/client/onboarding.tsx'
import { installPluginControlsStyles } from '../client/plugin-controls-styles.ts'
import './onboarding.css'
import whaleArtwork from '../../build/app-icon.icon/Assets/DeepSeek.svg'
// Reuse the portable device family artwork and composition from the AA landing page.
import phoneArtwork from './assets/agents-anywhere-phone.webp'
import tabletArtwork from './assets/agents-anywhere-tablet.webp'
type Market = 'none' | 'community' | 'dsh'
// Keep official dialog dependencies out of recovery and the earlier setup pages.
const DesktopPermissionsButton = lazy(() => import('../client/permissions.tsx').then(module => ({ default: module.DesktopPermissionsButton })))

export function Onboarding({ state, locale, bridge, renderNavigation, embedded = false }: { state: Pick<DesktopState, 'selected' | 'features' | 'onboardingComputerUse'>; locale: 'zh' | 'en'; bridge: Pick<DesktopBridge, 'command' | 'permissions'>; renderNavigation: SetupNavigation; embedded?: boolean }) {
  const t = (zh: string, en: string) => locale === 'zh' ? zh : en
  const [page, setPage] = useState(0)
  const [direction, setDirection] = useState(1)
  const [transitioning, setTransitioning] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const [market, setMarket] = useState<Market>(state.features.market ? 'community' : state.features.dshMarket ? 'dsh' : 'none')
  const [remote, setRemote] = useState(state.features.remoteControl)
  const [computerUse, setComputerUse] = useState(state.onboardingComputerUse ?? false)
  const slide = useRef<HTMLDivElement>(null)
  const navigationLock = useRef(false)
  const saving = useRef(false)
  const mounted = useRef(true)
  const animation = useRef<Animation | undefined>(undefined)
  const disabled = busy || transitioning
  const steps = [t('欢迎', 'Welcome'), t('插件市场', 'Plugin market'), t('远程控制', 'Remote control'), 'Computer Use', t('恢复模式', 'Recovery')]
  const lastPage = steps.length - 1
  const titles = [t('欢迎使用\nDSH NEXT', 'Welcome to\nDSH NEXT'), t('用插件，\n拓展更多可能。', 'Make room\nfor more possibilities.'), t('离开电脑，\n也能继续。', 'Keep going.\nAway from your desk.'), t('让 AI 帮你\n操作电脑。', 'Let AI work\non your desktop.'), t('遇到问题，\n从这里恢复。', 'A way back,\nwhen you need it.')]
  const descriptions = [
    t(`为 Profile「${state.selected}」选好常用功能。\n几步设置，就可以开始。`, `Set up the essentials for Profile “${state.selected}”.\nA few choices, then you’re ready to go.`),
    t('选择一个插件市场，浏览和安装社区插件。\n也可以暂不开启，以后在插件页面调整。', 'Choose a market to browse and install community plugins.\nYou can also leave it off and decide later in Plugins.'),
    t('通过 Agents Anywhere，在手机、平板或其他电脑上，\n继续与你的 Agent 对话。', 'Use Agents Anywhere on your phone, tablet or another computer\nto keep the conversation going.'),
    t('查看屏幕内容，操作鼠标和键盘。\n理解截图需要支持图片输入的模型。', 'View the screen and control the mouse and keyboard.\nUnderstanding screenshots requires a model with image input.'),
    t('恢复助手可以在 Profile 无法启动时打开。\n先检查问题，再选择合适的恢复方式。', 'The recovery assistant works even when a Profile cannot start.\nCheck what happened, then choose how to recover.'),
  ]

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; animation.current?.cancel() } }, [])
  useEffect(installPluginControlsStyles, [])
  useEffect(() => {
    if (page > 0 || direction < 0) slide.current?.querySelector('h1')?.focus({ preventScroll: true })
    slide.current?.closest('main')?.scrollTo({ top: 0 })
  }, [page, direction])

  async function navigate(next: number) {
    if (navigationLock.current || saving.current || next < 0 || next > lastPage) return
    navigationLock.current = true
    setTransitioning(true)
    const nextDirection = next > page ? 1 : -1
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches && slide.current) {
      const current = getComputedStyle(slide.current)
      animation.current = slide.current.animate([
        { opacity: current.opacity, transform: current.transform },
        { opacity: 0, transform: `translateX(${-nextDirection * 18}px)` },
      ], { duration: 180, easing: 'cubic-bezier(.4, 0, 1, 1)', fill: 'forwards' })
      await animation.current.finished.catch(() => {})
    }
    if (!mounted.current) return
    setDirection(nextDirection); setPage(next); setTransitioning(false)
    navigationLock.current = false
  }

  async function finish(skip: boolean) {
    if (saving.current || navigationLock.current) return
    saving.current = true
    setBusy(true); setFailure('')
    try {
      await bridge.command(skip ? { type: 'onboarding-skip', profile: state.selected }
        : { type: 'onboarding-complete', profile: state.selected, computerUse, features: {
          market: market === 'community', dshMarket: market === 'dsh', remoteControl: remote,
        } })
    } catch (error) {
      if (!mounted.current) return
      setFailure(error instanceof Error ? error.message : String(error))
      setBusy(false); saving.current = false
    }
  }

  const markets = [
    { value: 'community', title: 'dsh-community-market', detail: t('DSH Desktop 内置的开放插件市场，支持添加和选择自定义插件数据源。', 'DSH Desktop’s open plugin market, with support for custom plugin sources.') },
    { value: 'dsh', title: 'dsh-market', detail: t('社区热门的插件市场，数据来自 awesome-dsh-plugin。', 'A popular community market, powered by awesome-dsh-plugin.') },
    { value: 'none', title: t('暂不开启', 'Not now'), detail: t('以后可以在插件页面开启。', 'Enable a market later in Plugins.') },
  ]

  return <>{embedded ? null : <DesktopFrame />}<div className="next-onboarding dshNativeContent" lang={locale}>
    <header className="next-onboarding-progress">
      <ol aria-label={t('引导进度', 'Setup progress')}>{steps.map((step, index) => <li key={step} aria-current={index === page ? 'step' : undefined}><span className="sr-only">{step}</span></li>)}</ol>
      <span>{page + 1} / {steps.length}</span>
    </header>
    <main className="next-onboarding-main" aria-busy={busy}>
      <div key={page} ref={slide} className="next-onboarding-slide" data-page={page} style={{ '--entry-x': `${direction * 22}px` } as CSSProperties}>
        <section className="next-onboarding-copy" aria-labelledby="onboarding-title">
          {page > 0 && <p className="next-onboarding-eyebrow">{steps[page]}</p>}
          <h1 id="onboarding-title" tabIndex={-1}>{titles[page]!.split('\n').map((line, i) => <span className="next-onboarding-reveal" key={i} style={{ animationDelay: `${80 + i * 130}ms` }}>{line}</span>)}</h1>
          <p className="next-onboarding-description next-onboarding-reveal">{descriptions[page]}</p>
          {page === 2 && <div className="next-onboarding-option next-onboarding-reveal">
            <div className="next-onboarding-toggle"><label htmlFor="onboarding-remote">{t('启用远程控制', 'Enable remote control')}</label><Switch id="onboarding-remote" checked={remote} disabled={disabled} onCheckedChange={setRemote} /></div>
            <p>{t('完成后，在侧边栏的“远程控制”中登录并配对。', 'After setup, sign in and pair your device in “Remote Control” in the sidebar.')}</p>
          </div>}
          {page === 3 && <div className="next-onboarding-option next-onboarding-reveal">
            <div className="next-onboarding-toggle">
              <label htmlFor="onboarding-computer-use">{t('启用 Computer Use', 'Enable Computer Use')}</label>
              <div className="next-onboarding-option-actions">
                <Suspense fallback={<span className="next-onboarding-permissions-loading" aria-hidden="true"><LoaderCircle className="animate-spin" /></span>}>
                  <DesktopPermissionsButton service={bridge.permissions} language={locale} label={t('权限设置', 'Permission settings')} disabled={disabled} />
                </Suspense>
                <Switch id="onboarding-computer-use" checked={computerUse} disabled={disabled} onCheckedChange={setComputerUse} />
              </div>
            </div>
            <p>{t('通过“权限设置”管理系统权限，也可以稍后在插件页面调整。', 'Manage system permissions in “Permission settings”. You can also change these settings later in Plugins.')}</p>
          </div>}
        </section>
        <aside className="next-onboarding-panel next-onboarding-reveal" aria-label={steps[page]}>
          {page === 0 && <div className="next-onboarding-wordmark" aria-hidden="true">
            <span className="next-onboarding-whale" style={{ maskImage: `url("${whaleArtwork}")` }} /><span>NEXT</span>
          </div>}
          {page === 1 && <RadioGroup aria-label={t('插件市场', 'Plugin market')} value={market} disabled={disabled} onValueChange={value => setMarket(value as Market)}>
            {markets.map(option => <label className="next-onboarding-choice" data-selected={market === option.value} key={option.value}>
              <span className="next-onboarding-choice-copy"><strong><span id={`market-${option.value}`}>{option.title}</span>{option.value === 'community' && <small>Beta</small>}</strong><span>{option.detail}</span></span>
              <RadioGroupItem value={option.value} aria-labelledby={`market-${option.value}`} />
            </label>)}
          </RadioGroup>}
          {page === 2 && <figure className="next-onboarding-devices" aria-hidden="true">
            <img className="next-onboarding-tablet" src={tabletArtwork} width="1500" height="1067" alt="" draggable={false} />
            <img className="next-onboarding-phone" src={phoneArtwork} width="720" height="1487" alt="" draggable={false} />
          </figure>}
          {page === 3 && <figure className="next-onboarding-computer" data-enabled={computerUse} aria-hidden="true">
            <div className="next-onboarding-screen">
              <div className="next-onboarding-screen-toolbar"><i /><i /><i /></div>
              <div className="next-onboarding-screen-content">
                <div className="next-onboarding-screen-sidebar"><i /><i /><i /></div>
                <div className="next-onboarding-screen-document"><i /><i /><i /><div className="next-onboarding-screen-selection" /></div>
              </div>
              <MousePointer2 className="next-onboarding-pointer" />
            </div>
            <figcaption><span><Scan />{t('查看', 'See')}</span><span><MousePointer2 />{t('点击', 'Click')}</span><span><Keyboard />{t('输入', 'Type')}</span></figcaption>
          </figure>}
          {page === 4 && <div className="next-onboarding-recovery">
            <h2 className="next-onboarding-recovery-title"><LifeBuoy aria-hidden="true" />{t('恢复助手', 'Recovery Assistant')}</h2>
            <ol>
              <li><strong>{t('打开恢复助手', 'Open the recovery assistant')}</strong><p>{t('托盘菜单 → 恢复助手。也可以在设置的“重启”菜单中选择进入恢复模式。', 'Choose Recovery Assistant in the tray menu, or restart into recovery from the Restart menu in Settings.')}</p></li>
              <li><strong>{t('选择恢复方式', 'Choose a recovery option')}</strong><p>{t('尝试临时安全模式、修复 Profile，或回滚到最近成功启动的配置。', 'Try temporary safe mode, repair the Profile, or restore its last successful-start configuration.')}</p></li>
              <li><strong>{t('回到工作中', 'Get back to work')}</strong><p>{t('完成后点击“启动或重试”。仍有问题时，可以导出诊断信息。', 'Choose “Start or retry” when ready. If the issue remains, export diagnostics for help.')}</p></li>
            </ol>
          </div>}
        </aside>
        <div className="next-onboarding-actions">
          <Button className="next-onboarding-next" size="lg" disabled={disabled} onClick={() => void (page === lastPage ? finish(false) : navigate(page + 1))}>
            {busy ? <><LoaderCircle className="animate-spin" />{t('正在进入…', 'Opening…')}</> : page === lastPage ? <>{t('完成并开始', 'Finish and start')}<Check /></> : <>{t('下一步', 'Continue')}<ArrowRight /></>}
          </Button>
        </div>
      </div>
      {failure && <Alert variant="destructive" className="next-onboarding-error"><AlertDescription>{failure}</AlertDescription></Alert>}
    </main>
    <nav className="next-onboarding-nav" aria-label={t('引导导航', 'Setup navigation')}>
      {renderNavigation({ busy: disabled, onBack: page > 0 ? () => void navigate(page - 1) : undefined, onSkip: () => void finish(true) })}
    </nav>
  </div></>
}
