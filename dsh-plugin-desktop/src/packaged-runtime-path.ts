/** Physical-path helpers for dependencies Electron Builder removes from app.asar. */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

function resolvePackageRoot(moduleUrl: string, packageName: string): string {
  const resolve = createRequire(moduleUrl).resolve
  try {
    return dirname(resolve(`${packageName}/package.json`))
  } catch (manifestCause) {
    let directory: string
    try {
      directory = dirname(resolve(packageName))
    } catch {
      throw manifestCause
    }
    while (true) {
      try {
        const manifest: unknown = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
        if (manifest !== null
          && typeof manifest === 'object'
          && (manifest as { name?: unknown }).name === packageName) {
          return directory
        }
      } catch {
        // Continue toward the filesystem root until the owning package is found.
      }
      const parent = dirname(directory)
      if (parent === directory) throw manifestCause
      directory = parent
    }
  }
}

/**
 * Map one logical ASAR path to the sibling physical unpacked tree.
 * @param filename - absolute runtime path with native or POSIX separators.
 * @returns the physical unpacked path, or the original path outside a package.
 */
export function unpackedAsarPath(filename: string): string {
  return filename.replace(/([\\/])app\.asar\1/u, '$1app.asar.unpacked$1')
}

/**
 * Resolve one dependency entry from a built desktop module.
 * @param moduleUrl - URL of a module emitted below the package's `lib` directory.
 * @param dependencyEntry - package subpath resolved through Node module lookup.
 * @returns a physical path suitable for Node execution and profile symlinks.
 */
export function packagedDependencyPath(moduleUrl: string, dependencyEntry: string): string {
  const segments = dependencyEntry.split('/')
  if (dependencyEntry.length === 0
    || dependencyEntry.startsWith('/')
    || dependencyEntry.includes('\\')
    || segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')
    || (segments[0]?.startsWith('@') === true && segments.length < 2)) {
    throw new Error('dsh-plugin-desktop: packaged dependency entry must be a relative POSIX path')
  }
  const packageSegments = segments[0]?.startsWith('@') === true ? 2 : 1
  const packageName = segments.slice(0, packageSegments).join('/')
  const logicalPath = join(
    resolvePackageRoot(moduleUrl, packageName),
    ...segments.slice(packageSegments),
  )
  return unpackedAsarPath(logicalPath)
}
