import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
  confineRemotePath,
  createRemotePty,
  listRemoteFiles,
  listRemoteSessions,
  readRemoteFile,
  remoteControlPlaneStatus,
  writeRemoteFile,
} from '../src/remote-access.ts'

function temporaryHome(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-remote-'))
}

describe('remote control plane', () => {
  it('confines file I/O to the admitted root and lists session transcripts', () => {
    const home = temporaryHome()
    const workspace = join(home, 'project')
    mkdirSync(join(workspace, 'src'), { recursive: true })
    mkdirSync(join(home, 'sessions', '--proj--', 'sess-1'), { recursive: true })
    writeFileSync(join(workspace, 'src', 'readme.txt'), 'hello\n')
    writeFileSync(join(home, 'sessions', '--proj--', 'sess-1', 'session.jsonl'), '{}\n')

    expect(listRemoteFiles(workspace, 'src')).toEqual([
      expect.objectContaining({ name: 'readme.txt', kind: 'file' }),
    ])
    expect(readRemoteFile(workspace, 'src/readme.txt')).toBe('hello\n')
    writeRemoteFile(workspace, 'src/notes.txt', 'note')
    expect(readRemoteFile(workspace, 'src/notes.txt')).toBe('note')
    expect(() => confineRemotePath(workspace, '../sessions')).toThrow('outside')
    expect(listRemoteSessions(home).map(session => session.id)).toContain('sess-1')
  })

  it('spawns a real host shell and never advertises pixel streaming', () => {
    const home = temporaryHome()
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough
      stdout: PassThrough
      stderr: PassThrough
      pid: number
      kill: () => boolean
    }
    child.stdin = stdin
    child.stdout = stdout
    child.stderr = stderr
    child.pid = 4242
    child.kill = () => {
      child.emit('close', 0)
      return true
    }
    const written: string[] = []
    stdin.on('data', chunk => { written.push(String(chunk)) })

    const session = createRemotePty(home, {
      spawn: () => child as never,
    })
    stdout.write('ready\n')
    session.write('ls\n')
    expect(session.read()).toContain('ready')
    expect(written.join('')).toBe('ls\n')
    session.close()
    expect(remoteControlPlaneStatus(
      { enabled: false, trustedHost: '' },
      { loopbackOrigin: 'http://127.0.0.1:43189', home },
    )).toEqual(expect.objectContaining({
      enabled: false,
      pixelStreaming: false,
    }))
  })
})
