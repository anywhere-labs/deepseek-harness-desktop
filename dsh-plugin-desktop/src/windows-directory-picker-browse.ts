/** Windows browse-picker adapter that hides directory links Node cannot enumerate. */

import { lstat, opendir } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type {
  DirectoryListing,
  DirectoryPickerBrowseCapability,
  DirectoryPickerCapability,
} from '@deepseek-ai/dsh-host-directory-picker'
import BrowseDirectoryPicker, {
  raceAbort,
  type Config as BrowseDirectoryPickerConfig,
} from '@deepseek-ai/dsh-host-directory-picker-browse'

interface DirectoryLinkStats {
  isSymbolicLink(): boolean
}

interface OpenDirectoryHandle {
  close(): Promise<void>
}

export type DirectoryLinkStatProbe = (path: string) => Promise<DirectoryLinkStats>
export type OpenDirectoryProbe = (path: string) => Promise<OpenDirectoryHandle>
export type DirectoryEntryProbe = (path: string, signal?: AbortSignal) => Promise<boolean>

function swallowCloseFailure(): void {}

/** Return whether one upstream listing entry is either a regular directory or an openable directory link. */
export async function isEnterableDirectoryLink(
  path: string,
  signal?: AbortSignal,
  statPath: DirectoryLinkStatProbe = async value => await lstat(value),
  openPath: OpenDirectoryProbe = async value => await opendir(value),
): Promise<boolean> {
  let stats: DirectoryLinkStats
  try {
    stats = await raceAbort(statPath(path), signal)
  } catch {
    signal?.throwIfAborted()
    return false
  }
  if (!stats.isSymbolicLink()) return true

  const opening = openPath(path)
  let directory: OpenDirectoryHandle
  try {
    directory = await raceAbort(opening, signal)
  } catch {
    void opening.then(handle => handle.close().catch(swallowCloseFailure), () => {})
    signal?.throwIfAborted()
    return false
  }

  const closing = directory.close()
  if (signal?.aborted) {
    void closing.catch(swallowCloseFailure)
    signal.throwIfAborted()
  }
  await closing.catch(swallowCloseFailure)
  return true
}

/** Remove only entries whose link target cannot be enumerated, preserving the upstream listing contract. */
export async function filterUnreadableDirectoryLinks(
  listing: DirectoryListing,
  signal?: AbortSignal,
  probe: DirectoryEntryProbe = isEnterableDirectoryLink,
): Promise<DirectoryListing> {
  const entries = []
  for (const entry of listing.entries) {
    signal?.throwIfAborted()
    if (await probe(entry.path, signal)) entries.push(entry)
  }
  return entries.length === listing.entries.length ? listing : { ...listing, entries }
}

/** Desktop-owned Windows provider that retains upstream browse behavior and filters unreadable junctions. */
export class DesktopWindowsBrowseDirectoryPicker extends BrowseDirectoryPicker {
  private desktopCapability: DirectoryPickerBrowseCapability | undefined

  constructor(ctx: Context, config: BrowseDirectoryPickerConfig) {
    super(ctx, config)
    const upstream = super.capability()
    if (upstream.kind !== 'browse') {
      throw new Error('dsh-plugin-desktop: upstream directory picker did not provide browse capability')
    }
    this.desktopCapability = {
      ...upstream,
      list: async (path, signal) => await filterUnreadableDirectoryLinks(
        await upstream.list(path, signal),
        signal,
      ),
    }
  }

  /** @inheritdoc */
  override capability(): DirectoryPickerCapability {
    return this.desktopCapability ?? super.capability()
  }
}

export default DesktopWindowsBrowseDirectoryPicker
