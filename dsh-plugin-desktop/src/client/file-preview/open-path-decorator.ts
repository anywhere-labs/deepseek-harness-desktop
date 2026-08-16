/**
 * Reversible decorator over `WorkspaceRuntime.openPath` for the built-in file
 * viewer (design §6.1, §16.7). The constructor only captures the original
 * method and receiver so assembly can obtain `openSystemPath`, build the
 * controller around it, and only then `install()` the preview callback.
 * Install defines an own `openPath` wrapper that probes known/extensionless
 * files and falls through to the original only on delegation; dispose restores
 * the original descriptor exactly when the current `openPath` is still this
 * wrapper, never clobbering a later-installed one. The explicit system-open
 * path always bypasses the wrapper.
 * @module dsh-plugin-desktop/client/file-preview/open-path-decorator
 */

import { classifyFileName } from '../../file-preview-formats.ts'

/** The preview decision a file click is routed into. */
export type FilePreviewIntercept = (sessionId: string, path: string) => Promise<'handled' | 'delegate'>

/** The workspace surface whose `openPath` is decorated. */
export interface OpenPathSurface {
  openPath(path: string): Promise<void>
}

/** Basename of a path using either native separator, like the Host gateway. */
function baseNameOf(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const index = normalized.lastIndexOf('/')
  return index === -1 ? normalized : normalized.slice(index + 1)
}

/**
 * Reversible method decorator. Construct without installing anything; the
 * captured original stays available via {@link openSystemPath} so an explicit
 * system-open never re-enters the wrapper.
 */
export class WorkspacesOpenPathDecorator {
  private readonly isOwn: boolean
  private readonly originalDescriptor: PropertyDescriptor | undefined
  private readonly originalMethod: (path: string) => Promise<void>
  private readonly receiver: OpenPathSurface
  private wrapper: ((path: string) => Promise<void>) | undefined
  private disposed = false

  constructor(
    private readonly workspaces: OpenPathSurface,
    private readonly getCurrentSessionId: () => string | undefined,
  ) {
    this.receiver = workspaces
    this.isOwn = Object.hasOwn(workspaces, 'openPath')
    if (this.isOwn) this.originalDescriptor = Object.getOwnPropertyDescriptor(workspaces, 'openPath')
    const resolved = workspaces.openPath
    if (typeof resolved !== 'function') {
      throw new Error('dsh-plugin-desktop: workspaces.openPath must be a function')
    }
    this.originalMethod = resolved
  }

  /**
   * Open a path with the system default application via the captured original,
   * bypassing the installed wrapper entirely.
   * @param path - the raw path to open.
   */
  openSystemPath(path: string): Promise<void> {
    return this.originalMethod.call(this.receiver, path)
  }

  /**
   * Install the own `openPath` wrapper. Safe to call after the controller is
   * created; repeated install replaces the wrapper with a fresh one.
   * @param preview - the controller's `preview` used to decide handling.
   */
  install(preview: FilePreviewIntercept): void {
    const wrapper = (path: string): Promise<void> => this.dispatch(preview, path)
    this.wrapper = wrapper
    Object.defineProperty(this.workspaces, 'openPath', {
      value: wrapper,
      configurable: true,
      writable: true,
      enumerable: !this.isOwn || Boolean(this.originalDescriptor?.enumerable),
    })
  }

  /**
   * Restore the original `openPath` when this wrapper is still installed.
   * Repeated calls are no-ops and a later-installed wrapper is never clobbered.
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const current = this.workspaces.openPath
    if (current !== this.wrapper) return
    if (this.isOwn) {
      if (this.originalDescriptor !== undefined) {
        Object.defineProperty(this.workspaces, 'openPath', this.originalDescriptor)
      }
    } else {
      delete (this.workspaces as { openPath?: (path: string) => Promise<void> })['openPath']
    }
    this.wrapper = undefined
  }

  /** Route one open call through the lexical pre-check and probe decision. */
  private async dispatch(preview: FilePreviewIntercept, path: string): Promise<void> {
    const { definition, extension } = classifyFileName(baseNameOf(path))
    // Unknown extension (and not a matched special filename, which yields a
    // definition and an empty extension): fall straight through to the system open.
    if (definition === undefined && extension !== '') {
      return this.originalMethod.call(this.receiver, path)
    }
    const sessionId = this.getCurrentSessionId()
    if (sessionId === undefined) {
      return this.originalMethod.call(this.receiver, path)
    }
    const outcome = await preview(sessionId, path)
    if (outcome === 'delegate') {
      return this.originalMethod.call(this.receiver, path)
    }
    // 'handled': the controller owns the click; the system open is never invoked.
  }
}
