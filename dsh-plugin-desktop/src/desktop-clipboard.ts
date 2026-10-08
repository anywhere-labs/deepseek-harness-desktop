/**
 * Desktop clipboard seam: the Electron clipboard, provided by the launcher and
 * consumed through `ctx.get('desktopClipboard')`. Headless boots do not provide
 * it, so consumers must treat it as optional and degrade gracefully.
 *
 * @module dsh-plugin-desktop-beta/desktop-clipboard
 */

/** System clipboard read/write surface exposed by the Electron launcher. */
export interface DesktopClipboard {
  /** Replace the clipboard text with `text`. */
  writeText(text: string): void
  /** Read the current clipboard text (empty string when absent or non-text). */
  readText(): string
}

/** In-memory clipboard for headless boots and tests (no Electron required). */
export function createMemoryClipboard(): DesktopClipboard {
  let text = ''
  return {
    writeText: value => { text = value },
    readText: () => text,
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Present only when the Electron launcher injected the system clipboard. */
    desktopClipboard?: DesktopClipboard
  }
}
