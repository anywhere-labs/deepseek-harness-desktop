import { describe, expect, it } from 'vitest'
import { parseRemoteHostTargetView } from '../src/remote-host-target.ts'

describe('remote Host target view', () => {
  it('accepts a validated launcher snapshot', () => {
    expect(parseRemoteHostTargetView({
      current: { mode: 'wsl', distribution: 'Ubuntu-24.04' },
      distributions: ['Ubuntu-24.04', 'Debian'],
      wslSupported: true,
    })).toEqual({
      current: { mode: 'wsl', distribution: 'Ubuntu-24.04' },
      distributions: ['Ubuntu-24.04', 'Debian'],
      wslSupported: true,
    })
  })

  it('rejects inconsistent or ambiguous discovery state', () => {
    expect(() => parseRemoteHostTargetView({
      current: { mode: 'local' },
      distributions: ['Ubuntu', 'Ubuntu'],
      wslSupported: true,
    })).toThrow('invalid native Host target')
    expect(() => parseRemoteHostTargetView({
      current: { mode: 'local' },
      distributions: ['Ubuntu'],
      wslSupported: false,
    })).toThrow('invalid native Host target')
    expect(() => parseRemoteHostTargetView({
      current: { mode: 'local' },
      distributions: [' Ubuntu'],
      wslSupported: true,
    })).toThrow('invalid native Host target')
  })
})
