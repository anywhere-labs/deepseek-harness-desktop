/**
 * Ranked registry of file-viewer providers (design §6.4, §16.8). Providers
 * register themselves with a priority, a capability predicate over a descriptor,
 * a load mode, and a render component; the registry resolves the highest
 * priority match with a stable, registration-ordered tie-break. No format or
 * extension `switch` lives here — capability judgment stays entirely with each
 * provider.
 * @module dsh-plugin-desktop/client/file-preview/registry
 */

import type { ComponentType } from 'react'
import type { FilePreviewDescriptor } from '../../file-preview-contract.ts'
import type { FilePreviewContent } from './controller.ts'

/** How the provider loads a descriptor's payload through the gateway. */
export type FilePreviewLoadMode = 'text' | 'binary-url' | 'metadata-only'

/**
 * Props the panel hands to a provider component. Stage 2 keeps this surface
 * minimal; the file-preview surface wires the real values in stage 3.
 */
export interface FilePreviewRendererProps {
  /** The resolved descriptor being rendered. */
  descriptor: FilePreviewDescriptor
  /** The loaded content the provider renders (`text`, `binary-url`, or none). */
  content: FilePreviewContent
  /** Ask the host to open the current file with the system default application. */
  onOpenExternally(): void
}

/** One strategy that can render a supported file format. */
export interface FilePreviewProvider {
  /** Stable, unique provider identity. */
  id: string
  /** Higher wins when multiple providers support the same descriptor. */
  priority: number
  /** Which gateway load path the controller uses before rendering. */
  loadMode: FilePreviewLoadMode
  /** Whether this provider accepts the descriptor. */
  supports(descriptor: FilePreviewDescriptor): boolean
  /** Read-only render component. */
  Component: ComponentType<FilePreviewRendererProps>
}

/** Registration slot tracking a provider plus its monotonically-ordered id. */
interface Registration {
  provider: FilePreviewProvider
  order: number
}

/**
 * Ranked provider registry for the built-in file viewer. Registration order
 * breaks same-priority ties (earliest wins) so resolution stays deterministic
 * regardless of insertion order changes across reloads.
 */
export class FilePreviewRegistry {
  private readonly registrations: Registration[] = []
  private readonly ids = new Map<string, FilePreviewProvider>()
  private order = 0

  /**
   * Register a provider. A duplicate id throws immediately.
   * @param provider - the provider to register.
   * @returns an idempotent disposer that removes exactly this registration.
   */
  register(provider: FilePreviewProvider): () => void {
    if (this.ids.has(provider.id)) {
      throw new Error(`dsh-plugin-desktop: duplicate file preview provider id "${provider.id}"`)
    }
    const registration: Registration = { provider, order: this.order++ }
    this.registrations.push(registration)
    this.ids.set(provider.id, provider)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      const index = this.registrations.indexOf(registration)
      if (index === -1) return
      this.registrations.splice(index, 1)
      this.ids.delete(provider.id)
    }
  }

  /**
   * Resolve the highest-priority provider matching a descriptor; ties resolve
   * to the earliest registered.
   * @param descriptor - the descriptor to match.
   * @returns the matching provider, or `undefined` when none match.
   */
  resolve(descriptor: FilePreviewDescriptor): FilePreviewProvider | undefined {
    let best: Registration | undefined
    for (const registration of this.registrations) {
      if (!registration.provider.supports(descriptor)) continue
      if (best === undefined
        || registration.provider.priority > best.provider.priority
        || (registration.provider.priority === best.provider.priority && registration.order < best.order)) {
        best = registration
      }
    }
    return best?.provider
  }

  /**
   * Snapshot of the currently registered providers in registration order, for
   * tests and diagnostics.
   */
  list(): readonly FilePreviewProvider[] {
    return this.registrations.map(registration => registration.provider)
  }
}
