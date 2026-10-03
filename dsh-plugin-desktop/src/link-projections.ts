/** Retire dsh 0.1.5 link-backend projections without traversing junction targets. */
import { lstatSync, readdirSync, readlinkSync, realpathSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { cleanupDisposableTree } from './disposable-tree.ts'

/** Directory where the dsh 0.1.5 link backend projected bundle-carried packages into a profile. */
export const LINK_PROJECTION_DIR = '.dsh-module-fallback'

/** Top-level and scoped `node_modules` entries that are symlinks or junctions. */
function symlinksUnder(modules: string): string[] {
  const links: string[] = []
  let entries
  try {
    entries = readdirSync(modules, { withFileTypes: true })
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return links
    throw cause
  }
  for (const entry of entries) {
    const path = join(modules, entry.name)
    if (entry.isSymbolicLink()) {
      links.push(path)
    } else if (entry.name.startsWith('@') && entry.isDirectory()) {
      for (const child of readdirSync(path, { withFileTypes: true })) {
        if (child.isSymbolicLink()) links.push(join(path, child.name))
      }
    }
  }
  return links
}

/** Whether a link's target lies in `root`, compared through the target's real parent directory. */
function pointsInto(link: string, root: string): boolean {
  try {
    const target = resolve(dirname(link), readlinkSync(link))
    const parent = realpathSync.native(dirname(target))
    const rootPath = realpathSync.native(root)
    return parent === rootPath || parent.startsWith(rootPath + sep)
  } catch (cause) {
    // A target whose parent no longer exists cannot be one of the projection links.
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw cause
  }
}

/**
 * Remove the package projections a dsh 0.1.5 link-backend launch left in one profile.
 *
 * Selection matches upstream `removeLinkProjections`: only `node_modules` links whose
 * target lies inside `<profile>/.dsh-module-fallback/node_modules` are unlinked, then that
 * directory is removed; pnpm-installed packages and every other link stay.
 *
 * Upstream finishes with `rmSync(owned, { recursive: true })`. The projection directory
 * holds junctions into a Desktop installation, and Electron 44's Node (24.18.1) follows
 * those junctions during a recursive `rmSync`, emptying the installation packages they
 * point to. Desktop therefore never calls the upstream helper and removes every link
 * itself without visiting its target.
 * @param dir - the profile directory.
 * @returns whether a projection directory was present.
 */
export function removeLinkProjectionsSafely(dir: string): boolean {
  const owned = join(dir, LINK_PROJECTION_DIR)
  if (lstatSync(owned, { throwIfNoEntry: false }) === undefined) return false
  const ownedModules = join(owned, 'node_modules')
  for (const link of symlinksUnder(join(dir, 'node_modules'))) {
    if (pointsInto(link, ownedModules)) unlinkSync(link)
  }
  cleanupDisposableTree(owned)
  return true
}
