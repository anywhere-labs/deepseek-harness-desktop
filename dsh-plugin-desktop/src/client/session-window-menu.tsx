import type { Context } from '@deepseek-ai/cordis'
import { MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { SESSION_WINDOW_UI } from '../session-window-contract.ts'
import type {} from './session-window.ts'

function OpenWindowItem({ sessionId, useMenuOpenState }: PropsRuntime<'sidebar.workspaces.session.menu.item'>) {
  const [, setOpen] = useMenuOpenState()
  const bridge = window[SESSION_WINDOW_UI]
  if (!bridge) return null
  return <MenuItemButton icon={<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="2" stroke="currentColor" /><path d="M2 6h12M5 4.5h.01M7 4.5h.01" stroke="currentColor" strokeLinecap="round" /></svg>} disabled={!bridge.canOpen(sessionId)} onSelect={() => {
    setOpen(false)
    bridge.open(sessionId)
  }}>{bridge.label}</MenuItemButton>
}

/** Both editions use the upstream public session-menu slot. */
export function installSessionWindowMenu(ctx: Context): void {
  ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
    name: 'sidebar.workspaces.session.menu.item', id: 'desktop-session-window', order: 50,
  }, OpenWindowItem))
}
