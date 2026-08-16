/** Validate that a desktop release tag names the exact stable workspace version. */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function manifestVersion(path: string, label: string): string {
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown }
  if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+$/u.test(manifest.version)) {
    throw new Error(`${label} version must be a stable MAJOR.MINOR.PATCH value`)
  }
  return manifest.version
}

/**
 * Verify one tag and the two product package manifests.
 * @param tag - Git tag in `vMAJOR.MINOR.PATCH` form.
 * @param workspaceManifestPath - product workspace manifest path.
 * @param desktopManifestPath - Electron package manifest path.
 * @returns The validated stable version.
 */
export function verifyDesktopReleaseVersion(
  tag: string,
  workspaceManifestPath: string,
  desktopManifestPath: string,
): string {
  const workspaceVersion = manifestVersion(workspaceManifestPath, 'workspace')
  const desktopVersion = manifestVersion(desktopManifestPath, 'desktop package')
  if (workspaceVersion !== desktopVersion) {
    throw new Error(`workspace version ${workspaceVersion} must equal desktop package version ${desktopVersion}`)
  }
  if (tag !== `v${desktopVersion}`) {
    throw new Error(`desktop release tag ${JSON.stringify(tag)} must equal v${desktopVersion}`)
  }
  return desktopVersion
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const workspaceRoot = resolve(desktopRoot, '..')
  const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME ?? ''
  try {
    console.log(verifyDesktopReleaseVersion(
      tag,
      join(workspaceRoot, 'package.json'),
      join(desktopRoot, 'package.json'),
    ))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
