import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveHostEntry } from '../src/host-entry.ts'

describe('desktop Host entry', () => {
  it('uses the built-in entry by default', () => {
    expect(resolveHostEntry('/app/dsh/lib/bin.js', undefined)).toBe('/app/dsh/lib/bin.js')
  })

  it('resolves the configured entry against the launch directory', () => {
    expect(resolveHostEntry('/app/dsh/lib/bin.js', 'wrappers/dsh.js')).toBe(resolve('wrappers/dsh.js'))
  })
})
