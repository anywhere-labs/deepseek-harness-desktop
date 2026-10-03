import '../shared/theme.css'
import './style.css'
import { CSPProvider } from '@base-ui/react/csp-provider'
import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import type { CompatibilityChromeBridge, CompatibilityChromeCommand, CompatibilityChromeState } from '../../compatibility-chrome-contract.ts'
import { DesktopFrameTitlebarView } from '../../client/DesktopFrameTitlebarView.tsx'
import { en, zh } from '../../client/desktop-settings-locales.ts'
import { installChromeOverlay } from './overlay.ts'

declare global {
  interface Window { desktopChrome: CompatibilityChromeBridge }
}

const invoke = async (command: CompatibilityChromeCommand): Promise<void> => { await window.desktopChrome.invoke(command) }
const api = {
  openTerminal: () => invoke('terminal'),
  restart: () => invoke('restart'),
  restartToRecovery: () => invoke('restart-recovery'),
  reloadRenderer: () => invoke('reload'),
  toggleDeveloperTools: () => invoke('developer'),
  checkForUpdates: () => invoke('check-for-updates'),
}

export function Chrome() {
  const [state, setState] = useState<CompatibilityChromeState>()
  const [generation, setGeneration] = useState(0)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const off = window.desktopChrome.subscribe(setState)
    const dismiss = (): void => { setGeneration(value => value + 1) }
    const offDismiss = window.desktopChrome.onDismiss(dismiss)
    const offOverlay = installChromeOverlay(invoke, dismiss, () => { setFailed(true) })
    void window.desktopChrome.invoke('state').then(value => { if (value) setState(value) }).catch(() => { setFailed(true) })
    return () => { off(); offDismiss(); offOverlay() }
  }, [])
  useEffect(() => {
    document.documentElement.lang = state?.locale === 'zh' ? 'zh-CN' : 'en'
  }, [state?.locale])
  const copy = state?.locale === 'zh' ? zh : en
  if (!state) return <header className="dshDesktopFrameTitlebar">DSH Desktop {failed && <span role="alert">{copy.operationFailed}</span>}</header>
  return <DesktopFrameTitlebarView
    key={generation}
    api={api}
    {...(state.remoteControl && !state.remoteControl.enabled ? { remoteControl: {
      seen: state.remoteControl.seen,
      open: () => invoke('remote-control'),
    } } : {})}
    t={key => copy[key]}
    environment={{ ...state, material: state.material !== 'off' && state.platform === 'darwin' ? 'transparent' : 'off' }}
    setMode={mode => mode === state.mode ? Promise.resolve() : invoke(`mode-${mode}`)}
  />
}

const root = document.getElementById('root')
if (root === null) throw new Error('dsh-desktop: missing chrome root')
createRoot(root).render(<CSPProvider disableStyleElements><Chrome /></CSPProvider>)
