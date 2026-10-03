/** A narrow appearance channel; native preferences do not require the Host. */
import { ipcRenderer } from 'electron'
import { IPC } from './ipc.ts'
export function syncWindowMaterial(): void {
  const apply = (value: unknown): void => {
    if (value === 'off' || value === 'transparent') document.documentElement.dataset.nextMaterial = value
  }
  const ready = (): void => {
    ipcRenderer.on(IPC.material, (_event, value: unknown) => apply(value))
    void ipcRenderer.invoke(IPC.material).then(apply).catch(() => {})
  }
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', ready, { once: true })
  else ready()
}
