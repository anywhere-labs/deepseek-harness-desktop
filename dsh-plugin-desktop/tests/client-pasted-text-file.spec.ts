// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { acceptPastedTextFile, createPastedTextFile, installPastedTextFileBridge, shouldAttachPastedText,
  type PastedTextFileWindow } from '../src/client/pasted-text-file.ts'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
const large = '文本'.repeat(500)
const readText = (file: File): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => resolve(String(reader.result))
  reader.onerror = () => reject(reader.error)
  reader.readAsText(file)
})

describe('pasted text files', () => {
  it.each([
    ['x'.repeat(999), false], ['x'.repeat(1000), true],
    ['中'.repeat(999), false], [large, true],
    ['😀'.repeat(999), false], ['😀'.repeat(1000), true],
    [Array(14).fill('日志').join('\n'), false], [Array(15).fill('日志').join('\n'), true],
    [Array(14).fill('日志').join('\r\n'), false], [Array(15).fill('日志').join('\r\n'), true],
    [Array(15).fill('日志').join('\r'), true], [' \t\r\n'.repeat(500), false], ['', false],
    [JSON.stringify({ log: 'x'.repeat(1000) }), true],
  ])('uses character and logical-line thresholds (%#)', (text, expected) => {
    expect(shouldAttachPastedText(text)).toBe(expected)
  })

  it('preserves UTF-8 content, line endings and indentation, with a unique name per paste', async () => {
    const original = '中文😀\r\n  {"日志": "test"}\r\n\r\n\t' + large
    const a = createPastedTextFile(original); const b = createPastedTextFile(original)
    expect(a.name).toMatch(/^粘贴文本-\d{8}-\d{6}-[a-f0-9]{8}\.txt$/)
    expect(b.name).not.toBe(a.name)
    expect(a.type).toBe('text/plain')
    expect(a.size).toBe(new TextEncoder().encode(original).length)
    expect(await readText(a)).toBe(original)
  })

  it('accepts once and falls back for short text, rejection or failure', () => {
    const add = vi.fn(() => null)
    expect(acceptPastedTextFile('short', add)).toBe(false)
    expect(add).not.toHaveBeenCalled()
    expect(acceptPastedTextFile(large, add)).toBe(true)
    expect(add).toHaveBeenCalledOnce()
    expect(acceptPastedTextFile(large, () => 'session unavailable')).toBe(false)
    expect(acceptPastedTextFile(large, () => { throw new Error('failed') })).toBe(false)
    vi.stubGlobal('File', class { constructor() { throw new Error('allocation failed') } })
    expect(acceptPastedTextFile(large, add)).toBe(false)
    expect(add).toHaveBeenCalledOnce()
  })

  it('restores the previous scoped bridge and leaves newer owners alone', () => {
    const old = vi.fn(() => false)
    const page: PastedTextFileWindow = { __DSH_DESKTOP_PASTED_TEXT_FILE__: old }
    const dispose = installPastedTextFileBridge(page)
    expect(page.__DSH_DESKTOP_PASTED_TEXT_FILE__).toBe(acceptPastedTextFile)
    dispose(); expect(page.__DSH_DESKTOP_PASTED_TEXT_FILE__).toBe(old)
    const empty: PastedTextFileWindow = {}
    installPastedTextFileBridge(empty)(); expect(empty.__DSH_DESKTOP_PASTED_TEXT_FILE__).toBeUndefined()
    const disposeAgain = installPastedTextFileBridge(page)
    page.__DSH_DESKTOP_PASTED_TEXT_FILE__ = old
    disposeAgain(); expect(page.__DSH_DESKTOP_PASTED_TEXT_FILE__).toBe(old)
  })
})

// Run the actual installed keymap and view adapter from each pinned UI package.
// This guards the patch seams without substituting an imitation of paste routing.
function installedPaste() {
  const source = readFileSync('node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js', 'utf8')
  const page: PastedTextFileWindow = {}
  installPastedTextFileBridge(page)
  const paste = vi.fn()
  const addFiles = vi.fn((_files: readonly File[]): string | null => null)
  const intakeFiles = vi.fn()
  const gate = { current: { locked: false, machineBusy: false, canAcceptDrop: true, addFiles, intakeFiles } }
  let handlers!: { pasteText(text: string, files: boolean): void }
  const start = source.indexOf('return registerComposerKeymap(editor, {', source.indexOf('function installDraftKeymap(') >= 0
    ? source.indexOf('function installDraftKeymap(') : source.indexOf('const gate = (0, react.useRef)({'))
  const end = source.indexOf('\n\t\t\t});', start) >= 0 && source.includes('function installDraftKeymap(')
    ? source.indexOf('\n\t\t\t});', start) + '\n\t\t\t});'.length
    : source.indexOf('\n\t\t\t\t});', start) + '\n\t\t\t\t});'.length
  new Script(`(function(){${source.slice(start, end)}})()`).runInNewContext({
    window: page, gate, keyboard: { paste }, editor: {},
    registerComposerKeymap: (_editor: unknown, value: typeof handlers) => { handlers = value },
  })
  const clipboardStart = source.indexOf('const clipboardData = event.clipboardData ?? null;')
  const clipboardEnd = source.indexOf('\n\t\t\t}, 4)', clipboardStart)
  const route = new Script(`(event) => {${source.slice(clipboardStart, clipboardEnd)}}`).runInNewContext({
    handlers: { ...handlers, intakeFiles },
  }) as (event: object) => boolean
  const dispatch = (text: string, items: object[] = []) => {
    const event = { clipboardData: { items, getData: () => text }, preventDefault: vi.fn() }
    route(event)
    return event
  }
  return { page, paste, addFiles, intakeFiles, gate, dispatch, source }
}

describe('published composer paste integration', () => {
  it('attaches large text without editing the existing draft or selection and preserves short-text insertion', async () => {
    const f = installedPaste()
    f.dispatch(large)
    expect(f.paste).not.toHaveBeenCalled()
    expect(f.addFiles).toHaveBeenCalledOnce()
    expect(await readText(f.addFiles.mock.calls[0]![0][0]!)).toBe(large)
    f.dispatch('short')
    expect(f.paste).toHaveBeenCalledExactlyOnceWith('short')
    expect(f.addFiles).toHaveBeenCalledOnce()
  })

  it('leaves image, file, directory and mixed clipboard contents on the existing path', () => {
    const f = installedPaste()
    const file = new File(['x'], 'original.txt')
    const item = { kind: 'file', getAsFile: () => file, webkitGetAsEntry: () => ({ isDirectory: false }) }
    f.dispatch(large, [item])
    f.dispatch(large, [{ ...item, webkitGetAsEntry: () => ({ isDirectory: true }) }])
    f.dispatch(large, [{ kind: 'file', getAsFile: () => null }])
    f.dispatch('', [{ ...item, getAsFile: () => new File(['x'], 'image.png', { type: 'image/png' }) }])
    expect(f.addFiles).not.toHaveBeenCalled()
    expect(f.paste).toHaveBeenCalledTimes(3)
    expect(f.intakeFiles).toHaveBeenCalledTimes(3)
  })

  it('falls back once on synchronous rejection and preserves unavailable or non-Desktop behavior', () => {
    const f = installedPaste()
    f.addFiles.mockReturnValue('unavailable')
    f.dispatch(large)
    expect(f.paste).toHaveBeenCalledExactlyOnceWith(large)
    f.gate.current.canAcceptDrop = false
    f.dispatch(large)
    expect(f.addFiles).toHaveBeenCalledOnce()
    delete f.page.__DSH_DESKTOP_PASTED_TEXT_FILE__
    f.gate.current.canAcceptDrop = true
    f.dispatch(large)
    expect(f.addFiles).toHaveBeenCalledOnce()
    expect(f.paste).toHaveBeenCalledTimes(3)
  })

  it('honors locked and submitting guards without creating files or changing text', () => {
    const f = installedPaste()
    f.gate.current.locked = true; f.dispatch(large)
    f.gate.current.locked = false; f.gate.current.machineBusy = true; f.dispatch(large)
    expect(f.paste).not.toHaveBeenCalled(); expect(f.addFiles).not.toHaveBeenCalled()
  })

  it('uses the current session receiver and queues independent files in paste order', async () => {
    const f = installedPaste()
    f.dispatch(large)
    const next = vi.fn((_files: readonly File[]): string | null => null)
    f.gate.current = { ...f.gate.current, addFiles: next }
    const second = '第二次'.repeat(400)
    f.dispatch(second)
    expect(f.addFiles).toHaveBeenCalledOnce(); expect(next).toHaveBeenCalledOnce()
    expect(await readText(next.mock.calls[0]![0][0]!)).toBe(second)
    expect(f.paste).not.toHaveBeenCalled()
    // Both initial and refreshed gate objects must receive the real file receiver.
    expect(f.source.match(/addFiles, (?:canAcceptDrop, )?intakeFiles,/g)).toHaveLength(2)
  })
})
