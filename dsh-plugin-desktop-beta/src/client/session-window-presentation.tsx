import { createRoot } from 'react-dom/client'
import { BrandWordmark, FishLogo } from '@deepseek-ai/dsh-client-ui-primitives'

/** Keep the existing conversation/right panel; only remove the surrounding navigation. */
export function installSessionWindowPresentation(): () => void {
  const style = document.createElement('style')
  style.textContent = `
body[data-dsh-session-window] #root { height:100% !important; }
.dshSessionWindowBrand { position:absolute; top:10px; left:18px; height:30px; gap:8px; display:flex; align-items:center; color:var(--dsw-alias-label-primary); z-index:10; pointer-events:none; }
body[data-dsh-session-window] header:has([data-conversation-header-corner]) [class*="_titleRow"] { padding-inline-start:196px !important; }
body[data-dsh-session-window] header:has([data-conversation-header-corner]) [class*="_crumbs"] { display:none !important; }
body[data-dsh-session-window] :is([class*="_frame"], .dshDesktopFrame):has(> [data-rightbar-col]) { display:flex !important; height:100% !important; padding:0 !important; border:0 !important; }
body[data-dsh-session-window] :is([class*="_sidebarCol"], .dshDesktopSidebarSurface, [data-shell-leading-band], [data-shell-leading], .dshDesktopMacCaptionRow, .dshDesktopWindowsCaptionRow, [data-conversation-header-leading]) { display:none !important; }
body[data-dsh-session-window] :is([class*="_centerCol"], .dshDesktopConversationSurface) { flex:1; min-width:0; border-radius:0 !important; }
body[data-dsh-session-window] [data-rightbar-col] { flex:0 0 45%; min-width:0; }
body[data-dsh-session-window] [data-rightbar-collapsed="true"] > [data-rightbar-col] { display:none !important; }
body[data-dsh-session-window] [data-rightbar-fullscreen="true"] > [data-rightbar-col] { flex:1; }
body[data-dsh-session-window] [data-rightbar-fullscreen="true"] > :is([class*="_centerCol"], .dshDesktopConversationSurface) { display:none; }
body[data-dsh-session-window] :is(.dshDesktopResizeHandle, :is([class*="_frame"], .dshDesktopFrame):has(> [data-rightbar-col]) > [data-side]) { display:none !important; }
body[data-dsh-session-window] [data-shell-overlay] { position:absolute; inset:0; pointer-events:none; }
body[data-dsh-session-window] [data-shell-overlay] > * { pointer-events:auto; }
.dshSessionWindowUnavailable { display:none; position:fixed; inset:0; align-items:center; justify-content:center; background:var(--dsw-alias-bg-base); z-index:100; }
body[data-dsh-session-unavailable="true"] .dshSessionWindowUnavailable { display:flex; }
`
  const brand = document.createElement('div')
  brand.className = 'dshSessionWindowBrand'
  const root = createRoot(brand)
  root.render(<><FishLogo size={24} /><BrandWordmark size={24} includeMark={false} /></>)
  const unavailable = document.createElement('div')
  unavailable.className = 'dshSessionWindowUnavailable'
  unavailable.setAttribute('role', 'status')
  unavailable.textContent = '会话不可用或已归档'
  document.head.append(style)
  document.body.prepend(brand)
  document.body.append(unavailable)
  document.body.dataset.dshSessionWindow = ''
  document.body.dataset.dshSessionUnavailable = 'true'
  return () => {
    root.unmount(); brand.remove(); unavailable.remove(); style.remove()
    delete document.body.dataset.dshSessionWindow
  }
}
