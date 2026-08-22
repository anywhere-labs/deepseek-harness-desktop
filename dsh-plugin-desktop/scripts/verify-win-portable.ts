/** Verify the unsigned Windows x64 portable ZIP archive. */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import AdmZip from 'adm-zip'
import {
  verifyWslRuntimeBundle,
  WSL_RUNTIME_BUNDLE_DIRECTORY,
} from '../src/wsl-runtime-bundle.ts'
import { assertPortableExecutableBuffer } from './verify-win-installer.ts'

export interface WindowsPortableVerificationOptions {
  /** Desktop package root containing package.json and dist. */
  readonly desktopRoot: string
  /** Product version embedded in the expected artifact name. */
  readonly version: string
}

function readVersion(desktopRoot: string): string {
  const manifest = JSON.parse(readFileSync(join(desktopRoot, 'package.json'), 'utf8')) as {
    version?: unknown
  }
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new Error(`desktop package at ${desktopRoot} has no valid version`)
  }
  return manifest.version
}

function defaultOptions(): WindowsPortableVerificationOptions {
  const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  return { desktopRoot, version: readVersion(desktopRoot) }
}

/** Verify the exact versioned portable archive and its application entry. */
export function verifyWindowsPortable(
  options: WindowsPortableVerificationOptions = defaultOptions(),
): string {
  const portablePath = join(
    options.desktopRoot,
    'dist',
    `DSH-Desktop-${options.version}-x64-Portable.zip`,
  )
  const stat = statSync(portablePath)
  if (!stat.isFile() || stat.size === 0) {
    throw new Error(`Windows portable archive is not a non-empty regular file: ${portablePath}`)
  }
  const archive = new AdmZip(portablePath)
  const entries = archive.getEntries().filter(entry => !entry.isDirectory)
  const executable = entries.find(entry => entry.entryName.replaceAll('\\', '/') === 'DSH Desktop.exe')
  if (executable === undefined) {
    throw new Error(`Windows portable archive is missing DSH Desktop.exe: ${portablePath}`)
  }
  if (!entries.some(entry => entry.entryName.replaceAll('\\', '/') === 'resources/app.asar')) {
    throw new Error(`Windows portable archive is missing resources/app.asar: ${portablePath}`)
  }
  assertPortableExecutableBuffer(
    executable.getData(),
    'Windows portable application',
    `${portablePath}:DSH Desktop.exe`,
  )
  const prefix = `resources/${WSL_RUNTIME_BUNDLE_DIRECTORY}/`
  const bundleEntries = entries.filter(entry => entry.entryName.replaceAll('\\', '/').startsWith(prefix))
  if (bundleEntries.length === 0) {
    throw new Error(`Windows portable archive is missing ${prefix}: ${portablePath}`)
  }
  const extractionRoot = mkdtempSync(join(tmpdir(), 'dsh-win-portable-wsl-runtime-'))
  try {
    for (const entry of bundleEntries) {
      const name = entry.entryName.replaceAll('\\', '/').slice(prefix.length)
      if (name.length === 0 || name.startsWith('/') || name.split('/').includes('..')) {
        throw new Error(`Windows portable archive has an unsafe WSL runtime entry: ${entry.entryName}`)
      }
      const output = resolve(extractionRoot, ...name.split('/'))
      const relative = output.slice(extractionRoot.length + 1)
      if (relative.length === 0 || relative.startsWith('..')) {
        throw new Error(`Windows portable archive has an unsafe WSL runtime entry: ${entry.entryName}`)
      }
      mkdirSync(dirname(output), { recursive: true })
      writeFileSync(output, entry.getData())
    }
    verifyWslRuntimeBundle(extractionRoot, options.version)
  } finally {
    rmSync(extractionRoot, { recursive: true, force: true })
  }
  return portablePath
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  try {
    console.log(`Windows portable verification passed: ${verifyWindowsPortable()}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
