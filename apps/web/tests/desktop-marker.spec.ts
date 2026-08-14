// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { applyDesktopPresentationMarker } from '../src/desktop-marker.ts'

describe('desktop presentation marker', () => {
  it.each(['darwin', 'win32'])('marks the %s renderer before boot', (platform) => {
    const root = document.createElement('html')
    applyDesktopPresentationMarker(
      `http://127.0.0.1:4173/?dsh-desktop-platform=${platform}`,
      root,
    )
    expect(root.dataset.dshDesktop).toBe('true')
    expect(root.dataset.dshDesktopPlatform).toBe(platform)
  })

  it('leaves the Linux renderer unmarked behind its system title bar', () => {
    const root = document.createElement('html')
    applyDesktopPresentationMarker(
      'http://127.0.0.1:4173/?dsh-desktop-platform=linux',
      root,
    )
    expect(root.dataset.dshDesktop).toBeUndefined()
    expect(root.dataset.dshDesktopPlatform).toBeUndefined()
  })

  it.each(['', 'Darwin', 'freebsd'])('ignores the unsupported platform %j', (platform) => {
    const root = document.createElement('html')
    applyDesktopPresentationMarker(
      `http://127.0.0.1:4173/?dsh-desktop-platform=${platform}`,
      root,
    )
    expect(root.dataset.dshDesktop).toBeUndefined()
    expect(root.dataset.dshDesktopPlatform).toBeUndefined()
  })

  it('leaves ordinary Web URLs unmarked', () => {
    const root = document.createElement('html')
    applyDesktopPresentationMarker('http://127.0.0.1:4173/?fixture', root)
    expect(root.dataset.dshDesktop).toBeUndefined()
    expect(root.dataset.dshDesktopPlatform).toBeUndefined()
  })
})
