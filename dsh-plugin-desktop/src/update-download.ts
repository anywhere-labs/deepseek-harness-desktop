/** Headless, confirmation-gated downloads for DSH Desktop installers. */

import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { compareSemVerVersions, parseSemVer } from './update-checker.ts'

/** Desktop platforms with a fixed installer download endpoint. */
export type DesktopDownloadPlatform = 'darwin' | 'win32'

/** Fixed download endpoints that record one user-confirmed installer download. */
export const DESKTOP_DOWNLOAD_URLS: Readonly<Record<DesktopDownloadPlatform, string>> = {
  darwin: 'https://www.dshdesktop.cn/api/downloads/mac',
  win32: 'https://www.dshdesktop.cn/api/downloads/windows',
}

/** Maximum accepted installer size, in bytes. */
export const MAX_UPDATE_DOWNLOAD_BYTES = 1024 * 1024 * 1024

/** Failure categories exposed to the update coordinator. */
export type UpdateDownloadErrorCode =
  | 'aborted'
  | 'empty-body'
  | 'http-status'
  | 'invalid-artifact'
  | 'invalid-options'
  | 'network'
  | 'response-too-large'

/** Fetch-compatible request boundary supplied by the Electron adapter or a test. */
export type UpdateArtifactRequest = (url: string, init: RequestInit) => Promise<Response>

/** Inputs for one user-confirmed installer download. */
export interface DownloadDesktopUpdateOptions {
  /** Host platform selecting the fixed endpoint and installer validation. */
  readonly platform: DesktopDownloadPlatform
  /** Stable release version used to validate the selected installer. */
  readonly version: string
  /** Absolute installer path selected by the user. */
  readonly destinationPath: string
  /** Request implementation, normally backed by Electron `net.fetch`. */
  readonly request: UpdateArtifactRequest
  /** Optional cancellation signal owned by the update coordinator. */
  readonly signal?: AbortSignal
}

/** Typed failure from installer request, validation, or cancellation. */
export class UpdateDownloadError extends Error {
  /** Stable programmatic failure category. */
  readonly code: UpdateDownloadErrorCode
  /** HTTP status for an unsuccessful response, otherwise undefined. */
  readonly status: number | undefined

  /**
   * Create one safe update-download failure.
   * @param code - Stable failure category.
   * @param message - Diagnostic text without response content.
   * @param options - Optional HTTP status and underlying failure.
   */
  constructor(
    code: UpdateDownloadErrorCode,
    message: string,
    options: { readonly status?: number; readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'UpdateDownloadError'
    this.code = code
    this.status = options.status
  }
}

const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
const DECIMAL_BYTES = /^(0|[1-9][0-9]*)$/u
const DMG_TRAILER_BYTES = 512
const DMG_TRAILER_MAGIC = Buffer.from('koly', 'ascii')
const DOS_HEADER_BYTES = 64
const PE_OFFSET_POSITION = 0x3c
const PE_MAGIC = Buffer.from([0x50, 0x45, 0x00, 0x00])

interface DownloadPaths {
  readonly completed: string
  readonly temporary: string
}

/** Downloaded installer tracked until the upgraded application resolves retention. */
export interface DesktopUpdateArtifact {
  readonly platform: DesktopDownloadPlatform
  readonly version: string
  readonly path: string
}

const UPDATE_ARTIFACT_STATE_VERSION = 1
const UPDATE_ARTIFACT_STATE_BYTES = 4 * 1024
const UPDATE_ARTIFACT_STATE_FILENAME = 'pending-installer.json'

/**
 * Download one installer after its caller has obtained user confirmation.
 * @param options - Fixed platform, release version, selected destination, request, and cancellation inputs.
 * @returns Absolute path to the completely written and validated installer.
 * @throws {UpdateDownloadError} For invalid inputs, transport failures, rejected responses, cancellation, and invalid installers.
 */
export async function downloadDesktopUpdate(options: DownloadDesktopUpdateOptions): Promise<string> {
  const platform = validatedPlatform(options.platform)
  validatedVersion(options.version)
  const destinationPath = validatedArtifactPath(options.destinationPath, platform)
  const paths = await prepareDownloadPaths(destinationPath)
  throwIfAborted(options.signal)

  let response: Response
  try {
    response = await options.request(DESKTOP_DOWNLOAD_URLS[platform], {
      method: 'GET',
      cache: 'no-store',
      redirect: 'follow',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
  } catch (cause) {
    if (options.signal?.aborted === true || isAbortFailure(cause)) throw aborted(cause)
    throw new UpdateDownloadError('network', 'The update installer could not be downloaded.', { cause })
  }

  if (response.status !== 200) {
    throw new UpdateDownloadError(
      'http-status',
      `The update download service returned HTTP ${String(response.status)}.`,
      { status: response.status },
    )
  }
  if (response.body === null) {
    throw new UpdateDownloadError('empty-body', 'The update download service returned an empty body.')
  }
  assertDeclaredSize(response)

  let failure: unknown
  try {
    await writeResponseBody(paths.temporary, response.body, options.signal)
    throwIfAborted(options.signal)
    await validateArtifact(paths.temporary, platform)
    throwIfAborted(options.signal)
    await unlinkIfPresent(paths.completed)
    await rename(paths.temporary, paths.completed)
    return paths.completed
  } catch (cause) {
    failure = options.signal?.aborted === true || isAbortFailure(cause) ? aborted(cause) : cause
    throw failure
  } finally {
    try {
      await unlinkIfPresent(paths.temporary)
    } catch (cleanupCause) {
      if (failure === undefined) throw cleanupCause
      throw new AggregateError([failure, cleanupCause], 'Failed to download and clean up the update installer.')
    }
  }
}

/** Fixed default filename shown by the native destination picker. */
export function desktopUpdateFilename(platform: DesktopDownloadPlatform, version: string): string {
  validatedPlatform(platform)
  validatedVersion(version)
  const extension = platform === 'darwin' ? 'dmg' : 'exe'
  const platformName = platform === 'darwin' ? 'mac' : 'windows'
  return `DSH-Desktop-${version}-${platformName}.${extension}`
}

/** Remember a downloaded installer until an upgraded application resolves its retention. */
export async function recordDesktopUpdateArtifact(
  userDataPath: string,
  artifact: DesktopUpdateArtifact,
): Promise<void> {
  const statePath = await prepareArtifactStatePath(userDataPath)
  const value = await validatedArtifactRecord(artifact, true)
  await writeFileAtomic(statePath, `${JSON.stringify({
    stateVersion: UPDATE_ARTIFACT_STATE_VERSION,
    ...value,
  })}\n`, {
    mode: PRIVATE_FILE_MODE,
    dirMode: PRIVATE_DIRECTORY_MODE,
  })
}

/** Return a retained installer only after the running version reaches its target. */
export async function pendingDesktopUpdateArtifact(
  userDataPath: string,
  currentVersion: string,
  platform: DesktopDownloadPlatform,
): Promise<DesktopUpdateArtifact | undefined> {
  const statePath = artifactStatePath(validatedUserDataPath(userDataPath))
  validatedVersion(currentVersion)
  validatedPlatform(platform)
  let value: DesktopUpdateArtifact
  try {
    value = await readArtifactRecord(statePath)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw cause
  }
  if (value.platform !== platform) return undefined
  const comparison = compareSemVerVersions(currentVersion, value.version)
  if (comparison === null || comparison < 0) return undefined
  try {
    const stat = await lstat(value.path)
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new UpdateDownloadError('invalid-options', 'The retained update installer is not a regular file.')
    }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
    await unlinkIfPresent(statePath)
    return undefined
  }
  return value
}

/** Apply one explicit delete/keep choice and consume its cleanup state. */
export async function resolveDesktopUpdateArtifact(
  userDataPath: string,
  artifact: DesktopUpdateArtifact,
  remove: boolean,
): Promise<void> {
  const statePath = artifactStatePath(validatedUserDataPath(userDataPath))
  const current = await readArtifactRecord(statePath)
  const expected = await validatedArtifactRecord(artifact, false)
  if (current.platform !== expected.platform
    || current.version !== expected.version
    || current.path !== expected.path) {
    throw new UpdateDownloadError('invalid-options', 'The update artifact cleanup state changed.')
  }
  if (remove) await unlinkIfPresent(expected.path)
  await unlinkIfPresent(statePath)
}

function validatedPlatform(platform: DesktopDownloadPlatform): DesktopDownloadPlatform {
  if (platform !== 'darwin' && platform !== 'win32') {
    throw new UpdateDownloadError('invalid-options', `Unsupported update download platform: ${String(platform)}`)
  }
  return platform
}

function validatedVersion(version: string): string {
  const parsed = parseSemVer(version)
  if (parsed === null || parsed.prerelease.length > 0 || parsed.version !== version) {
    throw new UpdateDownloadError('invalid-options', 'The update version must be stable Semantic Versioning.')
  }
  return version
}

function validatedUserDataPath(userDataPath: string): string {
  if (userDataPath.length === 0 || /[\0\r\n]/u.test(userDataPath) || !isAbsolute(userDataPath)) {
    throw new UpdateDownloadError('invalid-options', 'The update user-data path must be an absolute path.')
  }
  return resolve(userDataPath)
}

async function prepareDownloadPaths(
  destinationPath: string,
): Promise<DownloadPaths> {
  const directory = dirname(destinationPath)
  const directoryStat = await lstat(directory)
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new UpdateDownloadError('invalid-options', 'The update destination directory must be a real directory.')
  }
  const completedStat = await lstatOptional(destinationPath)
  if (completedStat !== undefined) {
    if (!completedStat.isFile() || completedStat.isSymbolicLink()) {
      throw new UpdateDownloadError('invalid-options', 'The completed update path is not a regular file.')
    }
  }

  return {
    completed: destinationPath,
    temporary: join(directory, `.${basename(destinationPath)}.${process.pid}.${randomUUID()}.partial`),
  }
}

function validatedArtifactPath(path: string, platform: DesktopDownloadPlatform): string {
  if (path.length === 0 || /[\0\r\n]/u.test(path) || !isAbsolute(path)) {
    throw new UpdateDownloadError('invalid-options', 'The update destination path must be absolute.')
  }
  const expectedExtension = platform === 'darwin' ? '.dmg' : '.exe'
  if (extname(path).toLowerCase() !== expectedExtension) {
    throw new UpdateDownloadError('invalid-options', `The update destination must use ${expectedExtension}.`)
  }
  return resolve(path)
}

async function prepareArtifactStatePath(userDataPath: string): Promise<string> {
  const root = validatedUserDataPath(userDataPath)
  const rootStat = await lstat(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new UpdateDownloadError('invalid-options', 'The update user-data path must be a real directory.')
  }
  const directory = join(root, 'updates')
  await preparePrivateDirectory(directory)
  return artifactStatePath(root)
}

function artifactStatePath(userDataPath: string): string {
  return join(userDataPath, 'updates', UPDATE_ARTIFACT_STATE_FILENAME)
}

async function validatedArtifactRecord(
  artifact: DesktopUpdateArtifact,
  requireFile: boolean,
): Promise<DesktopUpdateArtifact> {
  const platform = validatedPlatform(artifact.platform)
  const version = validatedVersion(artifact.version)
  const path = validatedArtifactPath(artifact.path, platform)
  if (requireFile) {
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new UpdateDownloadError('invalid-options', 'The retained update installer must be a regular file.')
    }
  }
  return { platform, version, path }
}

async function parseArtifactRecord(text: string): Promise<DesktopUpdateArtifact> {
  let value: unknown
  try { value = JSON.parse(text) } catch {
    throw new UpdateDownloadError('invalid-options', 'The update artifact cleanup state is invalid.')
  }
  if (value === null
    || typeof value !== 'object'
    || (value as { stateVersion?: unknown }).stateVersion !== UPDATE_ARTIFACT_STATE_VERSION
    || ((value as { platform?: unknown }).platform !== 'darwin'
      && (value as { platform?: unknown }).platform !== 'win32')
    || typeof (value as { version?: unknown }).version !== 'string'
    || typeof (value as { path?: unknown }).path !== 'string'
    || Object.keys(value).some(key => !['stateVersion', 'platform', 'version', 'path'].includes(key))) {
    throw new UpdateDownloadError('invalid-options', 'The update artifact cleanup state is invalid.')
  }
  return await validatedArtifactRecord(value as DesktopUpdateArtifact, false)
}

async function readArtifactRecord(statePath: string): Promise<DesktopUpdateArtifact> {
  const stat = await lstat(statePath)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > UPDATE_ARTIFACT_STATE_BYTES) {
    throw new UpdateDownloadError('invalid-options', 'The update artifact cleanup state is invalid.')
  }
  return await parseArtifactRecord(await readFile(statePath, 'utf8'))
}

async function preparePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  const stat = await lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new UpdateDownloadError('invalid-options', 'An update destination component is not a real directory.')
  }
  await chmod(directory, PRIVATE_DIRECTORY_MODE)
}

async function lstatOptional(filename: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(filename)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw cause
  }
}

function assertDeclaredSize(response: Response): void {
  const declared = response.headers.get('content-length')
  if (declared === null || !DECIMAL_BYTES.test(declared)) return
  if (BigInt(declared) > BigInt(MAX_UPDATE_DOWNLOAD_BYTES)) {
    throw new UpdateDownloadError(
      'response-too-large',
      `The update installer exceeds ${String(MAX_UPDATE_DOWNLOAD_BYTES)} bytes.`,
    )
  }
}

async function writeResponseBody(
  filename: string,
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
): Promise<void> {
  const handle = await open(filename, 'wx', PRIVATE_FILE_MODE)
  const reader = body.getReader()
  let bytesWritten = 0
  try {
    while (true) {
      throwIfAborted(signal)
      const chunk = await reader.read()
      throwIfAborted(signal)
      if (chunk.done) break
      if (chunk.value.byteLength > MAX_UPDATE_DOWNLOAD_BYTES - bytesWritten) {
        throw new UpdateDownloadError(
          'response-too-large',
          `The update installer exceeds ${String(MAX_UPDATE_DOWNLOAD_BYTES)} bytes.`,
        )
      }
      await writeAll(handle, chunk.value)
      bytesWritten += chunk.value.byteLength
    }
    if (bytesWritten === 0) {
      throw new UpdateDownloadError('empty-body', 'The update download service returned an empty body.')
    }
    await handle.sync()
  } catch (cause) {
    await reader.cancel(cause).catch(() => undefined)
    throw cause
  } finally {
    reader.releaseLock()
    await handle.close()
  }
}

async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  chunk: Uint8Array,
): Promise<void> {
  let offset = 0
  while (offset < chunk.byteLength) {
    const result = await handle.write(chunk, offset, chunk.byteLength - offset, null)
    if (result.bytesWritten === 0) throw new Error('The update installer write made no progress.')
    offset += result.bytesWritten
  }
}

async function validateArtifact(filename: string, platform: DesktopDownloadPlatform): Promise<void> {
  const handle = await open(filename, 'r')
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_UPDATE_DOWNLOAD_BYTES) {
      throw invalidArtifact(platform)
    }
    if (platform === 'darwin') {
      if (stat.size < DMG_TRAILER_BYTES) throw invalidArtifact(platform)
      const magic = Buffer.alloc(DMG_TRAILER_MAGIC.byteLength)
      const result = await handle.read(magic, 0, magic.byteLength, stat.size - DMG_TRAILER_BYTES)
      if (result.bytesRead !== magic.byteLength || !magic.equals(DMG_TRAILER_MAGIC)) {
        throw invalidArtifact(platform)
      }
      return
    }

    if (stat.size < DOS_HEADER_BYTES) throw invalidArtifact(platform)
    const dosHeader = Buffer.alloc(DOS_HEADER_BYTES)
    const dosResult = await handle.read(dosHeader, 0, dosHeader.byteLength, 0)
    if (dosResult.bytesRead !== dosHeader.byteLength || dosHeader[0] !== 0x4d || dosHeader[1] !== 0x5a) {
      throw invalidArtifact(platform)
    }
    const peOffset = dosHeader.readUInt32LE(PE_OFFSET_POSITION)
    if (peOffset > stat.size - PE_MAGIC.byteLength) throw invalidArtifact(platform)
    const peMagic = Buffer.alloc(PE_MAGIC.byteLength)
    const peResult = await handle.read(peMagic, 0, peMagic.byteLength, peOffset)
    if (peResult.bytesRead !== peMagic.byteLength || !peMagic.equals(PE_MAGIC)) {
      throw invalidArtifact(platform)
    }
  } finally {
    await handle.close()
  }
}

function invalidArtifact(platform: DesktopDownloadPlatform): UpdateDownloadError {
  return new UpdateDownloadError(
    'invalid-artifact',
    platform === 'darwin'
      ? 'The downloaded file is not a UDIF disk image.'
      : 'The downloaded file is not a PE executable.',
  )
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return
  throw aborted(signal.reason)
}

function aborted(cause: unknown): UpdateDownloadError {
  return new UpdateDownloadError('aborted', 'The update installer download was cancelled.', { cause })
}

function isAbortFailure(value: unknown): boolean {
  return value instanceof UpdateDownloadError
    ? value.code === 'aborted'
    : typeof value === 'object'
      && value !== null
      && 'name' in value
      && value.name === 'AbortError'
}

async function unlinkIfPresent(filename: string): Promise<void> {
  try {
    await unlink(filename)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
  }
}
