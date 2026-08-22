/** Launcher-owned persistent controller for local and WSL Host selection. */

import {
  readDesktopHostTarget,
  validateDesktopHostTargetSelection,
  writeDesktopHostTarget,
  type DesktopHostTargetSelection,
  type DesktopHostTargetView,
} from './host-target.ts'

export class DesktopHostTargetController {
  private current: DesktopHostTargetSelection
  private discovery: Omit<DesktopHostTargetView, 'current'>

  constructor(
    private readonly statePath: string,
    discovery: Omit<DesktopHostTargetView, 'current'>,
    reportError: (cause: unknown) => void = () => {},
  ) {
    try {
      this.current = readDesktopHostTarget(statePath)
    } catch (cause) {
      reportError(cause)
      this.current = Object.freeze({ mode: 'local' })
      try {
        writeDesktopHostTarget(statePath, this.current)
      } catch (repairCause) {
        reportError(repairCause)
      }
    }
    this.discovery = discovery
  }

  /** Replace the cached native discovery without changing persisted selection. */
  updateDiscovery(discovery: Omit<DesktopHostTargetView, 'current'>): void {
    this.discovery = discovery
  }

  /** Return a renderer-safe immutable snapshot. */
  read(): DesktopHostTargetView {
    return Object.freeze({
      current: this.current,
      distributions: Object.freeze([...this.discovery.distributions]),
      wslSupported: this.discovery.wslSupported,
      ...(this.discovery.problem === undefined ? {} : { problem: this.discovery.problem }),
    })
  }

  /** Persist one currently discoverable target for the next generation. */
  select(selection: DesktopHostTargetSelection): DesktopHostTargetSelection {
    const target = validateDesktopHostTargetSelection(selection, this.discovery)
    writeDesktopHostTarget(this.statePath, target)
    this.current = target
    return target
  }
}
