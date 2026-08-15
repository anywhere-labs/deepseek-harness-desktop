// @vitest-environment jsdom
// InputBar behavior over the machine wiring: Enter-send semantics (IME guard,
// Shift newline, busy Enter policy, Ctrl/Meta steering, repeat suppression), running
// semantics (input stays free; continuable children keep Send beside Stop), the machine pending lock,
// decoration backdrop, error/notice strips, and the focus-keeping mousedown.

import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import {
  createSnapshotStore, EMPTY_CHAT_SNAPSHOT, EMPTY_CONVERSATION_VIEWS,
} from '@deepseek-ai/dsh-client-runtime/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { ClientContext, ConversationSnapshot, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { SessionInputShell } from '../src/client/input/facade.ts'
import type { ComposerAttachment } from '../src/client/contract/slots.ts'
import type { DraftAttachmentId } from '../src/client/input/contract.ts'
import { InputBar } from '../src/client/skeleton/InputBar.tsx'
import type { InputBarProps } from '../src/client/skeleton/InputBar.tsx'
import { zh } from '../src/client/locales.ts'
import * as forkFlags from '../src/client/fork-flags.ts'

afterEach(cleanup)

// jsdom implements no Range geometry at all — `Range.prototype.getBoundingClientRect`
// is absent — and the composer measures the caret with one when it restores the
// selection after an edit it performed itself. Every case here runs against a
// zero rect; the reveal case below substitutes its own and restores this one.
const ZERO_RECT = (): DOMRect => ({ top: 0, bottom: 0 }) as DOMRect
Range.prototype.getBoundingClientRect = ZERO_RECT

// Read through the descriptor so the native method is never referenced unbound;
// the reveal case below wraps it to record what it was asked to measure.
const NATIVE_SET_START = Object.getOwnPropertyDescriptor(Range.prototype, 'setStart')!
  .value as (this: Range, node: Node, offset: number) => void

const SCTX = {} as ClientContext
const SID = 's1' as SessionId

function snapshotOf(overrides: Partial<ConversationSnapshot> = {}): ConversationSnapshot {
  return {
    sessionId: SID, views: EMPTY_CONVERSATION_VIEWS, chat: EMPTY_CHAT_SNAPSHOT,
    nodes: [], turnTimings: new Map(), turnEnds: new Map(), partial: null, runningCalls: [],
    pending: [], queue: [], running: false, composerPhase: 'active', removed: false,
    openState: 'open', openError: null, hasMore: false, loadingOlder: false,
    promptError: null, blank: false, subagent: null, lastAgentError: null,
    ...overrides,
  }
}

interface BenchOptions {
  planEntry?: React.ReactNode
  /** The `plan` projection value the standard-kit useProjection serves. */
  plan?: { active: boolean; pending: boolean }
  modelEntry?: React.ReactNode
  /** Hot text-ref lexicon (injects a minimal slash stub exposing only lexicon()). */
  lexicon?: ReadonlyMap<'/' | '@', readonly string[]>
  permissions?: { options: { value: string; name: string; description?: string }[]; currentValue: string }
  /** The `imageLimits` projection value (absent = no attachment service). */
  imageLimits?: {
    maxImageBytes: number
    maxImagesPerMessage: number
    maxMessageImageBytes: number
    maxImagePixels: number
    mediaTypes: readonly ('image/png' | 'image/jpeg' | 'image/webp' | 'image/gif')[]
  }
  draft?: string
  running?: boolean
  subagent?: Exclude<ConversationSnapshot['subagent'], null>
  disabled?: boolean
  inert?: boolean
  workspacePickerOpen?: boolean
  onRequestWorkspace?: () => void
  promptError?: ConversationSnapshot['promptError']
  /** Authoritative queue rows served to the machine overlay (empty = none). */
  queue?: ConversationSnapshot['queue']
  /** The hub's steer-all face (empty-draft accelerated Enter). */
  steerQueue?: () => void
  variant?: 'hero' | 'composer'
  placeholder?: string
  t?: InputBarProps['t']
  command?: (line: string) => Promise<boolean>
  accessory?: React.ReactNode
  overlay?: React.ReactNode
  leftItems?: React.ReactNode
  rightItems?: React.ReactNode
  attachments?: readonly ComposerAttachment[]
  addImages?: (files: readonly File[]) => string | null
  commandMenuOpen?: boolean
  busyEnter?: 'queue' | 'steer'
  toggleCommandMenu?: (selection: { start: number; end: number }) => void
}

/** One pending queue row (the runtime snapshot shape, as the dock tests build it). */
function row(id: string): ConversationSnapshot['queue'][number] {
  return {
    id: id as never, messageId: `message-${id}` as never, placement: 'queued',
    content: [{ type: 'text', text: id }], preview: id, text: id,
  }
}

/** Real machine behind the bar entry: sink spy, no slash pipeline (plain text goes straight to the sink). */
function bench(over?: BenchOptions) {
  const sink = vi.fn()
  const lex = over?.lexicon
  const session = createSnapshotStore<ConversationSnapshot>(snapshotOf({
    running: over?.running ?? false,
    subagent: over?.subagent ?? null,
    removed: over?.disabled ?? false,
    promptError: over?.promptError ?? null,
    queue: over?.queue ?? [],
  }))
  type ShellDeps = ConstructorParameters<typeof SessionInputShell>[0]
  const shell = new SessionInputShell({
    actx: SCTX,
    defaultSink: sink,
    queue: {
      getSnapshot: () => session.getSnapshot().queue,
      subscribe: fn => session.subscribe(fn),
    },
    ...(over?.steerQueue !== undefined ? { steerQueue: over.steerQueue } : {}),
    // Lexicon-only stub: adjudication untouched (undefined slash methods are
    // never reached — these benches drive plain-draft flows only).
    ...(lex !== undefined
      ? {
        inputTriggers: (() => ({
          lexicon: { getSnapshot: () => lex, subscribe: () => () => {} },
        })) as unknown as NonNullable<ShellDeps['inputTriggers']>,
      }
      : {}),
  })
  if (over?.draft !== undefined && over.draft !== '') shell.setDraft(over.draft)
  if (over?.attachments !== undefined) shell.addImages(over.attachments.map(attachment => attachment.id))
  const stop = vi.fn()
  const removeImage = vi.fn((id: DraftAttachmentId) => { shell.removeImage(id) })
  const menuLauncher = createSnapshotStore<string | null>(over?.commandMenuOpen === true ? 'command' : null)
  const slotCalls: { key: string; owner: unknown }[] = []
  const renderSlot = ((key: string, owner: object) => {
    slotCalls.push({ key, owner })
    if (key === 'conversation.input.plan') return over?.planEntry ?? null
    if (key === 'conversation.input.model') return over?.modelEntry ?? null
    return null
  }) as InputBarProps['renderSlot']
  const props: InputBarProps = {
    sessionId: SID,
    SessionProvider: ({ children }) => children(SID),
    useSession: bindSnapshotSelector(session),
    useSessions: bindSnapshotSelector(createSnapshotStore({
      ids: [], byId: {}, current: undefined, phase: 'ready',
      subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
    })),
    useWorkspaces: bindSnapshotSelector(createSnapshotStore({
      items: [], archivedSessionIds: [], state: 'idle', phase: 'ready', error: null,
      baselinesReady: true, recentWorkspaceId: undefined,
    })),
    useProjection: ((key: string, selector?: (v: unknown) => unknown) =>
      (selector ?? (v => v))(key === 'permissions'
        ? over?.permissions
        : key === 'plan' ? over?.plan : key === 'imageLimits' ? over?.imageLimits : undefined)),
    useInput: bindSnapshotSelector(shell.state),
    inputActions: shell.actions,
    keyboard: shell,
    addImages: over?.addImages ?? (() => null),
    removeImage,
    draftImages: ids => ids.flatMap((id) => {
      const attachment = over?.attachments?.find(candidate => candidate.id === id)
      return attachment === undefined ? [] : [attachment]
    }),
    resolveSubmitMode: (running, gesture, steeringAvailable) => {
      if (!running || !steeringAvailable) return 'queue'
      const preferred = over?.busyEnter ?? 'queue'
      return gesture === 'enter' ? preferred : preferred === 'queue' ? 'steer' : 'queue'
    },
    toggleCommandMenu: over?.toggleCommandMenu ?? vi.fn(),
    useNotices: bindSnapshotSelector(shell.notices),
    useLexicon: bindSnapshotSelector(shell.lexicon),
    useMenuLauncher: bindSnapshotSelector(menuLauncher),
    stop,
    command: over?.command ?? (() => Promise.resolve(true)),
    clearNotice: () => { if (forkFlags.feedbackPatchEnabled()) shell.clearNotice() },
    // Mirrors the real lookup chain (conversation namespace, then common).
    t: over?.t ?? makeTranslate(zh, commonZh),
    renderSlot,
    variant: over?.variant ?? 'composer',
    ...(over?.inert === true ? { disabled: true } : {}),
    ...(over?.workspacePickerOpen !== undefined ? { workspacePickerOpen: over.workspacePickerOpen } : {}),
    ...(over?.onRequestWorkspace !== undefined ? { onRequestWorkspace: over.onRequestWorkspace } : {}),
    ...(over?.placeholder !== undefined ? { placeholder: over.placeholder } : {}),
    ...(over?.accessory !== undefined ? { accessory: over.accessory } : {}),
    ...(over?.overlay !== undefined ? { overlay: over.overlay } : {}),
    ...(over?.leftItems !== undefined ? { leftItems: over.leftItems } : {}),
    ...(over?.rightItems !== undefined ? { rightItems: over.rightItems } : {}),
  }
  const view = render(<InputBar {...props} />)
  const textarea = view.container.querySelector('textarea')!
  const primaryStops = over?.running === true && over.subagent === undefined
  const button = view.container.querySelector<HTMLButtonElement>(
    `button[aria-label="${primaryStops ? '停止生成' : '发送消息'}"]`,
  )!
  const interruptButton = view.container.querySelector<HTMLButtonElement>('button[aria-label="停止生成"]')
  return {
    view, textarea, button, interruptButton, props, sink, shell, wiring: shell, session, stop, removeImage, slotCalls,
    menuLauncher,
    steerQueue: over?.steerQueue,
  }
}

describe('image draft rail', () => {
  it('collects clipboard files while preserving text from a mixed paste', () => {
    const addImages = vi.fn(() => null)
    const { textarea, shell } = bench({ addImages })
    const image = new File([Uint8Array.of(1, 2, 3)], 'pixel.png', { type: 'image/png' })
    fireEvent.paste(textarea, {
      clipboardData: {
        items: [
          { kind: 'string', type: 'text/plain', getAsFile: () => null },
          { kind: 'file', type: 'image/png', getAsFile: () => image },
        ],
        getData: () => '同时粘贴的文字',
      },
    })
    expect(addImages).toHaveBeenCalledWith([image])
    expect(shell.snapshot.draft).toBe('同时粘贴的文字')
  })

  it('accepts a drop anywhere on the page under the full-page overlay', () => {
    const addImages = vi.fn(() => null)
    const { view } = bench({ addImages })
    const image = new File([Uint8Array.of(1)], 'dropped.png', { type: 'image/png' })
    const dataTransfer = { types: ['Files'], files: [image], dropEffect: 'none' }
    // The drag never touches the composer card: the listeners are page-wide.
    expect(fireEvent.dragEnter(document.body, { dataTransfer })).toBe(false)
    expect(view.getByRole('status').textContent).toContain('图片拖动到此处即可添加')
    expect(fireEvent.dragOver(document.body, { dataTransfer })).toBe(false)
    expect(dataTransfer.dropEffect).toBe('copy')
    expect(fireEvent.drop(document.body, { dataTransfer })).toBe(false)
    expect(addImages).toHaveBeenCalledWith([image])
    expect(view.queryByRole('status')).toBeNull()
  })

  it('keeps text drags native and hides the overlay when the drag leaves or ends', () => {
    const addImages = vi.fn(() => null)
    const { view } = bench({ addImages })
    // A text drag carries no Files type: no overlay, native behavior stays.
    fireEvent.dragEnter(document.body, { dataTransfer: { types: ['text/plain'], files: [], dropEffect: 'none' } })
    expect(view.queryByRole('status')).toBeNull()
    const dataTransfer = { types: ['Files'], files: [], dropEffect: 'none' }
    fireEvent.dragEnter(document.body, { dataTransfer })
    expect(view.getByRole('status')).toBeTruthy()
    fireEvent.dragLeave(document.body, { dataTransfer })
    expect(view.queryByRole('status')).toBeNull()
    // An aborted drag (Escape) fires dragend without a balancing leave.
    fireEvent.dragEnter(document.body, { dataTransfer })
    fireEvent.dragEnter(document.querySelector('textarea')!, { dataTransfer })
    expect(view.getByRole('status')).toBeTruthy()
    fireEvent.dragEnd(window, { dataTransfer })
    expect(view.queryByRole('status')).toBeNull()
    expect(addImages).not.toHaveBeenCalled()
  })

  it('pre-checks projected limits at intake: whole-batch refusal with product copy, none added', () => {
    const limits = {
      maxImageBytes: 1024 * 1024,
      maxImagesPerMessage: 2,
      maxMessageImageBytes: 2 * 1024 * 1024,
      maxImagePixels: 40_000_000,
      mediaTypes: ['image/png'] as const,
    }
    const png = (bytes: number, name: string) => new File([new ArrayBuffer(bytes)], name, { type: 'image/png' })
    const drop = (files: File[]) => {
      fireEvent.drop(document.body, { dataTransfer: { types: ['Files'], files, dropEffect: 'none' } })
    }
    // Count: three at once over a two-image limit → the whole batch refused.
    const overCount = bench({ addImages: vi.fn(() => null), imageLimits: limits })
    drop([png(8, 'a.png'), png(8, 'b.png'), png(8, 'c.png')])
    expect(overCount.view.getByRole('alert').textContent).toContain('一条消息最多添加 2 张图片')
    expect(overCount.props.addImages).not.toHaveBeenCalled()
    cleanup()
    // Per-file bytes.
    const overFile = bench({ addImages: vi.fn(() => null), imageLimits: limits })
    drop([png(1024 * 1024 + 1, 'big.png')])
    expect(overFile.view.getByRole('alert').textContent).toContain('单张图片不能超过 1MB')
    expect(overFile.props.addImages).not.toHaveBeenCalled()
    cleanup()
    // Aggregate bytes across the existing rail plus the new batch.
    const held = new File([new ArrayBuffer(1024 * 1024 * 1.5)], 'held.png', { type: 'image/png' })
    const attachment = { kind: 'image' as const, id: 'draft-1' as DraftAttachmentId, file: held, previewUrl: 'blob:held' }
    const overTotal = bench({ addImages: vi.fn(() => null), imageLimits: limits, attachments: [attachment] })
    drop([png(1024 * 1024, 'more.png')])
    expect(overTotal.view.getByRole('alert').textContent).toContain('图片总大小超过 2MB')
    expect(overTotal.props.addImages).not.toHaveBeenCalled()
    cleanup()
    // Within every limit: the batch passes through to addImages.
    const within = bench({ addImages: vi.fn(() => null), imageLimits: limits })
    const fits = png(16, 'fits.png')
    drop([fits])
    expect(within.props.addImages).toHaveBeenCalledWith([fits])
    expect(within.view.queryByRole('alert')).toBeNull()
  })

  it('announces the format problem before any limit when the batch holds a non-image', () => {
    const addImages = vi.fn(() => '仅支持 PNG、JPG、WebP、GIF 格式的图片')
    const { view } = bench({
      addImages,
      imageLimits: {
        maxImageBytes: 8,
        maxImagesPerMessage: 1,
        maxMessageImageBytes: 8,
        maxImagePixels: 40_000_000,
        mediaTypes: ['image/png'] as const,
      },
    })
    // Oversized AND over-count AND wrong type: the format rejection wins.
    const files = [
      new File([new ArrayBuffer(64)], 'a.pdf', { type: 'application/pdf' }),
      new File([new ArrayBuffer(64)], 'b.pdf', { type: 'application/pdf' }),
    ]
    fireEvent.drop(document.body, { dataTransfer: { types: ['Files'], files, dropEffect: 'none' } })
    expect(addImages).toHaveBeenCalledWith(files)
    expect(view.getByRole('alert').textContent).toContain('仅支持 PNG、JPG、WebP、GIF 格式的图片')
  })

  it('shows the projected limits in the drop overlay desc line', () => {
    const { view } = bench({
      addImages: vi.fn(() => null),
      imageLimits: {
        maxImageBytes: 5 * 1024 * 1024,
        maxImagesPerMessage: 20,
        maxMessageImageBytes: 100 * 1024 * 1024,
        maxImagePixels: 40_000_000,
        mediaTypes: ['image/png'] as const,
      },
    })
    fireEvent.dragEnter(document.body, { dataTransfer: { types: ['Files'], files: [], dropEffect: 'none' } })
    expect(view.getByRole('status').textContent).toContain('最多 20 张，每张 5MB')
  })

  it('announces server attachment rejections as product copy, other codes as developer text', () => {
    const attachmentError = (reason: string): ConversationSnapshot['promptError'] => ({
      op: 'send',
      error: { code: 'attachment-error', message: 'raw wire text', details: { reason } },
    })
    const model = bench({ promptError: attachmentError('MODEL_DOES_NOT_SUPPORT_IMAGES') })
    expect(model.view.getByRole('alert').textContent).toContain('当前模型不支持图片，请切换支持图片的模型')
    cleanup()
    const unknown = bench({ promptError: attachmentError('ATTACHMENT_NOT_REFERENCED') })
    expect(unknown.view.getByRole('alert').textContent).toContain('图片发送失败（ATTACHMENT_NOT_REFERENCED）')
    cleanup()
    const other = bench({
      promptError: { op: 'send', error: { code: 'internal', message: 'boom', details: {} } },
    })
    expect(other.view.getByRole('alert').textContent).toContain('boom (internal)')
  })

  it('shows the blocked overlay and refuses the drop while the composer is locked', () => {
    const addImages = vi.fn(() => null)
    const { view } = bench({ addImages, inert: true })
    const image = new File([Uint8Array.of(1)], 'dropped.png', { type: 'image/png' })
    const dataTransfer = { types: ['Files'], files: [image], dropEffect: 'copy' }
    fireEvent.dragEnter(document.body, { dataTransfer })
    expect(view.getByRole('status').textContent).toContain('当前无法添加图片')
    fireEvent.dragOver(document.body, { dataTransfer })
    expect(dataTransfer.dropEffect).toBe('none')
    fireEvent.drop(document.body, { dataTransfer })
    expect(addImages).not.toHaveBeenCalled()
    expect(view.queryByRole('status')).toBeNull()
  })

  it('sends an image-only draft and removes its thumbnail', () => {
    const file = new File([Uint8Array.of(1)], 'pixel.png', { type: 'image/png' })
    const attachment = { kind: 'image' as const, id: 'draft-1' as DraftAttachmentId, file, previewUrl: 'blob:draft-1' }
    const { view, textarea, sink, removeImage } = bench({ attachments: [attachment] })
    expect((view.getByRole('button', { name: '发送消息' }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(sink).toHaveBeenCalledWith('', ['draft-1'], 'queue')
    fireEvent.click(view.getByRole('button', { name: '移除图片 pixel.png' }))
    expect(removeImage).toHaveBeenCalledWith('draft-1')
  })

  it('opens the original image on a single click and closes it with Escape', () => {
    const file = new File([Uint8Array.of(1)], 'pixel.png', { type: 'image/png' })
    const attachment = { kind: 'image' as const, id: 'draft-1' as DraftAttachmentId, file, previewUrl: 'blob:draft-1' }
    const { view } = bench({ attachments: [attachment] })
    fireEvent.click(view.getByTitle('查看原图'))
    expect(view.getByRole('dialog', { name: '原图预览' })).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(view.queryByRole('dialog', { name: '原图预览' })).toBeNull()
  })

  it('announces an image-intake rejection as a fading toast, repeatable for the same reason', () => {
    vi.useFakeTimers()
    try {
      const addImages = vi.fn(() => '仅支持 PNG、JPG、WebP、GIF 格式的图片')
      const { view, textarea } = bench({ addImages })
      const paste = () => {
        fireEvent.paste(textarea, {
          clipboardData: {
            items: [{ kind: 'file', type: 'text/plain', getAsFile: () => new File(['x'], 'note.txt', { type: 'text/plain' }) }],
            getData: () => '',
          },
        })
      }
      paste()
      expect(view.getByRole('alert').textContent).toContain('仅支持 PNG、JPG、WebP、GIF 格式的图片')
      act(() => { vi.advanceTimersByTime(4000) })
      expect(view.queryByRole('alert')).toBeNull()
      // The identical rejection re-announces: the toast is keyed per show.
      paste()
      expect(view.getByRole('alert').textContent).toContain('仅支持 PNG、JPG、WebP、GIF 格式的图片')
    } finally {
      vi.useRealTimers()
    }
  })

  it('announces a rejected drop through the same toast', () => {
    const addImages = vi.fn(() => '图片读取服务不可用')
    const { view } = bench({ addImages })
    const card = view.container.querySelector('[class*="card"]')!
    const dataTransfer = { types: ['Files'], files: [new File([Uint8Array.of(1)], 'x.png', { type: 'image/png' })], dropEffect: 'none' }
    fireEvent.drop(card, { dataTransfer })
    expect(view.getByRole('alert').textContent).toContain('图片读取服务不可用')
  })
})

describe('Enter semantics', () => {
  it('advertises the empty-draft whole-queue steering gesture when it is available', () => {
    const { textarea } = bench({ running: true, queue: [row('q-1')], steerQueue: vi.fn() })
    expect(textarea.placeholder).toBe('Cmd/Ctrl+Enter 插话发送全部排队消息')
  })

  it('keeps the owning placeholder or ordinary guidance when whole-queue steering is unavailable', () => {
    expect(bench({ running: true }).textarea.placeholder).toBe('给智能体发消息')
    expect(bench({ queue: [row('q-1')] }).textarea.placeholder).toBe('给智能体发消息')
    expect(bench({ running: true, queue: [row('q-1')], draft: '消息' }).textarea.placeholder).toBe('给智能体发消息')
    expect(bench({
      running: true,
      queue: [row('q-1')],
      subagent: {
        address: { parentSessionId: 'parent' as SessionId, childSessionId: SID, mode: 'continuable' },
        parentAvailable: true,
      },
    }).textarea.placeholder).toBe('给智能体发消息')
    expect(bench({
      running: true,
      queue: [row('q-1')],
      placeholder: '上层指定提示',
    }).textarea.placeholder).toBe('上层指定提示')
    // The command menu owns Enter while open: neither the hint nor the
    // gesture may claim the chord.
    expect(bench({
      running: true,
      queue: [row('q-1')],
      commandMenuOpen: true,
    }).textarea.placeholder).toBe('给智能体发消息')
    // The steer hint intentionally outranks the plan placeholder: while it
    // shows, the whole-queue gesture is genuinely available in plan mode.
    expect(bench({
      running: true,
      queue: [row('q-1')],
      plan: { active: true, pending: false },
    }).textarea.placeholder).toBe('Cmd/Ctrl+Enter 插话发送全部排队消息')
  })

  it('an open command menu withholds the whole-queue steering gesture', () => {
    const steerQueue = vi.fn()
    const { textarea, sink } = bench({
      running: true,
      queue: [row('q-1')],
      commandMenuOpen: true,
      steerQueue,
    })
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true })
    expect(steerQueue).not.toHaveBeenCalled()
    expect(sink).not.toHaveBeenCalled()
  })

  it('plain Enter submits queue mode through the machine; repeat and empty are suppressed', () => {
    const { textarea, sink } = bench({ draft: 'hello' })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(sink).toHaveBeenCalledWith('hello', [], 'queue')
    fireEvent.keyDown(textarea, { key: 'Enter', repeat: true })
    expect(sink).toHaveBeenCalledTimes(1)
    const empty = bench({ draft: '   ' })
    fireEvent.keyDown(empty.textarea, { key: 'Enter' })
    expect(empty.sink).not.toHaveBeenCalled()
  })

  it('non-Enter keys and Shift+Enter fall through to native behavior', () => {
    const { textarea, sink } = bench({ draft: 'hello' })
    fireEvent.keyDown(textarea, { key: 'a' })
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })
    expect(sink).not.toHaveBeenCalled()
  })

  it('Shift+Enter newline wins even inside IME composition (unconditional precedence)', () => {
    const { textarea, sink } = bench({ draft: 'hello' })
    fireEvent.compositionStart(textarea)
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })
    expect(sink).not.toHaveBeenCalled() // and not preventDefault'd: native newline
  })

  it('Ctrl/Meta+Enter sends normally while idle and steers while running', () => {
    const idle = bench({ draft: 'hello' })
    fireEvent.keyDown(idle.textarea, { key: 'Enter', metaKey: true })
    expect(idle.sink).toHaveBeenCalledWith('hello', [], 'queue')

    const busyCtrl = bench({ running: true, draft: 'steer with ctrl' })
    fireEvent.keyDown(busyCtrl.textarea, { key: 'Enter', ctrlKey: true })
    expect(busyCtrl.sink).toHaveBeenCalledWith('steer with ctrl', [], 'steer')

    const busyMeta = bench({ running: true, draft: 'steer with cmd' })
    fireEvent.keyDown(busyMeta.textarea, { key: 'Enter', metaKey: true })
    expect(busyMeta.sink).toHaveBeenCalledWith('steer with cmd', [], 'steer')
  })

  it('empty-draft Cmd/Ctrl+Enter steers the whole queue instead of submitting', () => {
    const steerQueue = vi.fn()
    const queue = [row('q-1'), row('q-2')]
    const meta = bench({ running: true, queue, steerQueue })
    fireEvent.keyDown(meta.textarea, { key: 'Enter', metaKey: true })
    expect(meta.steerQueue).toHaveBeenCalledTimes(1)
    expect(meta.sink).not.toHaveBeenCalled()

    const ctrl = bench({ running: true, queue, steerQueue: vi.fn() })
    fireEvent.keyDown(ctrl.textarea, { key: 'Enter', ctrlKey: true })
    expect(ctrl.steerQueue).toHaveBeenCalledTimes(1)
    expect(ctrl.sink).not.toHaveBeenCalled()
  })

  it('queue steering stays gated: idle, subagent, plain Enter, empty queue, or steering-only rows', () => {
    // Idle: the gesture falls through to the machine's empty-draft no-op.
    const idle = bench({ queue: [row('q-1')], steerQueue: vi.fn() })
    fireEvent.keyDown(idle.textarea, { key: 'Enter', metaKey: true })
    expect(idle.steerQueue).not.toHaveBeenCalled()
    expect(idle.sink).not.toHaveBeenCalled()

    // Plain Enter never steers the queue, even under the busy Steer preference.
    const plain = bench({ running: true, busyEnter: 'steer', queue: [row('q-1')], steerQueue: vi.fn() })
    fireEvent.keyDown(plain.textarea, { key: 'Enter' })
    expect(plain.steerQueue).not.toHaveBeenCalled()
    expect(plain.sink).not.toHaveBeenCalled()

    // Subagent sessions keep the queue transport (no steering face).
    const subagent = {
      address: {
        parentSessionId: 'parent' as SessionId,
        childSessionId: SID,
        mode: 'continuable' as const,
      },
      parentAvailable: true,
    }
    const child = bench({ running: true, subagent, queue: [row('q-1')], steerQueue: vi.fn() })
    fireEvent.keyDown(child.textarea, { key: 'Enter', metaKey: true })
    expect(child.steerQueue).not.toHaveBeenCalled()
    expect(child.sink).not.toHaveBeenCalled()

    // No queued rows: the empty draft stays a no-op.
    const none = bench({ running: true, steerQueue: vi.fn() })
    fireEvent.keyDown(none.textarea, { key: 'Enter', metaKey: true })
    expect(none.steerQueue).not.toHaveBeenCalled()
    expect(none.sink).not.toHaveBeenCalled()

    // Pending steering rows are not the queue: nothing to flush.
    const steering = bench({
      running: true,
      queue: [{ ...row('s-1'), placement: 'steering' }],
      steerQueue: vi.fn(),
    })
    fireEvent.keyDown(steering.textarea, { key: 'Enter', metaKey: true })
    expect(steering.steerQueue).not.toHaveBeenCalled()
    expect(steering.sink).not.toHaveBeenCalled()
  })

  it('draft content outranks the queue: accelerated Enter steers the draft only', () => {
    const steerQueue = vi.fn()
    const { textarea, sink } = bench({ running: true, queue: [row('q-1')], draft: '插话', steerQueue })
    fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true })
    expect(sink).toHaveBeenCalledWith('插话', [], 'steer')
    expect(steerQueue).not.toHaveBeenCalled()
  })

  it('empty-draft accelerated Enter without a steerQueue face stays a silent no-op', () => {
    const { textarea, sink } = bench({ running: true, queue: [row('q-1')] })
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true })
    expect(sink).not.toHaveBeenCalled()
  })

  it('platform undo/redo chords route to the machine, never the browser stack', () => {
    const { textarea, shell } = bench({ draft: '' })
    fireEvent.change(textarea, { target: { value: 'first' } })
    fireEvent.change(textarea, { target: { value: 'first second' } })
    fireEvent.keyDown(textarea, { key: 'z', ctrlKey: true })
    expect(shell.snapshot.draft).not.toBe('first second')
    fireEvent.keyDown(textarea, { key: 'z', ctrlKey: true, shiftKey: true })
    expect(shell.snapshot.draft).toBe('first second')
  })

  it('composition Enter never sends: ref guard, isComposing, and keyCode 229 paths', () => {
    vi.useFakeTimers()
    try {
      const { textarea, sink } = bench({ draft: 'hello' })
      fireEvent.compositionStart(textarea)
      fireEvent.keyDown(textarea, { key: 'Enter' })
      expect(sink).not.toHaveBeenCalled()
      fireEvent.compositionEnd(textarea)
      // Safari delivers the closing keydown before the deferred clear.
      fireEvent.keyDown(textarea, { key: 'Enter' })
      expect(sink).not.toHaveBeenCalled()
      vi.advanceTimersByTime(20)
      fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 229 })
      expect(sink).not.toHaveBeenCalled()
      fireEvent.keyDown(textarea, { key: 'Enter' })
      expect(sink).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('running and lock semantics', () => {
  it('running keeps the input free (typing + Enter queue) while the primary turns stop', () => {
    const { textarea, button, stop, sink } = bench({ running: true, draft: '排队消息' })
    expect(textarea.disabled).toBe(false)
    fireEvent.change(textarea, { target: { value: '排队消息2' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(sink).toHaveBeenCalledWith('排队消息2', [], 'queue')
    expect(button.getAttribute('aria-label')).toBe('停止生成')
    fireEvent.click(button)
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('running plain Enter follows the busy-state Steer preference', () => {
    const { textarea, sink } = bench({ running: true, busyEnter: 'steer', draft: '直接插话' })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(sink).toHaveBeenCalledWith('直接插话', [], 'steer')
  })

  it('running Cmd/Ctrl+Enter uses the opposite of the busy-state Enter preference', () => {
    const meta = bench({ running: true, busyEnter: 'steer', draft: '排到下一轮' })
    fireEvent.keyDown(meta.textarea, { key: 'Enter', metaKey: true })
    expect(meta.sink).toHaveBeenCalledWith('排到下一轮', [], 'queue')

    const ctrl = bench({ running: true, busyEnter: 'steer', draft: 'also queue' })
    fireEvent.keyDown(ctrl.textarea, { key: 'Enter', ctrlKey: true })
    expect(ctrl.sink).toHaveBeenCalledWith('also queue', [], 'queue')
  })

  it('running continuable subagent keeps Send beside an independent Stop', () => {
    const { button, interruptButton, textarea, sink, stop } = bench({
      running: true,
      draft: '后续消息',
      subagent: {
        address: {
          parentSessionId: 'parent' as SessionId,
          childSessionId: SID,
          mode: 'continuable',
        },
        parentAvailable: true,
      },
    })
    expect(button.getAttribute('aria-label')).toBe('发送消息')
    expect(interruptButton).not.toBeNull()
    expect(textarea.disabled).toBe(false)
    fireEvent.click(button)
    expect(sink).toHaveBeenCalledWith('后续消息', [], 'queue')
    fireEvent.click(interruptButton!)
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('parent-offline running continuable locks Send but keeps independent Stop usable', () => {
    const { button, interruptButton, textarea, stop, view } = bench({
      running: true,
      draft: '',
      subagent: {
        address: {
          parentSessionId: 'parent' as SessionId,
          childSessionId: SID,
          mode: 'continuable',
        },
        parentAvailable: false,
      },
    })
    expect(textarea.disabled).toBe(true)
    expect(textarea.placeholder).toBe('父会话已离线，无法继续发送；仍可停止当前运行')
    expect((view.getByLabelText('命令') as HTMLButtonElement).disabled).toBe(true)
    expect(button.getAttribute('aria-label')).toBe('发送消息')
    expect(button.disabled).toBe(true)
    expect(interruptButton?.disabled).toBe(false)
    fireEvent.click(interruptButton!)
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('running one-shot subagent never exposes Stop', () => {
    const { button, interruptButton, stop } = bench({
      running: true,
      draft: '不可停止',
      subagent: {
        address: {
          parentSessionId: 'parent' as SessionId,
          childSessionId: SID,
          mode: 'one-shot',
        },
        parentAvailable: true,
      },
    })
    expect(button.getAttribute('aria-label')).toBe('发送消息')
    expect(interruptButton).toBeNull()
    expect(stop).not.toHaveBeenCalled()
  })

  it('keeps both running subagent Enter gestures on Queue transport', () => {
    const subagent = {
      address: {
        parentSessionId: 'parent' as SessionId,
        childSessionId: SID,
        mode: 'continuable' as const,
      },
      parentAvailable: true,
    }
    const plain = bench({ running: true, busyEnter: 'steer', draft: 'plain', subagent })
    fireEvent.keyDown(plain.textarea, { key: 'Enter' })
    expect(plain.sink).toHaveBeenCalledWith('plain', [], 'queue')

    const accelerated = bench({ running: true, draft: 'accelerated', subagent })
    fireEvent.keyDown(accelerated.textarea, { key: 'Enter', metaKey: true })
    expect(accelerated.sink).toHaveBeenCalledWith('accelerated', [], 'queue')
  })

  it('disabled (session removed) locks the textarea and chrome', () => {
    const { textarea, view } = bench({ disabled: true })
    expect(textarea.disabled).toBe(true)
    expect(textarea.placeholder).toBe('会话不可用')
    expect((view.getByLabelText('命令') as HTMLButtonElement).disabled).toBe(true)
  })

  it('idle primary sends and disables on empty draft', () => {
    const { button, sink } = bench({ draft: 'go' })
    fireEvent.click(button)
    expect(sink).toHaveBeenCalledWith('go', [], 'queue')
    const empty = bench()
    expect(empty.button.disabled).toBe(true)
  })

  it('unlock refocuses the textarea; mousedown on the button keeps focus', () => {
    const first = bench({ disabled: true, draft: 'x' })
    act(() => { first.session.set(snapshotOf({ removed: false })) })
    const textarea = first.view.container.querySelector('textarea')!
    expect(document.activeElement).toBe(textarea)
    textarea.blur()
    fireEvent.mouseDown(first.view.container.querySelector('button[aria-label="发送消息"]')!)
    expect(document.activeElement).toBe(textarea)
  })

  it('typing forwards through the machine (draft state echoes back)', () => {
    const { textarea, wiring } = bench()
    fireEvent.change(textarea, { target: { value: 'typed' } })
    expect(wiring.state.getSnapshot().draft).toBe('typed')
    expect((textarea).value).toBe('typed')
  })

  it('wheel over a non-overflowing draft forwards to the conversation host', () => {
    const host = document.createElement('div')
    host.setAttribute('data-conversation-scroll', '')
    Object.defineProperty(host, 'scrollTop', { value: 40, writable: true, configurable: true })
    const { view, textarea } = bench()
    host.appendChild(view.container)
    document.body.appendChild(host)
    try {
      const wheeled = fireEvent.wheel(textarea, { deltaY: 30 })
      expect(wheeled).toBe(false) // preventDefault
      expect(host.scrollTop).toBe(70)
    } finally {
      host.remove()
    }
  })

  it('wheel chains: long drafts scroll inside the draft scrollport until each edge, then the host', () => {
    const host = document.createElement('div')
    host.setAttribute('data-conversation-scroll', '')
    Object.defineProperty(host, 'scrollTop', { value: 40, writable: true, configurable: true })
    const { view, textarea } = bench()
    host.appendChild(view.container)
    document.body.appendChild(host)
    const scrollport = view.container.querySelector<HTMLElement>('[data-input-scroll]')!
    Object.defineProperty(scrollport, 'clientHeight', { value: 100, configurable: true })
    Object.defineProperty(scrollport, 'scrollHeight', { value: 400, configurable: true })
    let scrollTop = 150
    Object.defineProperty(scrollport, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => { scrollTop = value },
    })
    try {
      // Mid-draft: both directions stay local — host must not move.
      expect(fireEvent.wheel(textarea, { deltaY: 30 })).toBe(true)
      expect(fireEvent.wheel(textarea, { deltaY: -30 })).toBe(true)
      expect(host.scrollTop).toBe(40)
      // At the bottom edge, further down-scroll forwards to the host.
      scrollTop = 300
      expect(fireEvent.wheel(textarea, { deltaY: 30 })).toBe(false)
      expect(host.scrollTop).toBe(70)
      // At the top edge, further up-scroll forwards to the host.
      scrollTop = 0
      host.scrollTop = 70
      expect(fireEvent.wheel(textarea, { deltaY: -20 })).toBe(false)
      expect(host.scrollTop).toBe(50)
    } finally {
      host.remove()
    }
  })

  it('the caret layer and the glyph layer ride one scrollport', () => {
    const { view, textarea } = bench({ draft: 'line\n'.repeat(40) })
    const scroll = view.container.querySelector<HTMLElement>('[data-input-scroll]')!
    const backdrop = view.container.querySelector<HTMLElement>('[data-input-backdrop]')!
    // The caret is the textarea's and every visible glyph is the backdrop's, so
    // one box has to carry both or an offset can exist in one and not the other.
    // jsdom has no layout and loads no stylesheet — which box scrolls is the
    // browser scenario's to assert; what is checkable here is that the
    // scrollport element holds both layers.
    expect(scroll.contains(textarea)).toBe(true)
    expect(scroll.contains(backdrop)).toBe(true)
    // The glyph layer carries the draft and nothing else — no height padding
    // to a second box's scroll extent.
    expect(backdrop.textContent).toBe('line\n'.repeat(40))
  })

  it('an edit the composer performs itself scrolls the caret back into view', async () => {
    // Paste and cut suppress the native edit, so no engine reveals the caret
    // for them. jsdom has no layout: the rects are stubbed,
    // and what is asserted is the arithmetic — minimal scroll, in both
    // directions, and nothing at all for a caret already inside the box.
    const { view, textarea } = bench({ draft: 'line\n'.repeat(40) })
    const scroll = view.container.querySelector<HTMLElement>('[data-input-scroll]')!
    const mirror = view.container.querySelector<HTMLElement>('[data-input-mirror]')!
    expect(mirror.firstChild).toBeInstanceOf(Text)
    scroll.getBoundingClientRect = () => ({ top: 100, bottom: 436 }) as DOMRect
    // jsdom reports scrollHeight === clientHeight for every element, which is
    // the composer's own "nothing to reveal" case; a scrollable box is what
    // puts the reveal on the table at all.
    Object.defineProperty(scroll, 'clientHeight', { value: 336, configurable: true })
    Object.defineProperty(scroll, 'scrollHeight', { value: 964, configurable: true })
    Object.defineProperty(scroll, 'scrollTop', { value: 0, writable: true, configurable: true })
    onTestFinished(() => {
      Range.prototype.getBoundingClientRect = ZERO_RECT
      Range.prototype.setStart = NATIVE_SET_START
    })
    // Which layer the caret is measured against, and at which index: the stub
    // records `setStart` so a helper that measured the backdrop instead, or
    // always collapsed at 0, fails here rather than only in the browser lane.
    let measured: { node: Node; offset: number } | null = null
    Range.prototype.setStart = function setStart(node: Node, offset: number): void {
      measured = { node, offset }
      NATIVE_SET_START.call(this, node, offset)
    }
    const caretAt = (top: number): void => {
      Range.prototype.getBoundingClientRect = () => ({ top, bottom: top + 24 }) as DOMRect
    }
    const settle = async (): Promise<void> => {
      await act(async () => { await new Promise((resolve) => { requestAnimationFrame(() => { resolve(null) }) }) })
    }
    // Pasted text lands below the fold: scroll down by exactly the overshoot.
    caretAt(500)
    fireEvent.paste(textarea, { clipboardData: { items: [], getData: () => 'pasted' } })
    await settle()
    expect(scroll.scrollTop).toBe(88) // 524 - 436
    // Measured on the mirror's own text, at the index the paste left the caret
    // (an empty draft's selection start, 0, plus the pasted length).
    expect(measured!.node).toBe(mirror.firstChild)
    expect(measured!.offset).toBe('pasted'.length)
    // A caret already inside the box does not move it.
    caretAt(200)
    fireEvent.paste(textarea, { clipboardData: { items: [], getData: () => 'more' } })
    await settle()
    expect(scroll.scrollTop).toBe(88)
    // Above the fold (a cut can leave it there): scroll back up.
    caretAt(60)
    fireEvent.paste(textarea, { clipboardData: { items: [], getData: () => 'again' } })
    await settle()
    expect(scroll.scrollTop).toBe(48) // 88 - (100 - 60)
    // A caret straight after a newline has nothing on its line to measure, so
    // the newline it just left is measured instead and one line is added.
    // chromium reports no client rects at all for the collapsed position.
    mirror.style.lineHeight = '24px'
    caretAt(500)
    fireEvent.paste(textarea, { clipboardData: { items: [], getData: () => 'block\n' } })
    await settle()
    // The four pastes accumulate at the draft's head, so the caret is at the
    // end of what they inserted — and the measured index is the newline before it.
    expect(measured!.offset).toBe('pastedmoreagainblock\n'.length - 1)
    expect(scroll.scrollTop).toBe(48 + 112) // from 48, by (524 + 24) - 436
  })

  it('a session switch refocuses without moving the transcript, and reveals the new draft caret', () => {
    // The composer DOM is reused across sessions, so the previous session's
    // offset survives while the value swap puts the caret at the new draft's
    // end. `preventScroll` keeps the browser from revealing it through the
    // conversation scrollport, which leaves the reveal to the effect itself.
    const { view, textarea, props } = bench({ draft: 'line\n'.repeat(40) })
    const scroll = view.container.querySelector<HTMLElement>('[data-input-scroll]')!
    const mirror = view.container.querySelector<HTMLElement>('[data-input-mirror]')!
    onTestFinished(() => { Range.prototype.getBoundingClientRect = ZERO_RECT })
    scroll.getBoundingClientRect = () => ({ top: 100, bottom: 436 }) as DOMRect
    Object.defineProperty(scroll, 'clientHeight', { value: 336, configurable: true })
    Object.defineProperty(scroll, 'scrollHeight', { value: 964, configurable: true })
    Object.defineProperty(scroll, 'scrollTop', { value: 0, writable: true, configurable: true })
    Range.prototype.getBoundingClientRect = () => ({ top: 500, bottom: 524 }) as DOMRect
    // The draft ends in a newline, so the reveal takes the after-newline path
    // and needs a resolvable line-height (jsdom computes `normal`).
    mirror.style.lineHeight = '24px'
    // Which index the effect reveals at, not merely that it scrolled: a
    // revealCaret(0) would land the same offset without this.
    onTestFinished(() => { Range.prototype.setStart = NATIVE_SET_START })
    let measured: { node: Node; offset: number } | null = null
    Range.prototype.setStart = function setStart(node: Node, offset: number): void {
      measured = { node, offset }
      NATIVE_SET_START.call(this, node, offset)
    }
    const focused: (boolean | undefined)[] = []
    textarea.focus = (options?: FocusOptions) => { focused.push(options?.preventScroll) }
    textarea.setSelectionRange(textarea.value.length, textarea.value.length)
    act(() => { view.rerender(<InputBar {...props} sessionId={'s2' as SessionId} />) })
    expect(focused).toEqual([true])
    expect(scroll.scrollTop).toBe(112) // (524 + 24) - 436
    // The draft ends in a newline, so the rule measures that newline: the
    // caret's own index is the mirror text's length minus its sentinel.
    expect(measured!.node).toBe(mirror.firstChild)
    expect(measured!.offset).toBe(textarea.value.length - 1)
  })

  it('a persisted draft adopted after mount gets its caret revealed too', () => {
    // ConversationSession seeds the stored draft in its own mount effect, which
    // runs after this component's: the first reveal measures an empty mirror,
    // so the draft's arrival has to run it again without reclaiming focus.
    const { view, textarea, shell } = bench()
    const scroll = view.container.querySelector<HTMLElement>('[data-input-scroll]')!
    const mirror = view.container.querySelector<HTMLElement>('[data-input-mirror]')!
    // The restored draft ends in a newline, so the reveal takes the
    // after-newline path and needs a resolvable line-height (jsdom says `normal`).
    mirror.style.lineHeight = '24px'
    onTestFinished(() => { Range.prototype.getBoundingClientRect = ZERO_RECT })
    scroll.getBoundingClientRect = () => ({ top: 100, bottom: 436 }) as DOMRect
    Object.defineProperty(scroll, 'clientHeight', { value: 336, configurable: true })
    Object.defineProperty(scroll, 'scrollHeight', { value: 964, configurable: true })
    Object.defineProperty(scroll, 'scrollTop', { value: 0, writable: true, configurable: true })
    Range.prototype.getBoundingClientRect = () => ({ top: 500, bottom: 524 }) as DOMRect
    const other = document.createElement('input')
    document.body.appendChild(other)
    onTestFinished(() => { other.remove() })
    other.focus()
    expect(scroll.scrollTop).toBe(0)
    act(() => { shell.setDraft('restored\n'.repeat(40)) })
    expect(document.activeElement).toBe(other)
    // The caret the machine left at the draft's end, revealed once the draft exists.
    expect(textarea.selectionStart).toBe(textarea.value.length)
    expect(scroll.scrollTop).toBe(112) // (524 + 24) - 436
  })

  it('disabled state shows the unavailable placeholder; custom placeholder wins', () => {
    const { textarea } = bench({ disabled: true })
    expect(textarea.placeholder).toBe('会话不可用')
    const live = bench()
    expect(live.textarea.placeholder).toBe('给智能体发消息')
    const custom = bench({ placeholder: 'Custom placeholder' })
    expect(custom.textarea.placeholder).toBe('Custom placeholder')
  })

  it('the inert textarea opens the Workspace picker by pointer or keyboard', () => {
    const onRequestWorkspace = vi.fn()
    const { view, textarea } = bench({
      inert: true,
      workspacePickerOpen: false,
      onRequestWorkspace,
      placeholder: '选择一个工作区开始',
    })
    expect(textarea.disabled).toBe(false)
    expect(textarea.readOnly).toBe(true)
    expect(textarea.getAttribute('aria-haspopup')).toBe('menu')
    expect(textarea.getAttribute('aria-expanded')).toBe('false')
    expect((view.getByLabelText('命令') as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(textarea)
    fireEvent.keyDown(textarea, { key: 'Enter' })
    fireEvent.keyDown(textarea, { key: ' ' })
    expect(onRequestWorkspace).toHaveBeenCalledTimes(3)

    // The WHOLE capsule is the pick target, and its pointerdown never reaches
    // the document — the open picker's outside-close must not race the reopen.
    const card = view.container.querySelector('[data-composer-card]') as HTMLElement
    fireEvent.click(card)
    expect(onRequestWorkspace).toHaveBeenCalledTimes(4)
    const onDocumentPointerDown = vi.fn()
    document.addEventListener('pointerdown', onDocumentPointerDown)
    try {
      fireEvent.pointerDown(card)
    } finally {
      document.removeEventListener('pointerdown', onDocumentPointerDown)
    }
    expect(onDocumentPointerDown).not.toHaveBeenCalled()
  })

  it('the plan projection swaps the placeholder while its effective target is plan mode', () => {
    const active = bench({ plan: { active: true, pending: false } })
    expect(active.textarea.placeholder).toBe('描述你的任务以生成计划')
    // /plan just ran: pending entry already reads as the plan target.
    const entering = bench({ plan: { active: false, pending: true } })
    expect(entering.textarea.placeholder).toBe('描述你的任务以生成计划')
    // Pending exit: target is default again.
    const leaving = bench({ plan: { active: true, pending: true } })
    expect(leaving.textarea.placeholder).toBe('给智能体发消息')
    // Owner placeholder outranks the plan swap.
    const custom = bench({ plan: { active: true, pending: false }, placeholder: 'Custom placeholder' })
    expect(custom.textarea.placeholder).toBe('Custom placeholder')
  })
})

describe('machine pending lock', () => {
  it('submitting renders read-only textarea, pending dot, and a disabled primary', () => {
    const { view, shell } = bench()
    // Drive the machine into submitting through a claim + enter.
    act(() => {
      shell.setDraft('/goal ')
      shell.beginCommand(
        {
          token: '/goal ',
          submit: () => new Promise<never>(() => {}), // never settles: stays submitting
        },
        { start: 0, end: 6, draftRev: shell.snapshot.draftRev },
      )
      shell.submit()
    })
    expect(shell.snapshot.phase).toBe('submitting')
    const textarea = view.container.querySelector('textarea')!
    expect(textarea.readOnly).toBe(true)
    expect(view.container.querySelector<HTMLButtonElement>('button[aria-label="发送消息"]')!.disabled).toBe(true)
  })
})

describe('decorations', () => {
  it('claimed token renders the mirror highlight and the blank-args hint', () => {
    // Dictionary-less stub: an unmatched hint key keeps the machine's raw hint.
    const { view, shell } = bench({ t: makeTranslate({}) })
    act(() => {
      shell.setDraft('/goal ')
      shell.beginCommand(
        { token: '/goal ', hint: '目标内容', submit: () => Promise.resolve({ kind: 'success' as const }) },
        { start: 0, end: 6, draftRev: shell.snapshot.draftRev },
      )
    })
    const token = view.container.querySelector('[data-decoration="token"]')
    expect(token?.textContent).toBe('/goal ')
    expect(view.container.querySelector('[data-decoration="hint"]')?.textContent).toBe('目标内容')
    // Args typed: the hint disappears, the token highlight stays.
    act(() => { shell.setDraft('/goal 发布') })
    expect(view.container.querySelector('[data-decoration="hint"]')).toBeNull()
    expect(view.container.querySelector('[data-decoration="token"]')).not.toBeNull()
  })

  it('a locale entry for the claimed command overrides the raw claim hint (trailing-space token)', () => {
    const { view, shell } = bench()
    act(() => {
      shell.setDraft('/goal ')
      shell.beginCommand(
        { token: '/goal ', hint: '[<objective>|clear|edit <objective>|pause|resume]', submit: () => Promise.resolve({ kind: 'success' as const }) },
        { start: 0, end: 6, draftRev: shell.snapshot.draftRev },
      )
    })
    expect(view.container.querySelector('[data-decoration="hint"]')?.textContent).toBe('输入目标，智能体将持续执行')
  })

  it('an inserted reference renders as a chip at its placeholder offset', () => {
    const { view, shell } = bench()
    act(() => {
      shell.setDraft('参考 @w1 内容')
      shell.insertReference(
        { source: 'subagent', ref: 'w1', label: '@w1', clipboardText: '@w1' },
        { start: 3, end: 6, draftRev: shell.snapshot.draftRev },
      )
    })
    const chip = view.container.querySelector('[data-decoration="chip"]')
    expect(chip?.textContent).toBe('@w1')
    expect(shell.snapshot.occurrences).toHaveLength(1)
    // The draft carries exactly one placeholder char where the token was.
    expect(shell.snapshot.draft).toBe('参考 \uFFFC 内容')
  })

  it('a lexicon-matched plain token renders the text-ref mark', () => {
    const lexicon = new Map<'/' | '@', readonly string[]>([['/', ['fixture-demo']]])
    const { view, shell } = bench({ lexicon })
    act(() => { shell.setDraft('use /fixture-demo now') })
    const mark = view.container.querySelector('[data-decoration="text-ref"]')
    expect(mark?.textContent).toBe('/fixture-demo')
    // Editing the token out of match shape drops the decoration.
    act(() => { shell.setDraft('use /fixture-dem now') })
    expect(view.container.querySelector('[data-decoration="text-ref"]')).toBeNull()
  })
})

describe('insertText (scoped event body)', () => {
  it('splices plain text over the span and reports success as true', () => {
    const { shell } = bench({ draft: '/fix' })
    const ok = shell.insertText('/fixture-demo ', { start: 0, end: 4, draftRev: shell.snapshot.draftRev })
    expect(ok).toBe(true)
    expect(shell.snapshot.draft).toBe('/fixture-demo ')
    expect(shell.snapshot.occurrences).toEqual([])
  })

  it('a stale draftRev refuses whole: false, draft untouched', () => {
    const { shell } = bench({ draft: '/fix' })
    const span = { start: 0, end: 4, draftRev: shell.snapshot.draftRev }
    act(() => { shell.setDraft('/fixX') })
    expect(shell.insertText('/fixture-demo ', span)).toBe(false)
    expect(shell.snapshot.draft).toBe('/fixX')
  })
})

describe('strips and variants', () => {
  it('announces promptError as a fading toast (ordinary failure — no transaction UI, no Retry)', () => {
    vi.useFakeTimers()
    try {
      const send = bench({ promptError: { op: 'send', error: { code: 'agent-busy', message: 'boom', details: { reason: 'boom' } } } })
      // The toast body-portals (transformed ancestors must not trap it), so
      // queries go through the view's document-bound helpers.
      expect(send.view.getByRole('alert').textContent).toContain('boom (agent-busy)')
      expect(send.view.queryByRole('button', { name: 'Retry' })).toBeNull()
      act(() => { vi.advanceTimersByTime(4000) })
      expect(send.view.queryByRole('alert')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('renders the notice strip from the machine notice store', () => {
    const { view, shell } = bench()
    act(() => { shell.notify('error', '命令失败了') })
    expect(view.getByText('命令失败了')).toBeTruthy()
  })

  it('auto-dismisses the notice strip after the hold and clears the store', () => {
    vi.useFakeTimers()
    onTestFinished(() => { vi.useRealTimers() })
    const { view, shell } = bench()
    act(() => { shell.notify('error', '命令失败了') })
    expect(shell.notices.getSnapshot()).not.toBeNull()
    expect(view.getByText('命令失败了')).toBeTruthy()
    act(() => { vi.advanceTimersByTime(6000) })
    expect(shell.notices.getSnapshot()).toBeNull()
    expect(view.queryByText('命令失败了')).toBeNull()
  })

  it('keeps the notice strip when the feedback patch is disabled (official persistent strip)', () => {
    vi.useFakeTimers()
    onTestFinished(() => { vi.useRealTimers() })
    const spy = vi.spyOn(forkFlags, 'feedbackPatchEnabled').mockReturnValue(false)
    try {
      const { view, shell } = bench()
      act(() => { shell.notify('error', '命令失败了') })
      act(() => { vi.advanceTimersByTime(6000) })
      expect(shell.notices.getSnapshot()).not.toBeNull()
      expect(view.getByText('命令失败了')).toBeTruthy()
    } finally {
      spy.mockRestore()
    }
  })

  it('hero variant adds the hero class and accessory row renders', () => {
    const { view } = bench({ variant: 'hero', accessory: <i data-testid="acc" /> })
    expect(view.getByTestId('acc')).toBeTruthy()
    expect(view.container.querySelector('[class*="hero"]')).not.toBeNull()
  })

  it('renders overlay anchor and left/right slot items', () => {
    const { view } = bench({
      overlay: <i data-testid="ov" />,
      leftItems: <i data-testid="li" />,
      rightItems: <i data-testid="ri" />,
    })
    expect(view.getByTestId('ov')).toBeTruthy()
    expect(view.getByTestId('li')).toBeTruthy()
    expect(view.getByTestId('ri')).toBeTruthy()
  })
})

describe('command launcher chrome and control seats', () => {
  it('renders the command launcher; the Access chip is absent without the permissions projection; the control seats render EMPTY without entries', () => {
    const { view, slotCalls } = bench()
    expect(view.getByLabelText('命令')).toBeTruthy()
    // Capability absent (no projection value): the chip renders nothing.
    expect(view.queryByLabelText(/^访问模式/)).toBeNull()
    // Every seat dispatched, nothing rendered.
    expect(slotCalls.map(c => c.key)).toEqual([
      'conversation.input.plan', 'conversation.input.model',
    ])
    expect(view.queryByLabelText('Plan mode')).toBeNull()
    expect(view.queryByLabelText('Model')).toBeNull()
  })

  it('passes the textarea selection to the command menu launcher and reflects its expanded state', () => {
    const toggleCommandMenu = vi.fn()
    const { view, textarea, menuLauncher } = bench({ draft: 'draft text', toggleCommandMenu })
    textarea.setSelectionRange(2, 7)
    const launcher = view.getByLabelText('命令')
    expect(launcher.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(launcher)
    expect(toggleCommandMenu).toHaveBeenCalledExactlyOnceWith({ start: 2, end: 7 })
    act(() => { menuLauncher.set('command') })
    expect(launcher.getAttribute('aria-expanded')).toBe('true')
  })

  it('the Access chip renders the projection value and submits a non-Full-access pick directly', async () => {
    const command = vi.fn(() => Promise.resolve(true))
    const permissions = {
      options: [
        { value: 'read-only', name: 'read-only' },
        { value: 'workspace-write', name: 'workspace-write' },
        { value: 'danger-full-access', name: 'danger-full-access' },
      ],
      currentValue: 'read-only',
    }
    const { view } = bench({ permissions, command })
    const trigger = view.getByLabelText(/^访问模式/) as HTMLButtonElement
    // Title-case display is presentation only; the menu ids stay machine names.
    expect(trigger.textContent).toBe('Read Only')
    expect([...trigger.querySelectorAll('svg')]
      .every(icon => icon.closest('[aria-hidden="true"]') !== null)).toBe(true)
    fireEvent.click(trigger)
    const items = view.getAllByRole('menuitem')
    expect(items.map(o => o.textContent)).toEqual(['Read Only', 'Workspace Write', 'Full access'])
    fireEvent.click(items[1]!)
    // Optimistic pick + disable until admission resolves (command stub resolves true).
    const busy = view.getByLabelText(/^访问模式/) as HTMLButtonElement
    expect(busy.textContent).toBe('Workspace Write')
    expect(busy.disabled).toBe(true)
    expect(command).toHaveBeenCalledWith('/permission workspace-write')
    await act(async () => {})
    expect((view.getByLabelText(/^访问模式/) as HTMLButtonElement).disabled).toBe(false)
  })

  it('requires explicit risk acknowledgement before submitting Full access', async () => {
    const command = vi.fn(() => Promise.resolve(true))
    const permissions = {
      options: [
        { value: 'workspace-write', name: 'workspace-write' },
        { value: 'danger-full-access', name: 'danger-full-access' },
      ],
      currentValue: 'workspace-write',
    }
    const { view } = bench({ permissions, command })
    fireEvent.click(view.getByLabelText(/^访问模式/))
    fireEvent.click(view.getByRole('menuitem', { name: 'Full access' }))

    expect(command).not.toHaveBeenCalled()
    expect(view.getByRole('dialog', { name: '确认启用 Full access？' })).toBeTruthy()
    const enable = view.getByRole('button', { name: '启用 Full access' }) as HTMLButtonElement
    expect(enable.disabled).toBe(true)

    fireEvent.click(view.getByRole('checkbox', { name: '我已了解风险，并愿意继续' }))
    expect(enable.disabled).toBe(false)
    fireEvent.click(enable)

    expect(command).toHaveBeenCalledOnce()
    expect(command).toHaveBeenCalledWith('/permission danger-full-access')
    expect(view.queryByRole('dialog')).toBeNull()
    expect((view.getByLabelText(/^访问模式/) as HTMLButtonElement).textContent).toBe('Full access')
    await act(async () => {})
  })

  it('cancels a Full access selection without changing permission and resets acknowledgement', () => {
    const command = vi.fn(() => Promise.resolve(true))
    const permissions = {
      options: [
        { value: 'workspace-write', name: 'workspace-write' },
        { value: 'danger-full-access', name: 'danger-full-access' },
      ],
      currentValue: 'workspace-write',
    }
    const { view } = bench({ permissions, command })
    const openConfirmation = () => {
      fireEvent.click(view.getByLabelText(/^访问模式/))
      fireEvent.click(view.getByRole('menuitem', { name: 'Full access' }))
    }

    openConfirmation()
    fireEvent.click(view.getByRole('checkbox'))
    fireEvent.click(view.getByRole('button', { name: '取消' }))
    expect(command).not.toHaveBeenCalled()
    expect((view.getByLabelText(/^访问模式/) as HTMLButtonElement).textContent).toBe('Workspace Write')

    openConfirmation()
    expect((view.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
    expect((view.getByRole('button', { name: '启用 Full access' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('revokes an open Full access confirmation when the task locks', () => {
    const command = vi.fn(() => Promise.resolve(true))
    const permissions = {
      options: [
        { value: 'workspace-write', name: 'workspace-write' },
        { value: 'danger-full-access', name: 'danger-full-access' },
      ],
      currentValue: 'workspace-write',
    }
    const { view, session } = bench({ permissions, command })
    fireEvent.click(view.getByLabelText(/^访问模式/))
    fireEvent.click(view.getByRole('menuitem', { name: 'Full access' }))
    fireEvent.click(view.getByRole('checkbox'))
    act(() => { session.set(snapshotOf({ removed: true })) })
    expect(view.queryByRole('dialog')).toBeNull()
    expect(command).not.toHaveBeenCalled()
  })

  it('resets an open Full access confirmation when switching tasks', () => {
    const command = vi.fn(() => Promise.resolve(true))
    const permissions = {
      options: [
        { value: 'workspace-write', name: 'workspace-write' },
        { value: 'danger-full-access', name: 'danger-full-access' },
      ],
      currentValue: 'workspace-write',
    }
    const { view, props } = bench({ permissions, command })
    fireEvent.click(view.getByLabelText(/^访问模式/))
    fireEvent.click(view.getByRole('menuitem', { name: 'Full access' }))
    fireEvent.click(view.getByRole('checkbox'))
    view.rerender(<InputBar {...props} sessionId={'s2' as SessionId} />)
    expect(view.queryByRole('dialog')).toBeNull()
    expect(command).not.toHaveBeenCalled()
  })

  it('a registered entry fills its seat and receives the locked owner prop', () => {
    const { view, slotCalls } = bench({
      disabled: true,
      planEntry: <i data-testid="plan-entry" />,
      modelEntry: <i data-testid="model-entry" />,
    })
    expect(view.getByTestId('plan-entry')).toBeTruthy()
    expect(view.getByTestId('model-entry')).toBeTruthy()
    // The bar hands its chrome disable state to the filling entry.
    expect(slotCalls.every(c => (c.owner as { locked: boolean }).locked)).toBe(true)
    cleanup()
    const live = bench({ running: true })
    expect(live.slotCalls.every(c => !(c.owner as { locked: boolean }).locked)).toBe(true)
  })

  it('disabled locks the Access chip and command launcher (running does not)', () => {
    const permissions = { options: [{ value: 'workspace-write', name: 'workspace-write' }], currentValue: 'workspace-write' }
    const { view } = bench({ disabled: true, permissions })
    expect((view.getByLabelText('命令') as HTMLButtonElement).disabled).toBe(true)
    expect((view.getByLabelText(/^访问模式/) as HTMLButtonElement).disabled).toBe(true)
    cleanup()
    const live = bench({ running: true, permissions })
    expect((live.view.getByLabelText(/^访问模式/) as HTMLButtonElement).disabled).toBe(false)
  })
})
