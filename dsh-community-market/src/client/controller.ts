export class MarketController {
  private opened = false
  private readonly listeners = new Set<() => void>()

  readonly getSnapshot = (): boolean => this.opened

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  open(): void {
    this.setOpened(true)
  }

  close(): void {
    this.setOpened(false)
  }

  private setOpened(opened: boolean): void {
    if (this.opened === opened) return
    this.opened = opened
    this.listeners.forEach(listener => listener())
  }
}
