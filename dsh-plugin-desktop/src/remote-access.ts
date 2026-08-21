/** Default-off remote control plane. Syncs sessions, files, and a host shell — not pixels. */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { delimiter, dirname, join, relative, resolve, sep } from 'node:path'
import { remoteEntranceEnabled, type DesktopRemoteSettings } from './workbench-settings.ts'

const MAX_FILE_BYTES = 256 * 1024
const MAX_PTY_BUFFER = 64 * 1024
const SESSION_MARKERS = ['session.jsonl', 'session.jsonl.zstd']

/** One session transcript discovered under a DSH home. */
export interface RemoteSessionRecord {
  readonly id: string
  readonly path: string
}

/** One directory entry returned by the control-plane file list. */
export interface RemoteFileEntry {
  readonly name: string
  readonly kind: 'file' | 'directory'
  readonly size?: number
}

export type RemotePtySpawn = (
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
) => ChildProcessWithoutNullStreams

/** In-memory host shell session used by the remote control plane. */
export interface RemotePtySession {
  readonly id: string
  readonly cwd: string
  write(data: string): void
  read(): string
  close(): void
}

function assertAbsoluteDirectory(path: string, label: string): string {
  const resolved = resolve(path)
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new Error(`${label} must be an existing directory`)
  }
  return resolved
}

/**
 * Resolve `rel` under `root` and reject traversal.
 * Remote file I/O never leaves the admitted root.
 */
export function confineRemotePath(root: string, rel = '.'): string {
  const resolvedRoot = assertAbsoluteDirectory(root, 'workspace root')
  const resolved = resolve(resolvedRoot, rel)
  const relToRoot = relative(resolvedRoot, resolved)
  if (relToRoot.startsWith('..') || relToRoot.split(sep).includes('..')) {
    throw new Error('path is outside the admitted workspace root')
  }
  return resolved
}

function walkSessionMarkers(root: string, depth: number, found: RemoteSessionRecord[]): void {
  if (depth < 0 || !existsSync(root) || !statSync(root).isDirectory()) return
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return
  }
  for (const name of entries) {
    if (name === '.' || name === '..' || name === 'node_modules') continue
    const path = join(root, name)
    let stat
    try {
      stat = statSync(path)
    } catch {
      continue
    }
    if (stat.isFile() && SESSION_MARKERS.includes(name)) {
      found.push({ id: dirname(path).split(sep).at(-1) ?? name, path })
      continue
    }
    if (stat.isDirectory()) walkSessionMarkers(path, depth - 1, found)
  }
}

/** List session transcripts under the current home without opening their contents. */
export function listRemoteSessions(home: string): readonly RemoteSessionRecord[] {
  const resolved = assertAbsoluteDirectory(home, 'DSH home')
  const found: RemoteSessionRecord[] = []
  for (const candidate of [join(resolved, 'sessions'), join(resolved, 'storages'), resolved]) {
    walkSessionMarkers(candidate, candidate === resolved ? 3 : 4, found)
  }
  const unique = new Map<string, RemoteSessionRecord>()
  for (const record of found) unique.set(record.path, record)
  return [...unique.values()].sort((left, right) => left.id.localeCompare(right.id))
}

/** List one admitted directory. */
export function listRemoteFiles(root: string, rel = '.'): readonly RemoteFileEntry[] {
  const path = confineRemotePath(root, rel)
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error('path is not a directory')
  const entries: RemoteFileEntry[] = []
  for (const name of readdirSync(path)) {
    if (name === '.' || name === '..') continue
    const child = join(path, name)
    try {
      const stat = statSync(child)
      if (stat.isDirectory()) entries.push({ name, kind: 'directory' })
      else if (stat.isFile()) entries.push({ name, kind: 'file', size: stat.size })
    } catch {
      continue
    }
  }
  return entries
}

/** Read a text file under an admitted root. Binary and oversized files are rejected. */
export function readRemoteFile(root: string, rel: string): string {
  const path = confineRemotePath(root, rel)
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error('path is not a file')
  const stat = statSync(path)
  if (stat.size > MAX_FILE_BYTES) throw new Error('file is too large for the control plane')
  const buffer = readFileSync(path)
  if (buffer.includes(0)) throw new Error('binary files are not streamed by the control plane')
  return buffer.toString('utf8')
}

/** Write a text file under an admitted root. Parents are created. */
export function writeRemoteFile(root: string, rel: string, content: string): void {
  if (typeof content !== 'string') throw new Error('file content must be text')
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
    throw new Error('file is too large for the control plane')
  }
  const path = confineRemotePath(root, rel)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function defaultShell(): { command: string; args: string[] } {
  if (process.platform === 'win32') {
    return { command: process.env.ComSpec ?? 'cmd.exe', args: [] }
  }
  return { command: process.env.SHELL ?? '/bin/sh', args: [] }
}

/** Spawn a real host shell. This is process I/O, not an Electron pixel stream. */
export function createRemotePty(
  cwd: string,
  options: {
    readonly id?: string
    readonly spawn?: RemotePtySpawn
    readonly env?: NodeJS.ProcessEnv
  } = {},
): RemotePtySession {
  const resolvedCwd = assertAbsoluteDirectory(cwd, 'PTY working directory')
  const { command, args } = defaultShell()
  const spawnImpl = options.spawn ?? ((cmd, spawnArgs, spawnOptions) => spawn(cmd, [...spawnArgs], {
    cwd: spawnOptions.cwd,
    env: spawnOptions.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  }))
  const child = spawnImpl(command, args, {
    cwd: resolvedCwd,
    env: { ...process.env, ...(options.env ?? {}), PATH: process.env.PATH ?? delimiter },
  })
  let buffer = ''
  const append = (chunk: Buffer | string): void => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    if (buffer.length > MAX_PTY_BUFFER) buffer = buffer.slice(buffer.length - MAX_PTY_BUFFER)
  }
  child.stdout.on('data', append)
  child.stderr.on('data', append)
  return {
    id: options.id ?? `pty-${String(child.pid ?? Date.now())}`,
    cwd: resolvedCwd,
    write(data: string) {
      child.stdin.write(data)
    },
    read() {
      const snapshot = buffer
      buffer = ''
      return snapshot
    },
    close() {
      child.kill()
    },
  }
}

/** Status payload for the settings tab and remote clients. */
export function remoteControlPlaneStatus(
  remote: DesktopRemoteSettings,
  extra: { readonly loopbackOrigin: string; readonly home: string },
): {
  readonly enabled: boolean
  readonly trustedHost: string
  readonly loopbackOrigin: string
  readonly pixelStreaming: false
  readonly home: string
} {
  return {
    enabled: remoteEntranceEnabled(remote),
    trustedHost: remote.trustedHost,
    loopbackOrigin: extra.loopbackOrigin,
    pixelStreaming: false,
    home: extra.home,
  }
}
