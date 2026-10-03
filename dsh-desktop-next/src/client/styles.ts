/** Native materials and interactions around the official page headers. */
const STYLES = `
.dshNextSafeModeNotice{position:absolute;right:16px;bottom:16px;max-width:300px;padding:12px;border:1px solid var(--dsw-alias-border-l3);border-radius:10px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:12px/1.5 system-ui,sans-serif;pointer-events:auto;-webkit-app-region:no-drag}
.dshNextSafeModeNotice p{margin:5px 0 8px}.dshNextSafeModeNotice button{font:inherit;border:1px solid currentColor;border-radius:5px;padding:4px 8px;background:transparent;color:inherit;cursor:pointer}

.dshNextSafeModeNotice .dshNextSafeModeDismiss{float:right;border:0;margin:-4px -4px 0 8px;padding:0 6px;font-size:20px;line-height:24px}

/* Respect the native-material preference without replacing official layout. */
html[data-next-material='off'][data-platform='darwin'] :has(> [data-shell-overlay]) {
  background: var(--dsw-alias-bg-base);
}
/* The stable main column owns an invisible caption region. The official page
   and its title keep their original layout and scroll underneath it. */
html[data-platform='darwin'] :has(> [data-shell-overlay]) > :has([data-plugin-panel]) {
  position: relative;
  isolation: isolate;
}
html[data-platform='darwin'] :has(> [data-shell-overlay]) > :has([data-plugin-panel])::before {
  content: '';
  position: absolute;
  inset: 0 0 auto;
  height: 52px;
  z-index: -1;
  pointer-events: none;
  user-select: none;
  -webkit-app-region: drag;
}
/* The official sidebar toggle stays beside the native traffic lights, outside
   the centered title's layout and the page's scrolling coordinate system. */
html[data-platform='darwin'] [data-plugin-sidebar-control] {
  display: none;
  position: fixed;
  top: 12px;
  left: 88px;
  width: auto;
  z-index: 2;
}
html[data-platform='darwin'] [data-sidebar-collapsed] [data-plugin-sidebar-control] { display: flex; }
html[data-platform='darwin'] [data-plugin-sidebar-control] [data-sidebar-header-controls] { padding: 0; margin: 0; }
/* These controls remain clickable even when scrolled into the caption region. */
html[data-platform='darwin'] [data-plugin-panel] :is(button, a, input, textarea, select, label, summary, [contenteditable='true'], [role='button'], [role='switch'], [role='radio'], [role='checkbox'], [role='tab'], [role='menuitem'], [role='slider']),
html[data-platform='darwin'] [data-plugin-sidebar-control] { -webkit-app-region: no-drag; }
/* dsh 0.1.7 moved its own drag band onto the AppFrame seat and dropped the
   conversation title row's caption region, so Desktop restates it here. The
   official rules for the leading/actions/utilities/corner clusters still ship. */
html[data-platform='darwin'] [data-conversation-title-row] { -webkit-app-region: drag; }
html[data-platform='darwin'] [data-conversation-title-row] :is(button, a) { -webkit-app-region: no-drag; }
/* A modal or full-screen right pane owns its own input surface. */
html:has([aria-modal='true']) [data-conversation-title-row],
html:has([aria-modal='true']) :has(> [data-shell-overlay]) > :has([data-plugin-panel])::before,
[data-rightbar-fullscreen] [data-conversation-title-row],
[data-rightbar-fullscreen]:has(> [data-shell-overlay]) > :has([data-plugin-panel])::before { -webkit-app-region: no-drag; }
`

export function installWindowStyles(): () => void {
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-desktop-next/window-controls'
  style.textContent = STYLES
  document.head.append(style)
  return () => style.remove()
}
