import { describe, expect, it } from 'vitest'
import { isErrorType, shouldEmit } from '../src/log-level.ts'

describe('shouldEmit', () => {
  it('emits nothing above the threshold', () => {
    expect(shouldEmit('debug', 'info')).toBe(false)
    expect(shouldEmit('info', 'info')).toBe(true)
    expect(shouldEmit('warn', 'info')).toBe(true)
    expect(shouldEmit('error', 'info')).toBe(true)
  })

  it('emits only errors at the error threshold', () => {
    expect(shouldEmit('error', 'error')).toBe(true)
    expect(shouldEmit('warn', 'error')).toBe(false)
    expect(shouldEmit('info', 'error')).toBe(false)
    expect(shouldEmit('debug', 'error')).toBe(false)
  })

  it('emits everything at the debug threshold', () => {
    expect(shouldEmit('debug', 'debug')).toBe(true)
    expect(shouldEmit('info', 'debug')).toBe(true)
    expect(shouldEmit('warn', 'debug')).toBe(true)
    expect(shouldEmit('error', 'debug')).toBe(true)
  })
})

describe('isErrorType', () => {
  it('treats warn and error as the error log', () => {
    expect(isErrorType('warn')).toBe(true)
    expect(isErrorType('error')).toBe(true)
    expect(isErrorType('info')).toBe(false)
    expect(isErrorType('debug')).toBe(false)
  })
})
