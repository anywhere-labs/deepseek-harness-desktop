import { describe, expect, it } from 'vitest'
import { windowsUncToWslPath, wslPathToWindowsUnc } from '../src/wsl-path.ts'

describe('WSL path bridge', () => {
  it('round-trips the selected distribution without exposing a drvfs path', () => {
    const unc = wslPathToWindowsUnc('Ubuntu-24.04', '/home/alice/My Project')
    expect(unc).toBe('\\\\wsl.localhost\\Ubuntu-24.04\\home\\alice\\My Project')
    expect(windowsUncToWslPath('Ubuntu-24.04', unc)).toBe('/home/alice/My Project')
    expect(windowsUncToWslPath('Ubuntu-24.04', '\\\\wsl$\\Ubuntu-24.04\\home\\alice')).toBe('/home/alice')
  })

  it('rejects another distro, Windows drives, traversal, and unsafe share names', () => {
    expect(windowsUncToWslPath('Ubuntu', '\\\\wsl.localhost\\Debian\\home\\alice')).toBeUndefined()
    expect(windowsUncToWslPath('Ubuntu', 'C:\\Users\\alice')).toBeUndefined()
    expect(windowsUncToWslPath('Ubuntu', '\\\\wsl.localhost\\Ubuntu\\home\\..\\root')).toBeUndefined()
    expect(() => wslPathToWindowsUnc('Bad/Name', '/home')).toThrow('cannot be represented')
  })
})
