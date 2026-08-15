import { describe, expect, it } from 'vitest'
import { isVersionValidated, parseValidatedRuntimes } from '../src/runtime-manager/validated.ts'

describe('validated runtimes matrix', () => {
  it('parses a well-formed matrix', () => {
    const matrix = parseValidatedRuntimes('{"validated":["0.1.0-rc.6"],"recommended":"0.1.0-rc.6"}')
    expect(matrix.recommended).toBe('0.1.0-rc.6')
    expect(isVersionValidated(matrix, '0.1.0-rc.6')).toBe(true)
    expect(isVersionValidated(matrix, '0.1.0-rc.7')).toBe(false)
  })

  it('rejects a malformed matrix', () => {
    expect(() => parseValidatedRuntimes('{}')).toThrow()
    expect(() => parseValidatedRuntimes('{"validated":{},"recommended":1}')).toThrow()
  })
})
