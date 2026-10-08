// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { createModelReasoningControls } from '../../scripts/reasoning-compat/client-controls.mjs'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

describe('model reasoning settings controls', () => {
  it('keeps unchecked capabilities available and requires a valid independent default', async () => {
    const Controls = createModelReasoningControls(React)
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    let saved: Record<string, unknown> = {}
    function Editor() {
      const [model, setModel] = React.useState({ id: 'think' })
      return React.createElement(Controls, {
        model, position: 1, disabled: false, native: false, t: (key: string) => key,
        fallback: { status: 'known', source: 'catalog', efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] },
        onChange: (next: typeof model) => { saved = next; setModel(next) },
      })
    }
    await act(async () => root.render(React.createElement(Editor)))
    const select = container.querySelector('select')!
    await act(async () => {
      select.value = 'high'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const high = container.querySelector<HTMLInputElement>('[aria-label="reasoning High 1"]')!
    await act(async () => high.click())
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('reasoningDefaultInvalid')
    expect(container.querySelector('[aria-label="reasoning High 1"]')).not.toBeNull()
    await act(async () => {
      select.value = 'low'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(saved).toMatchObject({ reasoningConfig: { selected: ['low'], defaultEffort: 'low', capability: { efforts: [{ id: 'low' }, { id: 'high' }] } } })
    await act(async () => root.unmount())
    container.remove()
  })
})
