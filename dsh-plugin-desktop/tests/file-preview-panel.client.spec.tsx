// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
// React 18 act() requires the environment flag to report async work correctly.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
import type { FilePreviewDescriptor, FilePreviewResourceId } from '../src/file-preview-contract.ts'
import { FilePreviewResourceId as brandResourceId } from '../src/file-preview-contract.ts'
import type { FilePreviewSnapshot } from '../src/client/file-preview/controller.ts'
import { FilePreviewRegistry, type FilePreviewProvider, type FilePreviewRendererProps } from '../src/client/file-preview/registry.ts'
import { FilePreviewPanel } from '../src/client/file-preview/FilePreviewPanel.tsx'
import { ImageView } from '../src/client/file-preview/providers/ImagePreview.tsx'
import { MarkdownView } from '../src/client/file-preview/providers/MarkdownPreview.tsx'
import { JsonView } from '../src/client/file-preview/providers/JsonPreview.tsx'

const RID: FilePreviewResourceId = brandResourceId('rid-1')

function textDescriptor(): FilePreviewDescriptor {
  return {
    availability: 'available',
    resourceId: RID,
    displayPath: '/w/file.ts',
    name: 'file.ts',
    extension: '.ts',
    mediaType: 'text/typescript',
    contentKind: 'text',
    size: 12,
  }
}

function imageDescriptor(): FilePreviewDescriptor {
  return {
    availability: 'available',
    resourceId: RID,
    displayPath: '/w/pic.png',
    name: 'pic.png',
    extension: '.png',
    mediaType: 'image/png',
    contentKind: 'image',
    size: 64,
  }
}

function readySnapshot(): FilePreviewSnapshot {
  return {
    status: 'ready', sessionId: 's', path: '/w/file.ts',
    descriptor: textDescriptor(), providerId: 'plain',
    content: { kind: 'text', text: 'const x = 1' },
  }
}

function provider(id: string, Component: FilePreviewProvider['Component']): FilePreviewProvider {
  return {
    id, priority: 100, loadMode: 'text',
    supports: descriptor => descriptor.contentKind === 'text',
    Component,
  }
}

function makeRegistry(entry: FilePreviewProvider): FilePreviewRegistry {
  const registry = new FilePreviewRegistry()
  registry.register(entry)
  return registry
}

function fakeCallbacks() {
  const calls = { refresh: 0, close: 0, open: 0 }
  return {
    calls,
    props: {
      onRefresh: () => { calls.refresh += 1 },
      onClose: () => { calls.close += 1 },
      onOpenExternally: async () => { calls.open += 1 },
    },
  }
}

function mount(panel: ReactNode) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => { root.render(panel) })
  const text = () => container.textContent ?? ''
  const click = (selector: string): void => {
    const el = container.querySelector(selector)
    act(() => { el?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
  }
  const cleanup = () => {
    act(() => { root.unmount() })
    container.remove()
  }
  return { container, text, click, cleanup }
}

/** A trivial provider component that echoes an identifiable marker. */
function PlainRender({ descriptor }: FilePreviewRendererProps): ReactNode {
  return <div data-marker="plain-render">{descriptor.name}</div>
}

/** A provider whose render always throws so the boundary must contain it. */
function ThrowingRender(_props: FilePreviewRendererProps): ReactNode {
  throw new Error('boom')
}

describe('file-preview-panel (client)', () => {
  it('shows the Chinese loading copy', () => {
    const snapshot: FilePreviewSnapshot = { status: 'loading', sessionId: 's', path: '/w/file.ts', revision: 1 }
    const { text, cleanup } = mount(<FilePreviewPanel snapshot={snapshot} registry={makeRegistry(provider('plain', PlainRender))} {...fakeCallbacks().props} />)
    expect(text()).toContain('正在读取文件…')
    cleanup()
  })

  it('shows an error message with retry and system-open actions when retryable', () => {
    const snapshot: FilePreviewSnapshot = {
      status: 'error', sessionId: 's', path: '/w/file.ts',
      error: { code: 'read-failed', message: '读取失败', retryable: true }, retryable: true,
    }
    const cb = fakeCallbacks()
    const { container, text, cleanup } = mount(<FilePreviewPanel snapshot={snapshot} registry={makeRegistry(provider('plain', PlainRender))} {...cb.props} />)
    expect(text()).toContain('读取失败')
    const retry = [...container.querySelectorAll('button')].find(b => b.textContent === '重试')
    const sysOpen = [...container.querySelectorAll('button')].find(b => b.textContent === '系统打开')
    expect(retry).toBeDefined()
    expect(sysOpen).toBeDefined()
    act(() => { retry!.click() })
    act(() => { sysOpen!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(cb.calls.refresh).toBe(1)
    expect(cb.calls.open).toBe(1)
    cleanup()
  })

  it('renders metadata-only (oversized) with size, limit, type, and system-open', () => {
    const descriptor: FilePreviewDescriptor = {
      availability: 'oversized', limitBytes: 1024,
      displayPath: '/w/big.log', name: 'big.log', extension: '.log',
      mediaType: 'text/plain', contentKind: 'text', size: 4096,
    }
    const snapshot: FilePreviewSnapshot = {
      status: 'ready', sessionId: 's', path: '/w/big.log', descriptor,
      providerId: 'none', content: { kind: 'metadata-only' },
    }
    const { container, text, cleanup } = mount(<FilePreviewPanel snapshot={snapshot} registry={makeRegistry(provider('plain', PlainRender))} {...fakeCallbacks().props} />)
    expect(text()).toContain('文件过大')
    expect(text()).toContain('4096 字节')
    expect(text()).toContain('1024 字节')
    expect(text()).toContain('text/plain')
    expect([...container.querySelectorAll('button')].find(b => b.textContent === '系统打开')).toBeDefined()
    cleanup()
  })

  it('exposes refresh / system-open / close icon actions with aria labels', () => {
    const cb = fakeCallbacks()
    const { container, click, cleanup } = mount(<FilePreviewPanel snapshot={readySnapshot()} registry={makeRegistry(provider('plain', PlainRender))} {...cb.props} />)
    const refresh = container.querySelector('button[aria-label="刷新"]')
    const sysOpen = container.querySelector('button[aria-label="系统打开"]')
    const closeBtn = container.querySelector('button[aria-label="关闭"]')
    expect(refresh).toBeDefined()
    expect(sysOpen).toBeDefined()
    expect(closeBtn).toBeDefined()
    click('button[aria-label="刷新"]')
    click('button[aria-label="关闭"]')
    expect(cb.calls.refresh).toBe(1)
    expect(cb.calls.close).toBe(1)
    cleanup()
  })

  it('renders a provider from the registry by providerId', () => {
    const { container, text, cleanup } = mount(
      <FilePreviewPanel snapshot={readySnapshot()} registry={makeRegistry(provider('plain', PlainRender))} {...fakeCallbacks().props} />,
    )
    expect(container.querySelector('[data-marker="plain-render"]')).toBeDefined()
    expect(text()).toContain('file.ts')
    cleanup()
  })

  it('contains a provider render crash without taking down the panel', () => {
    const { container, text, cleanup } = mount(
      <FilePreviewPanel snapshot={readySnapshot()} registry={makeRegistry(provider('plain', ThrowingRender))} {...fakeCallbacks().props} />,
    )
    expect(text()).toContain('预览器渲染失败')
    expect(container.querySelector('button')).toBeDefined()
    cleanup()
  })

  it('shows a non-blocking notice when system-open fails', async () => {
    const { text, cleanup } = mount(
      <FilePreviewPanel
        snapshot={readySnapshot()}
        registry={makeRegistry(provider('plain', PlainRender))}
        onRefresh={() => {}}
        onClose={() => {}}
        onOpenExternally={async () => { throw new Error('no') }}
      />,
    )
    // Flush the rejection microtask through an async act so the notice renders.
    const el = document.querySelector('button[aria-label="系统打开"]')
    await act(async () => { el?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    expect(text()).toContain('系统打开失败')
    cleanup()
  })

  it('renders markdown tabs and switches between preview and source', () => {
    const markdownProvider: FilePreviewProvider = {
      id: 'markdown', priority: 350, loadMode: 'text',
      supports: descriptor => descriptor.extension === '.md',
      Component: MarkdownView,
    }
    const snapshot: FilePreviewSnapshot = {
      status: 'ready', sessionId: 's', path: '/w/readme.md',
      descriptor: {
        availability: 'available', resourceId: RID,
        displayPath: '/w/readme.md', name: 'readme.md', extension: '.md',
        mediaType: 'text/markdown', contentKind: 'text', size: 20,
      },
      providerId: 'markdown', content: { kind: 'text', text: '# hello' },
    }
    const { container, text, cleanup } = mount(
      <FilePreviewPanel snapshot={snapshot} registry={makeRegistry(markdownProvider)} {...fakeCallbacks().props} />,
    )
    expect(container.querySelector('[role="tab"]')).toBeDefined()
    expect(text()).toContain('预览')
    expect(text()).toContain('源码')
    // Switch to source view and confirm the raw markdown text is now visible.
    const sourceTab = [...container.querySelectorAll('[role="tab"]')].find(t => t.textContent === '源码')
    expect(sourceTab).toBeDefined()
    act(() => { sourceTab!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(container.querySelector('pre.dshDesktopSourcePlain')?.textContent).toContain('# hello')
    cleanup()
  })

  it('renders a JSON tree and a source tab', () => {
    const jsonProvider: FilePreviewProvider = {
      id: 'json', priority: 400, loadMode: 'text',
      supports: descriptor => descriptor.extension === '.json',
      Component: JsonView,
    }
    const snapshot: FilePreviewSnapshot = {
      status: 'ready', sessionId: 's', path: '/w/data.json',
      descriptor: {
        availability: 'available', resourceId: RID,
        displayPath: '/w/data.json', name: 'data.json', extension: '.json',
        mediaType: 'application/json', contentKind: 'text', size: 20,
      },
      providerId: 'json', content: { kind: 'text', text: '{"a":1}' },
    }
    const { container, text, cleanup } = mount(
      <FilePreviewPanel snapshot={snapshot} registry={makeRegistry(jsonProvider)} {...fakeCallbacks().props} />,
    )
    expect(container.querySelector('[role="tree"]')).toBeDefined()
    expect(text()).toContain('树')
    expect(text()).toContain('源码')
    cleanup()
  })

  it('image load failure swaps to a provider-local error that keeps system-open', () => {
    const imageProvider: FilePreviewProvider = {
      id: 'image', priority: 300, loadMode: 'binary-url',
      supports: descriptor => descriptor.contentKind === 'image',
      Component: ImageView,
    }
    const snapshot: FilePreviewSnapshot = {
      status: 'ready', sessionId: 's', path: '/w/pic.png', descriptor: imageDescriptor(),
      providerId: 'image',
      content: { kind: 'binary-url', url: '/desktop-file-preview-content/rid-1' },
    }
    const { container, text, cleanup } = mount(
      <FilePreviewPanel snapshot={snapshot} registry={makeRegistry(imageProvider)} {...fakeCallbacks().props} />,
    )
    const img = container.querySelector('img')
    expect(img).toBeDefined()
    act(() => { img!.dispatchEvent(new Event('error')) })
    expect(text()).toContain('图片加载失败')
    expect(text()).toContain('系统打开')
    cleanup()
  })
})
