import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import {
  describeWslRuntimeBundleFile,
  WSL_RUNTIME_BUNDLE_MANIFEST,
  WSL_RUNTIME_BUNDLE_SCHEMA_VERSION,
  WSL_RUNTIME_PACKAGE_NAME,
} from '../../src/wsl-runtime-bundle.ts'

export const FIXTURE_WSL_RUNTIME_VERSION = '2.0.2'

/** Write a small structurally complete bundle without contacting a registry. */
export function writeWslRuntimeBundleFixture(
  root: string,
  version = FIXTURE_WSL_RUNTIME_VERSION,
): void {
  const sourcesRoot = join(root, 'sources')
  mkdirSync(sourcesRoot, { recursive: true })
  writeFileSync(join(sourcesRoot, 'dsh-plugin-desktop-2.0.2.tgz'), 'desktop archive')
  writeFileSync(join(sourcesRoot, 'dsh-community-market-0.1.0-dev.0.tgz'), 'market archive')
  const dependencies = {
    '@deepseek-ai/dsh': '0.1.1-rc.1',
    'dsh-community-market': 'file:./sources/dsh-community-market-0.1.0-dev.0.tgz',
    'dsh-plugin-desktop': 'file:./sources/dsh-plugin-desktop-2.0.2.tgz',
  }
  const packageJson = {
    name: WSL_RUNTIME_PACKAGE_NAME,
    version,
    private: true,
    dependencies,
  }
  const packageLock = {
    name: WSL_RUNTIME_PACKAGE_NAME,
    version,
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: WSL_RUNTIME_PACKAGE_NAME, version, dependencies },
    },
  }
  writeFileSync(join(root, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`)
  writeFileSync(join(root, 'package-lock.json'), `${JSON.stringify(packageLock, null, 2)}\n`)
  const paths = [
    'package-lock.json',
    'package.json',
    'sources/dsh-community-market-0.1.0-dev.0.tgz',
    'sources/dsh-plugin-desktop-2.0.2.tgz',
  ]
  const manifest = {
    schemaVersion: WSL_RUNTIME_BUNDLE_SCHEMA_VERSION,
    productVersion: version,
    packageCount: Object.keys(dependencies).length,
    files: paths.map(path => describeWslRuntimeBundleFile(root, path)),
  }
  writeFileSync(join(root, WSL_RUNTIME_BUNDLE_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`)
}

/** Enumerate fixture files with bundle-relative POSIX paths. */
export function listWslRuntimeBundleFixture(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => relative(root, join(entry.parentPath, entry.name)).replaceAll('\\', '/'))
    .sort((left, right) => left.localeCompare(right, 'en'))
}
