import { afterEach, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import type { DesktopPermissions } from '../src/permissions.ts'

const hooks = vi.hoisted(() => ({ effects: [] as (() => unknown)[], states: [] as unknown[], cursor: 0 }))
vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof import('react')>(),
  useEffect: (effect: () => unknown) => { hooks.effects.push(effect) },
  useRef: (current: unknown) => ({ current }),
  useState: (initial: unknown) => {
    const index = hooks.cursor++
    if (!(index in hooks.states)) hooks.states[index] = initial
    return [hooks.states[index], (next: unknown) => {
      hooks.states[index] = typeof next === 'function' ? next(hooks.states[index]) : next
    }]
  },
}))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ Button: 'button', Modal: 'dialog', StateDot: 'span', IconSettingsOutlineRegular: 'svg' }))
import { DesktopPermissionsButton, DesktopPermissionsDialog, PermissionDetails } from '../src/client/permissions.tsx'

type Element = ReactElement<Record<string, any>>
const nodes = (value: unknown): Element[] => Array.isArray(value) ? value.flatMap(nodes)
  : value && typeof value === 'object' && 'props' in value
    ? [value as Element, ...nodes((value as Element).props.children)] : []
const service = (): DesktopPermissions => ({
  query: vi.fn<DesktopPermissions['query']>(async permission => ({ permission, status: 'not-determined', canRequest: true, canOpenSettings: true })),
  request: vi.fn<DesktopPermissions['request']>(async permission => ({ permission, status: 'granted', canRequest: false, canOpenSettings: true })),
  openSettings: vi.fn(async () => {}),
})
afterEach(() => { hooks.effects = []; hooks.states = []; hooks.cursor = 0; vi.unstubAllGlobals() })

it('opens the scoped dialog and only queries or requests microphone permission', async () => {
  const permissions = service()
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
  let button = DesktopPermissionsButton({ service: permissions, language: 'zh', permission: 'microphone' })
  nodes(button).find(node => node.type === 'button')!.props.onClick()
  hooks.cursor = 0
  button = DesktopPermissionsButton({ service: permissions, language: 'zh', permission: 'microphone' })
  const dialog = nodes(button).find(node => node.type === DesktopPermissionsDialog)!
  expect(dialog.props).toMatchObject({ open: true, permission: 'microphone' })
  hooks.states = []; hooks.cursor = 0; hooks.effects = []
  const renderDetails = () => { hooks.cursor = 0; return PermissionDetails({ service: permissions, language: 'zh', permission: 'microphone' }) }
  renderDetails()
  hooks.effects[0]!()
  await vi.waitFor(() => { expect(hooks.states[0]).toHaveLength(1) })
  expect(permissions.query).toHaveBeenCalledExactlyOnceWith('microphone')
  const detail = renderDetails()
  expect(nodes(detail).filter(node => node.props.role === 'group').map(node => node.props['aria-label'])).toEqual(['麦克风'])
  nodes(detail).find(node => node.props.children === '请求授权')!.props.onClick()
  await vi.waitFor(() => { expect(permissions.query).toHaveBeenCalledTimes(2) })
  expect(permissions.request).toHaveBeenCalledExactlyOnceWith('microphone')
  nodes(detail).find(node => node.props.children === '打开系统设置')!.props.onClick()
  await vi.waitFor(() => { expect(permissions.openSettings).toHaveBeenCalledExactlyOnceWith('microphone') })
})
