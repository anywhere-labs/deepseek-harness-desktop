import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { PresetExistsError, UnknownPresetError } from '@deepseek-ai/dsh-agent-presets'
import { afterEach, describe, expect, it } from 'vitest'
import {
  WindowsAgentPresets,
  WINDOWS_SAFE_PRESET,
  WINDOWS_UNSUPPORTED_PRESET,
} from '../src/windows-agent-presets.ts'

const roots: string[] = []
const contexts: Context[] = []

function writePreset(root: string, id: string): void {
  const dir = join(root, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent.cordis.yml'), [
    '- id: fixture',
    "  name: 'fixture-plugin'",
    '',
  ].join('\n'))
}

function createRoster(defaultId: string): WindowsAgentPresets {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-windows-presets-'))
  roots.push(root)
  writePreset(root, WINDOWS_SAFE_PRESET)
  writePreset(root, WINDOWS_UNSUPPORTED_PRESET)
  writePreset(root, 'code')
  const ctx = new Context()
  contexts.push(ctx)
  return new WindowsAgentPresets(ctx, {
    default: defaultId,
    roots: [{ path: root, trust: 'system' }],
    includeUserRoot: false,
  })
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Windows agent preset guard', () => {
  it('hides the unsupported minimal preset from discovery', async () => {
    const presets = createRoster(WINDOWS_SAFE_PRESET)

    expect((await presets.list()).map(preset => preset.id)).toEqual([
      'code',
      WINDOWS_SAFE_PRESET,
    ])
  })

  it('falls back to standard when minimal was saved as the default', async () => {
    const presets = createRoster(WINDOWS_UNSUPPORTED_PRESET)

    expect(presets.defaultId).toBe(WINDOWS_SAFE_PRESET)
    await expect(presets.resolve()).resolves.toMatchObject({ id: WINDOWS_SAFE_PRESET })
  })

  it('preserves exact resolution for legacy sessions that recorded minimal', async () => {
    const presets = createRoster(WINDOWS_SAFE_PRESET)

    await expect(presets.resolve(WINDOWS_UNSUPPORTED_PRESET))
      .resolves.toMatchObject({ id: WINDOWS_UNSUPPORTED_PRESET })
  })

  it('rejects switching a blank session to the hidden minimal preset', async () => {
    const presets = createRoster(WINDOWS_SAFE_PRESET)
    const agentCtx = new Context()
    contexts.push(agentCtx)

    await expect(presets.recompose(agentCtx, WINDOWS_UNSUPPORTED_PRESET))
      .rejects.toBeInstanceOf(UnknownPresetError)
  })

  it('reserves the hidden minimal id from user-authored copies', async () => {
    const presets = createRoster(WINDOWS_SAFE_PRESET)

    await expect(presets.copy('code', WINDOWS_UNSUPPORTED_PRESET))
      .rejects.toBeInstanceOf(PresetExistsError)
  })
})
