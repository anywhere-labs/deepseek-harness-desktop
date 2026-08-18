// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {} from '../src/client/index.js'
import { MarketController } from '../src/client/controller.js'
import { MarketLauncher, type MarketLauncherProps } from '../src/client/MarketLauncher.js'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconCordisPluginOutline14: () => null,
  Tooltip: ({ children }: { children: unknown }) => children,
}))

afterEach(() => { cleanup() })

const t = ((key: string) => key) as PropsLocale<'community-market'>['t']

describe('community market launcher', () => {
  it('opens the market and reflects narrow versus wide sidebar presentation', () => {
    const controller = new MarketController()
    const props = {
      wide: false,
      controller,
      t,
      useSessions: (() => undefined) as MarketLauncherProps['useSessions'],
      useWorkspaces: (() => undefined) as MarketLauncherProps['useWorkspaces'],
    } satisfies MarketLauncherProps

    const { rerender } = render(<MarketLauncher {...props} />)
    const button = screen.getByRole('button', { name: 'launcher' })
    expect(button.getAttribute('data-wide')).toBe('false')
    expect(button.getAttribute('data-active')).toBe('false')
    expect(button.textContent).not.toContain('launcher')

    fireEvent.click(button)
    expect(button.getAttribute('data-active')).toBe('true')

    rerender(<MarketLauncher {...props} wide />)
    expect(button.getAttribute('data-wide')).toBe('true')
    expect(button.textContent).toContain('launcher')
  })
})
