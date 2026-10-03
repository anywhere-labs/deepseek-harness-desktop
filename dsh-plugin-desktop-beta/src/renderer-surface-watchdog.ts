export const RENDERER_SURFACE_PROBE = String.raw`(() => {
  if (document.visibilityState !== 'visible') return 'hidden';
  if (document.readyState !== 'complete') return null;
  // Official onboarding hides #root and renders its visible surface in body.
  // Inspect the owned portal as content, not merely as a presence exemption.
  const roots = [...document.querySelectorAll('[data-desktop-onboarding-surface]'), document.getElementById('root')].filter(Boolean);
  let visited = 0;
  for (const root of roots) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let element = walker.currentNode;
    while (element && visited < 2048) {
      visited += 1;
      const meaningful = element.matches('button,input,textarea,select,img,svg,canvas,[contenteditable="true"]')
        || Array.from(element.childNodes).some(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
      if (meaningful && element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
        const rect = element.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0
          && rect.top < innerHeight && rect.left < innerWidth) return true;
      }
      element = walker.nextNode();
    }
    if (element) return null;
  }
  return false;
})()`

interface RendererSurfaceWatchdogOptions {
  readonly active: () => boolean
  readonly probe: () => Promise<unknown>
  readonly healthy: () => void
  readonly hidden?: () => void
  readonly failed: (detail: string, unresponsive: boolean) => void
}

export class RendererSurfaceWatchdog {
  private stopped = true
  private epoch = 0
  private failures = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private deadline: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly options: RendererSurfaceWatchdogOptions) {}

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.reset()
  }

  reset(): void {
    this.epoch += 1
    this.failures = 0
    clearTimeout(this.timer)
    clearTimeout(this.deadline)
    this.timer = undefined
    this.deadline = undefined
    if (!this.stopped) this.schedule()
  }

  stop(): void {
    this.stopped = true
    this.reset()
  }

  private schedule(): void {
    this.timer = setTimeout(() => { this.check() }, 5000)
    this.timer.unref()
  }

  private check(): void {
    this.timer = undefined
    if (this.stopped) return
    if (!this.options.active()) {
      this.failures = 0
      this.schedule()
      return
    }
    const epoch = ++this.epoch
    const started = Date.now()
    const finish = (result: unknown, unresponsive = false): void => {
      if (this.stopped || this.epoch !== epoch) return
      this.epoch += 1
      clearTimeout(this.deadline)
      this.deadline = undefined
      if (!this.options.active() || Date.now() - started > 20_000 || result === null) {
        this.failures = 0
      } else if (result === 'hidden') {
        this.failures = 0
        this.options.hidden?.()
      } else if (result === true) {
        this.failures = 0
        this.options.healthy()
      } else {
        this.failures += 1
        if (this.failures >= 2) {
          this.failures = 0
          this.options.failed(unresponsive
            ? 'renderer surface watchdog: page did not respond'
            : 'renderer surface watchdog: page has no visible content', unresponsive)
        }
      }
      if (!this.stopped && this.epoch === epoch + 1) this.schedule()
    }
    this.deadline = setTimeout(() => { finish(false, true) }, 10_000)
    this.deadline.unref()
    try {
      void this.options.probe().then(result => { finish(result) }, () => { finish(null) })
    } catch {
      finish(null)
    }
  }
}
