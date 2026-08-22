// tests/degraded-mode.spec.ts
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  readDegradedBundles,
  writeDegradedBundles,
} from '../src/degraded-mode.ts'

const roots: string[] = []
afterEach(() => { for (const r of roots.splice(0)) rmSync(join(r, 'degraded.json'), { force: true }) })

function root(): string {
  const r = join(tmpdir(), `dsh-degraded-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(r, { recursive: true })
  roots.push(r)
  return r
}

describe('degraded mode state', () => {
  it('round-trips the degraded bundle set', () => {
    const path = join(root(), 'degraded.json')
    writeDegradedBundles(path, ['plugin-x', 'plugin-y'])
    expect(readDegradedBundles(path)).toEqual(['plugin-x', 'plugin-y'])
  })

  it('falls back to an empty set when the file is absent', () => {
    expect(readDegradedBundles(join(root(), 'degraded.json'))).toEqual([])
  })

  it('preserves an empty degraded set (clearing a prior degrade)', () => {
    const path = join(root(), 'degraded.json')
    writeDegradedBundles(path, ['plugin-x'])
    writeDegradedBundles(path, [])
    expect(readDegradedBundles(path)).toEqual([])
  })
})
