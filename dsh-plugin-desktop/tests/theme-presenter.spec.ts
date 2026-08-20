import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { DesktopThemePresenter } from '../src/client/theme-presenter.ts'

type StyleStub = {
  readonly setProperty: ReturnType<typeof vi.fn>
  readonly removeProperty: ReturnType<typeof vi.fn>
  colorScheme?: string
}

type MetaStub = {
  name: string
  content: string
  isConnected: boolean
  remove: ReturnType<typeof vi.fn>
}

describe('DesktopThemePresenter', () => {
  let bodyStyle: StyleStub
  let rootStyle: StyleStub
  let body: {
    readonly style: StyleStub
    readonly setAttribute: ReturnType<typeof vi.fn>
    readonly removeAttribute: ReturnType<typeof vi.fn>
  }
  let head: { readonly appendChild: ReturnType<typeof vi.fn> }
  let meta: MetaStub

  beforeEach(() => {
    bodyStyle = {
      setProperty: vi.fn(),
      removeProperty: vi.fn(),
    }
    rootStyle = {
      setProperty: vi.fn(),
      removeProperty: vi.fn(),
    }
    meta = {
      name: '',
      content: '',
      isConnected: false,
      remove: vi.fn(() => { meta.isConnected = false }),
    }
    body = {
      style: bodyStyle,
      setAttribute: vi.fn(),
      removeAttribute: vi.fn(),
    }
    head = {
      appendChild: vi.fn((node: MetaStub) => {
        node.isConnected = true
        return node
      }),
    }

    vi.stubGlobal('document', {
      body,
      createElement: vi.fn((tag: string) => {
        if (tag !== 'meta') throw new Error(`unexpected element ${tag}`)
        return meta
      }),
      documentElement: { style: rootStyle },
      head,
    })
    vi.stubGlobal('getComputedStyle', vi.fn(() => ({ backgroundColor: 'rgb(10, 20, 30)' })))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('projects theme tokens and dark-mode state onto the document', () => {
    const presenter = new DesktopThemePresenter()

    presenter.apply({
      active: {
        colorScheme: 'dark',
        tokens: {
          '--desktop-accent': '#123456',
          '--desktop-surface': '#abcdef',
        },
      },
    } as never)

    expect(rootStyle.colorScheme).toBe('dark')
    expect(body.setAttribute).toHaveBeenCalledWith('data-ds-dark-theme', '')
    expect(bodyStyle.setProperty).toHaveBeenCalledWith('--desktop-accent', '#123456')
    expect(bodyStyle.setProperty).toHaveBeenCalledWith('--desktop-surface', '#abcdef')
    expect(meta.name).toBe('theme-color')
    expect(meta.content).toBe('rgb(10, 20, 30)')
    expect(head.appendChild).toHaveBeenCalledWith(meta)

    presenter.apply({
      active: {
        colorScheme: 'light',
        tokens: {
          '--desktop-accent': '#654321',
        },
      },
    } as never)

    expect(body.removeAttribute).toHaveBeenCalledWith('data-ds-dark-theme')
    expect(bodyStyle.removeProperty).toHaveBeenCalledWith('--desktop-accent')
    expect(bodyStyle.removeProperty).toHaveBeenCalledWith('--desktop-surface')
    expect(bodyStyle.setProperty).toHaveBeenCalledWith('--desktop-accent', '#654321')
  })

  it('removes only the presenter-owned DOM state on dispose', () => {
    const presenter = new DesktopThemePresenter()
    presenter.apply({
      active: {
        colorScheme: 'dark',
        tokens: {
          '--desktop-accent': '#123456',
        },
      },
    } as never)

    presenter.dispose()

    expect(rootStyle.removeProperty).toHaveBeenCalledWith('color-scheme')
    expect(body.removeAttribute).toHaveBeenCalledWith('data-ds-dark-theme')
    expect(bodyStyle.removeProperty).toHaveBeenCalledWith('--desktop-accent')
    expect(meta.remove).toHaveBeenCalledTimes(1)
  })
})
