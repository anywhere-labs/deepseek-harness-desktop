import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { windowsExecutableProbe } from '../src/windows-executable.ts'

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-windows-executable-'))
  temporaryDirectories.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('Windows executable probe', () => {
  it('accepts a real file and reports every other shape as unusable', () => {
    const directory = temporaryDirectory()
    const file = join(directory, 'pwsh.exe')
    writeFileSync(file, 'stub')
    const nested = join(directory, 'pwsh.exe.d')
    mkdirSync(nested)

    expect(windowsExecutableProbe(file)).toBe(true)
    expect(windowsExecutableProbe(nested)).toBe(false)
    expect(windowsExecutableProbe(join(directory, 'missing.exe'))).toBe(false)
  })

  it('opens a reparse point itself instead of following it', () => {
    const directory = temporaryDirectory()
    const dangling = join(directory, 'alias.exe')
    try {
      // A Store app execution alias is a reparse point into WindowsApps, whose
      // ACL denies the target to unprivileged callers. A link whose target is
      // absent reproduces that read failure on every host.
      symlinkSync(join(directory, 'absent-target.exe'), dangling)
    } catch {
      // Creating symbolic links needs developer mode or elevation on Windows.
      return
    }

    expect(existsSync(dangling)).toBe(false)
    expect(windowsExecutableProbe(dangling)).toBe(true)
  })
})
