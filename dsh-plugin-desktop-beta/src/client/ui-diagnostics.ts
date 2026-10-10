/** Forward otherwise invisible client failures to Desktop-owned console capture. */
export function installUiDiagnostics(): () => void {
  const onError = (event: ErrorEvent): void => { console.error(`[desktop-ui-error] ${String(event.error?.stack ?? event.message).slice(0, 8192)}`) }
  const onRejection = (event: PromiseRejectionEvent): void => { console.error(`[desktop-ui-error] ${String(event.reason?.stack ?? event.reason).slice(0, 8192)}`) }
  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)
  return () => { window.removeEventListener('error', onError); window.removeEventListener('unhandledrejection', onRejection) }
}
