/**
 * Built-in file-viewer provider registration (design §4, §6.4, §16.5). The
 * registry remains the only dispatch point; this aggregate installs the four
 * Desktop providers with their fixed priorities and `supports()` rules and
 * returns disposers so the owning fiber can unregister all of them together.
 * @module dsh-plugin-desktop/client/file-preview/providers
 */

import type { FilePreviewRegistry } from '../registry.ts'
import { registerImageProvider } from './ImagePreview.tsx'
import { registerJsonProvider } from './JsonPreview.tsx'
import { registerMarkdownProvider } from './MarkdownPreview.tsx'
import { registerSourceProvider } from './SourcePreview.tsx'

/**
 * Register every built-in viewer provider on the given registry.
 * @param registry - the ranked provider registry.
 * @returns disposers for all four registrations, kept in the fiber for teardown.
 */
export function registerFilePreviewProviders(registry: FilePreviewRegistry): Array<() => void> {
  return [
    registerJsonProvider(registry),
    registerMarkdownProvider(registry),
    registerImageProvider(registry),
    registerSourceProvider(registry),
  ]
}
