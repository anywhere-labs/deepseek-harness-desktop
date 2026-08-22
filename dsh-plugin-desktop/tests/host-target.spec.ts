import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DesktopHostTargetController } from '../src/host-target-controller.ts'
import {
  assertWslDistributionName,
  desktopHostTargetStatePath,
  parseDesktopHostTargetSelection,
  readDesktopHostTarget,
  validateDesktopHostTargetSelection,
  writeDesktopHostTarget,
} from '../src/host-target.ts'

describe('desktop Host target state', () => {
  it('defaults to the local Host and round-trips one WSL distribution atomically', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-host-target-'))
    const statePath = desktopHostTargetStatePath(root)
    expect(readDesktopHostTarget(statePath)).toEqual({ mode: 'local' })

    writeDesktopHostTarget(statePath, { mode: 'wsl', distribution: 'Ubuntu-24.04' })

    expect(readDesktopHostTarget(statePath)).toEqual({
      mode: 'wsl',
      distribution: 'Ubuntu-24.04',
    })
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual({
      version: 1,
      target: { mode: 'wsl', distribution: 'Ubuntu-24.04' },
    })
  })

  it('rejects ambiguous objects and unsafe distribution names', () => {
    expect(() => parseDesktopHostTargetSelection({ mode: 'local', distribution: 'Ubuntu' }))
      .toThrow('invalid desktop Host target')
    for (const value of ['', ' Ubuntu', 'Ubuntu\nOther', `Ubuntu\0Other`]) {
      expect(() => assertWslDistributionName(value)).toThrow('invalid WSL distribution name')
    }
  })

  it('accepts only a currently discovered distribution', () => {
    const view = { wslSupported: true, distributions: ['Ubuntu-24.04'] }
    expect(validateDesktopHostTargetSelection({ mode: 'local' }, view)).toEqual({ mode: 'local' })
    expect(validateDesktopHostTargetSelection({ mode: 'wsl', distribution: 'Ubuntu-24.04' }, view))
      .toEqual({ mode: 'wsl', distribution: 'Ubuntu-24.04' })
    expect(() => validateDesktopHostTargetSelection({ mode: 'wsl', distribution: 'Debian' }, view))
      .toThrow('WSL distribution is not installed')
  })

  it('fails safe to the local Host when persisted state is corrupted', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-host-target-corrupt-'))
    const statePath = desktopHostTargetStatePath(root)
    mkdirSync(join(root, 'host-target'))
    writeFileSync(statePath, '{not-json')
    const failures: unknown[] = []

    const controller = new DesktopHostTargetController(
      statePath,
      { distributions: ['Ubuntu-24.04'], wslSupported: true },
      cause => { failures.push(cause) },
    )

    expect(controller.read().current).toEqual({ mode: 'local' })
    expect(failures).toHaveLength(1)
  })

  it('does not follow a symlinked private state directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-host-target-link-'))
    const outside = join(root, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'sentinel'), 'keep')
    symlinkSync(outside, join(root, 'host-target'), 'dir')

    expect(() => writeDesktopHostTarget(
      join(root, 'host-target', 'state.json'),
      { mode: 'local' },
    )).toThrow('state directory is not a real directory')
    expect(readFileSync(join(outside, 'sentinel'), 'utf8')).toBe('keep')
  })
})
