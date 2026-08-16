/** Validate the complete cross-platform artifact set before publishing a release. */

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

/** Required public updater artifacts for one version. */
export function expectedDesktopArtifacts(version: string): readonly string[] {
  return [
    `DSH-Desktop-${version}-arm64.dmg`,
    `DSH-Desktop-${version}-arm64.zip`,
    'latest-mac.yml',
    `DSH-Desktop-${version}-x64-Setup.exe`,
    `DSH-Desktop-${version}-x64-Setup.exe.blockmap`,
    'latest.yml',
  ]
}

interface UpdateMetadataFile {
  readonly url: string
  readonly sha512: string
  readonly size: number
}

interface UpdateMetadata {
  readonly version: string
  readonly files: readonly UpdateMetadataFile[]
  readonly path: string
  readonly sha512: string
  readonly desktopUpdateMode: 'automatic' | 'manual'
}

function parseUpdateMetadata(text: string, name: string): UpdateMetadata {
  const value: unknown = parse(text)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${name} is not a YAML mapping`)
  }
  const record = value as Record<string, unknown>
  if (typeof record.version !== 'string'
    || typeof record.path !== 'string'
    || typeof record.sha512 !== 'string'
    || (record.desktopUpdateMode !== 'automatic' && record.desktopUpdateMode !== 'manual')
    || !Array.isArray(record.files)) {
    throw new Error(`${name} has invalid updater metadata fields`)
  }
  const files = record.files.map((entry): UpdateMetadataFile => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`${name} has an invalid updater file entry`)
    }
    const file = entry as Record<string, unknown>
    if (typeof file.url !== 'string' || typeof file.sha512 !== 'string'
      || typeof file.size !== 'number' || !Number.isSafeInteger(file.size) || file.size <= 0) {
      throw new Error(`${name} has an invalid updater file entry`)
    }
    return { url: file.url, sha512: file.sha512, size: file.size }
  })
  if (files.length === 0) throw new Error(`${name} has no updater file entries`)
  return {
    version: record.version,
    path: record.path,
    sha512: record.sha512,
    desktopUpdateMode: record.desktopUpdateMode,
    files,
  }
}

function verifyUpdateMetadataFiles(
  directory: string,
  metadataName: string,
  expectedNames: readonly string[],
): UpdateMetadata {
  const metadata = parseUpdateMetadata(readFileSync(join(directory, metadataName), 'utf8'), metadataName)
  const actualNames = metadata.files.map(file => file.url).sort()
  if (JSON.stringify(actualNames) !== JSON.stringify([...expectedNames].sort())) {
    throw new Error(`${metadataName} updater files do not match the release artifact set`)
  }
  for (const file of metadata.files) {
    if (file.url.includes('/') || file.url.includes('\\')) {
      throw new Error(`${metadataName} updater file must be a release asset name: ${file.url}`)
    }
    const artifact = readFileSync(join(directory, file.url))
    const sha512 = createHash('sha512').update(artifact).digest('base64')
    if (file.size !== artifact.byteLength || file.sha512 !== sha512) {
      throw new Error(`${metadataName} does not match ${file.url} size and SHA-512`)
    }
  }
  const primary = metadata.files.find(file => file.url === metadata.path)
  if (primary === undefined || primary.sha512 !== metadata.sha512) {
    throw new Error(`${metadataName} primary path and SHA-512 do not match an updater file`)
  }
  return metadata
}

/**
 * Verify required files, updater metadata versions and platform verification markers.
 * @param directory - Merged artifact download directory.
 * @param version - Stable desktop release version.
 * @returns SHA-256 manifest text for the public artifacts.
 */
export function verifyDesktopUpdateArtifacts(directory: string, version: string): string {
  if (!/^\d+\.\d+\.\d+$/u.test(version)) throw new Error('release version must be stable MAJOR.MINOR.PATCH')
  const required = expectedDesktopArtifacts(version)
  const present = new Set(readdirSync(directory))
  for (const name of [...required, 'macos-verified.txt', 'windows-verified.txt']) {
    if (!present.has(name)) throw new Error(`desktop release artifact is missing: ${name}`)
    if (statSync(join(directory, name)).size === 0) throw new Error(`desktop release artifact is empty: ${name}`)
  }
  const macosMetadata = verifyUpdateMetadataFiles(directory, 'latest-mac.yml', [required[1]!])
  const windowsMetadata = verifyUpdateMetadataFiles(directory, 'latest.yml', [required[3]!])
  if (macosMetadata.version !== version) throw new Error(`latest-mac.yml does not declare desktop version ${version}`)
  if (windowsMetadata.version !== version) throw new Error(`latest.yml does not declare desktop version ${version}`)

  const macosVerification = readFileSync(join(directory, 'macos-verified.txt'), 'utf8')
  if (!/^signed=true$/m.test(macosVerification) || !/^notarized=true$/m.test(macosVerification)) {
    throw new Error('macOS artifacts did not pass signing and notarization verification')
  }
  const windowsVerification = readFileSync(join(directory, 'windows-verified.txt'), 'utf8')
  const signedWindows = /^signed=true$/m.test(windowsVerification)
  const manualWindows = /^signed=false$/m.test(windowsVerification) && /^install=manual$/m.test(windowsVerification)
  if (!signedWindows && !manualWindows) {
    throw new Error('Windows artifacts did not declare a verified signed or manual installation mode')
  }
  if (macosMetadata.desktopUpdateMode !== 'automatic') {
    throw new Error('macOS updater metadata must enable automatic installation')
  }
  const expectedWindowsMode = signedWindows ? 'automatic' : 'manual'
  if (windowsMetadata.desktopUpdateMode !== expectedWindowsMode) {
    throw new Error(`Windows updater metadata must declare ${expectedWindowsMode} installation`)
  }

  return required.map((name) => {
    const hash = createHash('sha256').update(readFileSync(join(directory, name))).digest('hex')
    return `${hash}  ${name}`
  }).join('\n') + '\n'
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  const directory = resolve(process.argv[2] ?? '.')
  const version = process.argv[3] ?? ''
  const output = resolve(process.argv[4] ?? join(directory, 'SHA256SUMS'))
  try {
    writeFileSync(output, verifyDesktopUpdateArtifacts(directory, version), 'utf8')
    console.log(`verified desktop update artifacts and wrote ${output}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
