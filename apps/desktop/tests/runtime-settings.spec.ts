import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  defaultSettings,
  loadSettings,
  pinRuntime,
  pinRuntimeForWorkspace,
  resolvePinnedRuntime,
  saveSettings,
} from '../src/runtime-manager/settings.ts'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-desktop-settings-'))
}

describe('desktop runtime settings', () => {
  it('round-trips settings through the Desktop data dir', () => {
    const dir = tempDir()
    try {
      saveSettings(dir, { pinnedRuntime: '0.1.0-rc.7', pinnedByWorkspace: { '/proj/a': '0.1.0-rc.6' } })
      expect(loadSettings(dir)).toEqual({ pinnedRuntime: '0.1.0-rc.7', pinnedByWorkspace: { '/proj/a': '0.1.0-rc.6' } })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns defaults when no settings file exists', () => {
    const dir = tempDir()
    try {
      expect(loadSettings(dir)).toEqual(defaultSettings())
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('pins and unpins the global runtime', () => {
    expect(pinRuntime({}, '0.1.0-rc.6')).toEqual({ pinnedRuntime: '0.1.0-rc.6' })
    expect(pinRuntime({ pinnedRuntime: '0.1.0-rc.6' }, undefined)).toEqual({ pinnedRuntime: undefined })
  })

  it('pins per workspace and lets the workspace pin win', () => {
    const settings = pinRuntimeForWorkspace({ pinnedRuntime: '0.1.0-rc.6' }, '/proj/a', '0.1.0-rc.8')
    expect(resolvePinnedRuntime(settings, '/proj/a')).toBe('0.1.0-rc.8')
    expect(resolvePinnedRuntime(settings, '/proj/b')).toBe('0.1.0-rc.6')
    const unpinned = pinRuntimeForWorkspace(settings, '/proj/a', undefined)
    expect(resolvePinnedRuntime(unpinned, '/proj/a')).toBe('0.1.0-rc.6')
  })

  it('survives a malformed settings file', () => {
    const dir = tempDir()
    try {
      writeFileSync(join(dir, 'desktop-settings.json'), '{ not json')
      expect(loadSettings(dir)).toEqual(defaultSettings())
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
