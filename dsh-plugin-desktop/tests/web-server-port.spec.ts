import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveWebServerPort } from '../src/web-server-port.ts'

describe('resolveWebServerPort', () => {
  const original = process.env.DSH_DESKTOP_WEB_PORT
  afterEach(() => {
    if (original === undefined) delete process.env.DSH_DESKTOP_WEB_PORT
    else process.env.DSH_DESKTOP_WEB_PORT = original
    vi.restoreAllMocks()
  })

  it('returns 0 (random) when the env var is unset', () => {
    delete process.env.DSH_DESKTOP_WEB_PORT
    expect(resolveWebServerPort()).toBe(0)
  })

  it('returns 0 (random) when the env var is empty or whitespace', () => {
    for (const value of ['', '   ', '\t']) {
      process.env.DSH_DESKTOP_WEB_PORT = value
      expect(resolveWebServerPort()).toBe(0)
    }
  })

  it('returns the pinned port for a positive integer', () => {
    process.env.DSH_DESKTOP_WEB_PORT = '3080'
    expect(resolveWebServerPort()).toBe(3080)
  })

  it('accepts an explicit 0 to request a random port', () => {
    process.env.DSH_DESKTOP_WEB_PORT = '0'
    expect(resolveWebServerPort()).toBe(0)
  })

  it('accepts the upper bound 65535', () => {
    process.env.DSH_DESKTOP_WEB_PORT = '65535'
    expect(resolveWebServerPort()).toBe(65535)
  })

  it('falls back to 0 with a warning for non-numeric input', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    process.env.DSH_DESKTOP_WEB_PORT = 'abc'
    expect(resolveWebServerPort()).toBe(0)
    expect(warn).toHaveBeenCalledOnce()
  })

  it('rejects out-of-range integers and falls back to 0', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const value of ['-1', '65536', '99999']) {
      process.env.DSH_DESKTOP_WEB_PORT = value
      expect(resolveWebServerPort()).toBe(0)
    }
    expect(warn).toHaveBeenCalledTimes(3)
  })

  it('rejects fractional values and falls back to 0', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    process.env.DSH_DESKTOP_WEB_PORT = '3080.5'
    expect(resolveWebServerPort()).toBe(0)
    expect(warn).toHaveBeenCalledOnce()
  })

  it('rejects hex and scientific notation that Number() would accept', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const value of ['0x10', '1e3', '+3080']) {
      process.env.DSH_DESKTOP_WEB_PORT = value
      expect(resolveWebServerPort()).toBe(0)
    }
    expect(warn).toHaveBeenCalledTimes(3)
  })
})
