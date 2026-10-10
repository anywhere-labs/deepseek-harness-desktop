// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import * as ReactDOM from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { Service } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type View = React.ComponentType<Record<string, unknown>>
interface OfficialClient {
  apply(ctx: object): void
  inputBar?: View
  hostPathBridge?: () => { pathFor(file: File): string } | undefined
}

/** Load the exact published browser factory used by this Desktop edition. */
function officialClient(name: string, exposeInput = false, hostPaths?: object): OfficialClient {
  const source = readFileSync(new URL(import.meta.resolve(`${name}/client`)), 'utf8')
  let plugin: OfficialClient | undefined
  const primitives = new Proxy({}, {
    get: (_target, key) => key === 'Tooltip'
      ? ({ children }: { children: React.ReactNode }) => children
      : () => null,
  })
  const modules: Record<string, unknown> = {
    react: React, 'react/jsx-runtime': jsxRuntime, 'react-dom': ReactDOM,
    '@deepseek-ai/cordis': { Service },
    '@deepseek-ai/dsh-client-ui-primitives': primitives,
    '@deepseek-ai/dsh-client-store': {
      createSnapshotStore(initial: unknown) {
        let snapshot = initial
        return { getSnapshot: () => snapshot, set(next: unknown) { snapshot = next }, subscribe: () => () => {} }
      },
    },
    '@deepseek-ai/dsh-client-ui-slots': {},
  }
  // Expose existing private views for a headless render without reimplementing
  // their guards. Only the test's in-memory factory gains these exports.
  const anchor = 'exports.apply = apply;'
  if (exposeInput && !source.includes(anchor)) throw new Error('official conversation factory changed')
  const evaluated = exposeInput
    ? source.replace(anchor, 'exports.inputBar = InputBar; exports.hostPathBridge = hostPathBridge; ' + anchor)
    : source
  const browser = Object.create(window) as Window & { __ModuleLoader__: object }
  browser.__ModuleLoader__ = { load({ factory }: { factory(require: (id: string) => unknown): OfficialClient }) {
    plugin = factory(id => {
      if (!(id in modules)) throw new Error(`unexpected official client import: ${id}`)
      return modules[id]
    })
  } }
  runInNewContext(evaluated, {
    window: browser, document, navigator, console, URL, File, Blob, Element, HTMLElement,
    Node, Text, MutationObserver, ResizeObserver, getComputedStyle,
    setTimeout, clearTimeout, requestAnimationFrame, cancelAnimationFrame,
    __DSH_HOST_PATHS__: hostPaths,
  })
  if (plugin === undefined) throw new Error('official client factory did not load')
  return plugin
}

function attachmentView(): View {
  let view: View | undefined
  officialClient('@deepseek-ai/dsh-client-ui-attachment').apply({
    slots: {
      inject(name: string, register: () => void) {
        if (name === 'conversation.input.attachments') register()
      },
      register(_options: object, component: View) { view = component },
    },
  })
  if (view === undefined) throw new Error('official attachment slot was not registered')
  return view
}

let root: Root | undefined
let container: HTMLElement | undefined
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    disconnect(): void {}
  })
  Object.defineProperty(document, 'fonts', { configurable: true, value: new EventTarget() })
})
afterEach(async () => {
  await React.act(async () => { root?.unmount() })
  root = undefined
  container?.remove()
  container = undefined
  Reflect.deleteProperty(document, 'fonts')
  vi.unstubAllGlobals()
})

async function mountInput(options: { ready?: boolean; phase?: string; blocked?: string } = {}) {
  const Input = officialClient('@deepseek-ai/dsh-client-ui-conversation', true).inputBar!
  const Attachments = attachmentView()
  const addFiles = vi.fn<(files: readonly File[], directories?: ReadonlySet<File>) => null>(() => null)
  const bindFilePicker = vi.fn<(picker: { available(): boolean; open(): void }) => () => void>(() => () => {})
  const ready = options.ready !== false
  const snapshot = { draft: '', attachmentIds: [], phase: options.phase ?? 'plain' }
  const props = {
    sessionId: ready ? 'drop-session' : undefined,
    useSession: (select: (state: object) => unknown) => select({}),
    useInput: (select: (state: unknown) => unknown) => select(ready ? snapshot : undefined),
    useNotices: (select: (state: null) => unknown) => select(null),
    useBusyEnter: (select: (state: string) => unknown) => select('queue'),
    useStopShortcut: (select: (state: unknown[]) => unknown) => select([]),
    useMenuLauncher: (select: (state: null) => unknown) => select(null),
    useFileUploads: (select: (state: object) => unknown) => select({}),
    useLexicon: (select: (state: Map<string, unknown>) => unknown) => select(new Map()),
    useProjection: (_name: string, select?: (state: undefined) => unknown) => select?.(undefined),
    keyboard: ready ? { editor: null, bindFilePicker } : undefined,
    inputActions: ready ? {} : undefined,
    addFiles: ready ? addFiles : undefined,
    blocked: options.blocked,
    t: (key: string) => key,
    renderSlot: (name: string, slotProps: Record<string, unknown>) => name === 'conversation.input.attachments'
      ? React.createElement(Attachments, { ...slotProps, t: (key: string) => key })
      : null,
  }
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await React.act(async () => { root!.render(React.createElement(Input, props)) })
  return { addFiles, bindFilePicker }
}

async function dispatchDrag(type: string, dataTransfer: object): Promise<Event> {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
  await React.act(async () => { document.body.dispatchEvent(event) })
  return event
}

describe('official composer inside the Desktop content document', () => {
  it('accepts an image drop and the file picker through the same ready-session intake', async () => {
    const { addFiles, bindFilePicker } = await mountInput()
    const image = new File(['png'], 'pixel.png', { type: 'image/png' })
    const transfer = { types: ['Files'], files: [image], items: [], dropEffect: 'none' }
    await dispatchDrag('dragenter', transfer)
    expect((await dispatchDrag('dragover', transfer)).defaultPrevented).toBe(true)
    expect(transfer.dropEffect).toBe('copy')
    await dispatchDrag('drop', transfer)
    expect(addFiles).toHaveBeenCalledOnce()
    expect(addFiles.mock.calls[0]?.[0]).toHaveLength(1)
    expect(addFiles.mock.calls[0]?.[0][0]).toBe(image)
    expect(addFiles.mock.calls[0]?.[1]?.size).toBe(0)
    const input = container!.querySelector<HTMLInputElement>('input[type="file"]')!
    expect(input.disabled).toBe(false)
    expect(bindFilePicker).toHaveBeenCalledOnce()
    expect(bindFilePicker.mock.calls[0]?.[0].available()).toBe(true)
    Object.defineProperty(input, 'files', { value: [image] })
    await React.act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(addFiles).toHaveBeenCalledTimes(2)
    expect(addFiles.mock.calls[1]?.[0]).toEqual([image])
  })

  it.each([
    { ready: false }, { phase: 'adjudicating' }, { phase: 'submitting' }, { blocked: 'model unavailable' },
  ])('preserves the upstream drop and picker gate for %j', async options => {
    const { addFiles, bindFilePicker } = await mountInput(options)
    const image = new File(['png'], 'pixel.png', { type: 'image/png' })
    const transfer = { types: ['Files'], files: [image], items: [], dropEffect: 'copy' }
    await dispatchDrag('dragenter', transfer)
    await dispatchDrag('dragover', transfer)
    expect(transfer.dropEffect).toBe('none')
    await dispatchDrag('drop', transfer)
    expect(addFiles).not.toHaveBeenCalled()
    if ('ready' in options && options.ready === false) expect(bindFilePicker).not.toHaveBeenCalled()
    else expect(bindFilePicker.mock.calls[0]?.[0].available()).toBe(false)
  })

  it('leaves text drags to native handling rather than turning them into images', async () => {
    const { addFiles } = await mountInput()
    const transfer = { types: ['text/plain'], files: [], items: [], dropEffect: 'none' }
    expect((await dispatchDrag('dragover', transfer)).defaultPrevented).toBe(false)
    expect((await dispatchDrag('drop', transfer)).defaultPrevented).toBe(false)
    expect(addFiles).not.toHaveBeenCalled()
  })

  it('reads the official host path capability without accepting the legacy bridge as that contract', () => {
    const pathFor = vi.fn(() => '/workspace/notes.txt')
    const client = officialClient('@deepseek-ai/dsh-client-ui-conversation', true, { pathFor })
    const file = new File(['notes'], 'notes.txt', { type: 'text/plain' })
    expect(client.hostPathBridge?.()?.pathFor(file)).toBe('/workspace/notes.txt')
    expect(pathFor).toHaveBeenCalledExactlyOnceWith(file)
  })
})
