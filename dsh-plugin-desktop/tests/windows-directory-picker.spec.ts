import { describe, expect, it } from 'vitest'
import { pickWindowsDirectoryFromElectron } from '../src/windows-directory-picker.ts'

describe('Windows directory picker Electron adapter', () => {
  it('enables Node mode for the synchronous worker spawn and restores an empty environment', async () => {
    const env: NodeJS.ProcessEnv = {}
    let observed: string | undefined
    const result = pickWindowsDirectoryFromElectron(
      new AbortController().signal,
      async () => {
        observed = env.ELECTRON_RUN_AS_NODE
        return 'C:\\workspace'
      },
      env,
    )

    expect(observed).toBe('1')
    expect(env).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
    await expect(result).resolves.toBe('C:\\workspace')
  })

  it('restores an inherited value when the picker throws synchronously', () => {
    const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: 'inherited' }

    expect(() => pickWindowsDirectoryFromElectron(
      new AbortController().signal,
      () => {
        expect(env.ELECTRON_RUN_AS_NODE).toBe('1')
        throw new Error('spawn failed')
      },
      env,
    )).toThrow('spawn failed')
    expect(env.ELECTRON_RUN_AS_NODE).toBe('inherited')
  })
})
