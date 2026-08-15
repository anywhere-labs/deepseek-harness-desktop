/** The default composer body: the 'conversation.composer.bar' slot entry.
 * Machine state arrives through the standard provide channel
 * (useInput + inputActions); the keyboard/DOM command face and stop arrive
 * through this entry's own inject, whose hooks compartment binds
 * useNotices/useLexicon; layout-phase inputs (variant, placeholder,
 * region-slot content) ride the owner props. Session facts
 * (running/removed/promptError) are self-selected via useSession. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, KeyboardEvent, MouseEvent, ReactNode } from 'react'
import clsx from 'clsx'
import {
  IconPlusOutline16, IconWarningOutline16, Toast, Tooltip, textDirection,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { AttachmentRail, DropOverlay, ImageLightbox } from '@deepseek-ai/dsh-client-ui-attachment'
import type { AttachmentRailItem } from '@deepseek-ai/dsh-client-ui-attachment'
// Type-only: the `plan` projection key merge (the TodoDock posture — the
// composer reads a host-computed value; the domain owns the key).
import type {} from '@deepseek-ai/dsh-plan-mode/client'
// Type-only: the `goal` projection key merge (hint disambiguation).
import type {} from '@deepseek-ai/dsh-goal/client'
// The `imageLimits` projection key merge (intake pre-check) arrives with the
// wire types: apiproxy's sessions contract declares it, and client-runtime's
// api-remotes import already places it in every client program.
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { ComposerAttachment, ComposerBarProps } from '../contract/slots.ts'
import { deriveDecorations } from '../input/decorations.ts'
import type { DraftDecorations } from '../input/decorations.ts'
import {
  attachmentErrorText, attachmentRailLabels, dropOverlayLabels, imageSizeText, lightboxLabels,
} from '../image-labels.ts'
import { ContextMeter } from './ContextMeter.tsx'
import { PermissionSelect } from './PermissionSelect.tsx'
import css from './InputBar.module.css'

/** Decoration product of the no-session state (no machine, empty draft). */
const INERT_DECORATIONS: DraftDecorations = { token: null, chips: [], textRefs: [], hint: null }

/** Rail thumbnail carrying its source attachment for the open/remove callbacks. */
interface ComposerRailItem extends AttachmentRailItem {
  attachment: ComposerAttachment
}

export type InputBarProps = ComposerBarProps

export function InputBar({
  useSession, useInput, inputActions, keyboard, addImages, removeImage, draftImages,
  resolveSubmitMode, toggleCommandMenu, stop, command, t,
  renderSlot, useNotices, useLexicon, useMenuLauncher,
  useProjection, sessionId, variant, disabled: inert = false, blocked,
  workspacePickerOpen = false, onRequestWorkspace,
  placeholder, accessory, overlay, leftItems, rightItems, footer,
}: InputBarProps) {
  const input = useInput(s => s)
  const notice = useNotices(s => s)
  const lexicon = useLexicon(s => s)
  const commandMenuOpen = useMenuLauncher(source => source === 'command')
  const promptError = useSession(s => s.promptError) ?? null
  const running = useSession(s => s.running) ?? false
  const subagent = useSession(s => s.subagent) ?? null
  const removed = useSession(s => s.removed) ?? false
  // Plan mode swaps the textarea placeholder (the projection is the folded
  // host value; owner-prop placeholders — hero, session-unavailable — win).
  const planActive = useProjection('plan', plan => plan !== undefined && (plan.pending ? !plan.active : plan.active))
  // Absent (undefined: no frame yet) and cleared (null) both mean no goal.
  const hasGoal = useProjection('goal', goal => goal != null)
  // Session-maybe: the machine faces are absent together while no session is
  // current; the bar renders the same DOM inert instead of a parallel tree.
  const live = input !== undefined && keyboard !== undefined && inputActions !== undefined
  const draft = input?.draft ?? ''
  const attachments = useMemo(
    () => input === undefined || draftImages === undefined ? [] : draftImages(input.imageIds),
    [draftImages, input?.imageIds],
  )
  const empty = draft.trim() === '' && attachments.length === 0
  const [preview, setPreview] = useState<ComposerAttachment | null>(null)
  const [dragActive, setDragActive] = useState(false)
  // Transient error banner (image-intake rejections and prompt failures): the
  // seq keys the Toast so an identical repeated message restarts the
  // hold-then-fade cycle instead of silently reusing the faded one.
  const [toast, setToast] = useState<{ seq: number; text: string } | null>(null)
  const toastSeq = useRef(0)
  const showToast = useCallback((text: string) => {
    toastSeq.current += 1
    setToast({ seq: toastSeq.current, text })
  }, [])
  const dismissToast = useCallback(() => { setToast(null) }, [])
  // The deployment's image-intake limits (absent while no attachment service
  // is composed — the pre-check below then defers entirely to the host).
  const imageLimits = useProjection('imageLimits')
  // Prompt failures are ordinary failures (no create/attach transaction exists
  // anymore): the toast announces promptError, the draft stays in the machine,
  // and the user resubmits. A remount over a session whose machine still holds
  // an unresolved promptError deliberately re-announces it once — the failure
  // is still pending, and a transient banner is its only surface. Attachment
  // rejections show product copy keyed by the wire reason; other codes are
  // developer-facing and keep the raw message plus code.
  useEffect(() => {
    if (promptError === null) return
    showToast(promptError.error.code === 'attachment-error'
      ? attachmentErrorText(t, promptError.error.details.reason, imageLimits)
      : `${promptError.error.message} (${promptError.error.code})`)
  }, [promptError, showToast, t, imageLimits])
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const dragDepthRef = useRef(0)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const mirrorRef = useRef<HTMLDivElement | null>(null)
  // IME guard: composition Enter picks a candidate, it must not send. The ref outlives renders;
  // clearing is deferred one tick because Safari delivers the closing keydown AFTER compositionend.
  const composingRef = useRef(false)
  const onCompositionStart = (): void => {
    composingRef.current = true
  }
  const onCompositionEnd = (): void => {
    setTimeout(() => {
      composingRef.current = false
    }, 10)
  }

  // The Access seat's data: the host-computed permissions projection
  // (undefined = capability absent → the chip renders nothing).
  const permissions = useProjection('permissions')

  // A continuable child without its live parent cannot accept human input,
  // but its independent Stop below stays available while it runs.
  const continuable = subagent?.address.mode === 'continuable'
  const parentOffline = continuable && !subagent.parentAvailable
  // Running input stays free; locked = session removed, the
  // inert no-workspace state, the machine faces absent (no session), or a
  // parent-offline continuable child. An owner block also disables input;
  // adjudicating and submitting render read-only so the draft stays visible.
  const disabled = removed || inert || !live || blocked !== undefined || parentOffline
  const locked = disabled
  // The model seat is the ONE control a block leaves live: every block this
  // contract has is cleared by choosing a model, so locking it too would leave
  // the composer asking for the only thing it prevents. The other reasons to
  // be disabled do lock it — there is no session to choose a model for.
  const modelSeatLocked = removed || inert || !live
  const machineBusy = input?.phase === 'adjudicating' || input?.phase === 'submitting'
  // The no-workspace textarea remains the resident DOM node but acts as the
  // existing picker trigger. Message controls stay locked until a Session
  // exists; the trigger itself is read-only rather than disabled so pointer
  // and keyboard users can reach the recovery action.
  const workspaceTrigger = inert && !removed && onRequestWorkspace !== undefined
  const textareaDisabled = removed || (locked && !workspaceTrigger)
  const canSteerQueue = !locked && !machineBusy && !commandMenuOpen && empty && running && subagent === null
    && input.queue.some(row => row.placement === 'queued')

  useEffect(() => {
    if (input === undefined || inputActions === undefined) return
    if (attachments.length !== input.imageIds.length) {
      inputActions.pruneImages(attachments.map(attachment => attachment.id))
    }
  }, [attachments, input?.imageIds, inputActions])

  useEffect(() => {
    if (preview !== null && !attachments.some(attachment => attachment.id === preview.id)) setPreview(null)
  }, [attachments, preview])

  // Scroll the draft scrollport the minimum that brings `caret` into view — the
  // browser's own behavior for typing, performed for the paths where it does
  // not act.
  //
  // The mirror is the caret's ruler: it renders the same draft at the same
  // metrics and the same wrap width in the same stack (that is what makes it
  // the height authority), so a Range collapsed at the caret's index reports
  // where the caret is without a caret API.
  const revealCaret = (caret: number): void => {
    const scrollEl = scrollRef.current
    const mirrorEl = mirrorRef.current
    const text = mirrorEl?.firstChild
    if (scrollEl === null || mirrorEl === null || !(text instanceof Text)) return
    // A box that cannot scroll has nothing to reveal: the draft fits, so every
    // caret is already in view and the assignment below would clamp to itself.
    if (scrollEl.scrollHeight <= scrollEl.clientHeight) return
    const at = Math.min(caret, text.data.length)
    // A caret straight after a newline sits on a line with nothing on it to
    // measure — the shape a trailing-newline draft ends in — and the engines
    // disagree there: chromium returns NO client rects at all (an all-zero box,
    // which would scroll the wrong way), firefox reports the line above, WebKit
    // the right one. Measure the newline itself instead, which is the line the
    // caret just left, and step one line down; that they all agree on.
    const afterNewline = at > 0 && text.data[at - 1] === '\n'
    const range = document.createRange()
    range.setStart(text, afterNewline ? at - 1 : at)
    if (afterNewline) range.setEnd(text, at)
    else range.collapse(true)
    const line = afterNewline ? Number.parseFloat(getComputedStyle(mirrorEl).lineHeight) : 0
    const rect = range.getBoundingClientRect()
    const box = scrollEl.getBoundingClientRect()
    if (rect.bottom + line > box.bottom) scrollEl.scrollTop += rect.bottom + line - box.bottom
    else if (rect.top + line < box.top) scrollEl.scrollTop -= box.top - rect.top - line
  }

  // Reveal the focus end of the current selection. Today's entry paths leave a
  // collapsed selection, but honoring direction keeps a future range-preserving
  // path from revealing its anchor instead of its focus.
  const revealSelectionFocus = (el: HTMLTextAreaElement): void => {
    // selectionStart/End are number|null in lib.dom; the type-aware lint program narrows them.
    const caret = el.selectionDirection === 'backward' ? el.selectionStart : el.selectionEnd
    // oxlint-disable-next-line typescript/no-unnecessary-condition
    revealCaret(caret ?? el.value.length)
  }

  // Unlock (mount / session switch) returns focus to the box, and owns the
  // reveal that comes with it. `preventScroll` because this focus is ours, not
  // a gesture: the textarea is as tall as the draft, so the browser's reveal
  // would walk up to the conversation scrollport and move the transcript under
  // a user who only switched session. That leaves the caret to us — the DOM is
  // reused across sessions, so switching to a longer draft keeps the previous
  // offset while the value swap puts the caret at the new draft's end, which is
  // off screen (measured on all three engines: offset 0 with the caret 940px
  // down). Suppress the walk, then reveal in our own box.
  useEffect(() => {
    const el = inputRef.current
    if (locked || el === null) return
    el.focus({ preventScroll: true })
    revealSelectionFocus(el)
  }, [locked, sessionId])

  // A persisted draft arrives AFTER the unlock effect: ConversationSession
  // adopts it in its own mount effect, and a parent's mount effect runs after
  // its children's. Reveal when the draft becomes non-empty so a restored long
  // draft does not stay at its head with the caret at its end. This effect does
  // not focus: send-clear, failed-send restore, and first-character transitions
  // must not steal focus from another control the user moved to.
  useEffect(() => {
    const el = inputRef.current
    if (locked || draft === '' || el === null) return
    revealSelectionFocus(el)
  }, [draft !== ''])

  // Caret restore after an edit the composer performs itself. The machine owns
  // the draft and the undo log, so paste and cut suppress the native edit and
  // write the value through the machine — and a
  // programmatic selection change reveals nothing: measured in chromium and
  // WebKit, pasting a long block leaves the view where it was while the caret
  // sits at the end of the draft. Native typing gets its reveal from the
  // browser; these two have to ask for it, so they share one restore.
  const restoreCaret = (el: HTMLTextAreaElement, caret: number): void => {
    requestAnimationFrame(() => {
      el.setSelectionRange(caret, caret)
      revealCaret(caret)
    })
  }

  // Wheel chaining on the draft scrollport, one lifetime (it is never
  // unmounted — the inert state renders the same element disabled). While the
  // capped box can still move in this direction, keep the native scroll; only
  // at its own edge forward the delta to the active conversation scrollport, so
  // a short draft never traps the gesture and a long draft stays scrollable.
  // Hero mounts have no host and keep native wheel scrolling.
  useEffect(() => {
    const el = scrollRef.current
    if (el === null) return
    const onWheel = (e: WheelEvent): void => {
      const host = el.closest('[data-conversation-scroll]')
      if (!(host instanceof HTMLElement) || e.deltaY === 0) return
      const atTop = el.scrollTop <= 0
      const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 1
      if ((e.deltaY < 0 && !atTop) || (e.deltaY > 0 && !atEnd)) return
      e.preventDefault()
      host.scrollTop += e.deltaY
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => { el.removeEventListener('wheel', onWheel) }
  }, [])

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (workspaceTrigger) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onRequestWorkspace()
      }
      return
    }
    // Absent machine without a Workspace recovery action stays disabled; the
    // guard narrows the faces for the paths below.
    if (keyboard === undefined || inputActions === undefined) return
    // Shift+Enter is the native newline UNCONDITIONALLY — decided before the
    // IME guard so a composition-closing Shift+Enter still breaks the line.
    if (e.key === 'Enter' && e.shiftKey) return
    // keyCode 229 is the legacy IME-composition signal engines emit without isComposing.
    // oxlint-disable-next-line typescript/no-deprecated
    const composing = composingRef.current || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      if (keyboard.arbitrate(e.key === 'ArrowUp' ? 'up' : 'down', composing) === 'consumed') e.preventDefault()
      return
    }
    if (e.key === 'Escape') {
      // Escape layering: an open overlay closes; claimed without an overlay
      // does NOT release (backspacing the token is the only exit gesture).
      keyboard.dismissPopup()
      if (keyboard.arbitrate('escape', composing) === 'consumed') e.preventDefault()
      return
    }
    if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z' || e.key === 'y')) {
      // The machine owns the undo/redo log (chip transactions have semantics
      // the browser stack cannot represent); never let the native stack run.
      e.preventDefault()
      if (machineBusy || locked) return
      const redo = e.key === 'y' || e.shiftKey
      if (redo) keyboard.redo()
      else keyboard.undo()
      return
    }
    if (e.key === ' ') {
      if (composing) return
      if (keyboard.space()) e.preventDefault() // claim token already carries the trailing separator
      return
    }
    if (e.key !== 'Enter') return
    if (composing) return
    // Menu-open Enter picks the highlight through arbitration; a no-highlight
    // menu passes down to the machine's own adjudication.
    const arbitrated = keyboard.arbitrate('enter', composing)
    if (arbitrated !== 'pass') {
      e.preventDefault()
      return
    }
    e.preventDefault()
    if (e.repeat) return // held-down Enter must not machine-gun sends
    if (locked || machineBusy) return
    const accelerated = e.ctrlKey || e.metaKey
    // Empty-draft accelerated Enter acts on the queue instead of the (empty)
    // draft: the machine rejects empty drafts, so the gesture steers every
    // still-pending queued message into the running turn (the dock's per-row
    // steer button applied to the whole queue). Steering needs the same
    // window as the per-row button: a running ordinary session.
    if (accelerated && canSteerQueue) {
      keyboard.steerQueue()
      return
    }
    keyboard.submit(resolveSubmitMode(
      running,
      accelerated ? 'accelerated' : 'enter',
      subagent === null,
    ))
  }

  const onChange = (e: ChangeEvent<HTMLTextAreaElement>): void => {
    if (keyboard === undefined || locked) return // disabled/read-only states cannot edit the draft
    if (machineBusy) return // submitting is the read-only span; adjudicating holds the pending lock
    const next = e.target.value
    keyboard.setDraft(next)
    // selectionStart is number|null in lib.dom; the type-aware lint program narrows it.
    // oxlint-disable-next-line typescript/no-unnecessary-condition
    keyboard.track(next, e.target.selectionStart ?? next.length)
  }

  // ---- chip atomicity (DOM layer; the machine sees only transactions) ----
  // Placeholders occupy exactly one char, so caret positions are always
  // BETWEEN them — what needs normalizing is deletion (whole chip per
  // Backspace/Delete via native single-char semantics, which U+FFFC already
  // gives us) and selection endpoints: Shift-extension snapping is native
  // too (one char = one step). Mouse selection of a chip is handled in the
  // backdrop click handler below. Undo/redo must NOT reach the browser: the
  // machine owns the transaction log.
  // selectionStart/End are number|null in lib.dom; the type-aware lint program narrows them.
  /* oxlint-disable typescript/no-unnecessary-condition */
  const selectionOf = (el: HTMLTextAreaElement) => ({
    start: el.selectionStart ?? 0,
    end: el.selectionEnd ?? el.selectionStart ?? 0,
  })
  /* oxlint-enable typescript/no-unnecessary-condition */

  const onCopyOrCut = (e: React.ClipboardEvent<HTMLTextAreaElement>, cut: boolean): void => {
    if (input === undefined || keyboard === undefined) return // absent machine: no draft can be copied or cut
    const el = e.currentTarget
    const { start, end } = selectionOf(el)
    if (start === end) return
    const slice = draft.slice(start, end)
    const touched = input.occurrences.filter(o => o.offset >= start && o.offset < end)
    if (touched.length === 0 && !cut) return // plain copy of plain text: native path is fine
    e.preventDefault()
    // Expand placeholders to their owner clipboard projections.
    let text = ''
    let cursor = start
    for (const o of touched) {
      text += draft.slice(cursor, o.offset) + o.clipboardText
      cursor = o.offset + 1
    }
    text += draft.slice(cursor, end)
    e.clipboardData.setData('text/plain', text)
    if (cut && !machineBusy && !locked) {
      keyboard.setDraft(draft.slice(0, start) + draft.slice(end), { start, end, insertedLength: 0 })
      restoreCaret(el, start)
    }
    void slice
  }

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    if (keyboard === undefined) return // absent machine: no draft can accept a paste
    if (machineBusy || locked) return
    const files = Array.from(e.clipboardData.items)
      .filter(item => item.kind === 'file')
      .map(item => item.getAsFile())
      .filter((file): file is File => file !== null)
    if (files.length > 0) intakeImages(files)
    const text = e.clipboardData.getData('text/plain')
    if (text === '') {
      if (files.length > 0) e.preventDefault()
      return
    }
    e.preventDefault()
    const el = e.currentTarget
    const sel = selectionOf(el)
    // Sync components stay empty at this layer: hot-snapshot matching needs
    // the Slash roster, which lives behind keyboard.track — the paste attempt
    // opens in the machine and the controller upgrades tokens as matches
    // land (paste-upgrade). The DOM layer only starts the transaction.
    keyboard.pasteBegin(text, sel)
    const caret = sel.start + text.length
    restoreCaret(el, caret)
    keyboard.track(keyboard.snapshot.draft, caret)
  }

  // Intake pre-check (DeepSeek Chat semantics): an addition that would break
  // a projected limit is refused as a whole batch, announced immediately, and
  // never enters the rail — no more submit-time failure rolling the rail
  // back. The host enforces the same limits at submit for callers that bypass
  // this composer.
  const intakeImages = useCallback((files: readonly File[]): void => {
    if (addImages === undefined || files.length === 0) return
    const rejected = ((): string | null => {
      if (imageLimits !== undefined) {
        // Format precedes limits (DeepSeek Chat's filter order): a batch with
        // a non-image must announce the format problem, not a count or size
        // it could never pass anyway — addImages rejects it authoritatively.
        if (files.some(file => !(imageLimits.mediaTypes as readonly string[]).includes(file.type))) {
          return addImages(files)
        }
        if (attachments.length + files.length > imageLimits.maxImagesPerMessage) {
          return t('image.tooMany', { count: imageLimits.maxImagesPerMessage })
        }
        if (files.some(file => file.size > imageLimits.maxImageBytes)) {
          return t('image.fileTooLarge', { size: imageSizeText(imageLimits.maxImageBytes) })
        }
        const total = attachments.reduce((sum, attachment) => sum + attachment.file.size, 0)
          + files.reduce((sum, file) => sum + file.size, 0)
        if (total > imageLimits.maxMessageImageBytes) {
          return t('image.totalTooLarge', { size: imageSizeText(imageLimits.maxMessageImageBytes) })
        }
      }
      return addImages(files)
    })()
    if (rejected !== null) showToast(rejected)
  }, [addImages, attachments, imageLimits, showToast, t])

  // Whole-page file-drop intake (DeepSeek Chat behavior): the listeners live
  // on the document so a drop anywhere over the window adds images, not only
  // over the composer card. Safe as document-level state: the composer-bar
  // slot is `kind: 'single'`, so at most one bar is mounted to bind these.
  // Text drags carry no 'Files' type and pass through untouched, keeping the
  // native drop-text-into-textarea path. The overlay layer itself is
  // pointer-inert, so it never disturbs the enter/leave count.
  const canAcceptDrop = !locked && !machineBusy && addImages !== undefined
  useEffect(() => {
    const hasFiles = (event: globalThis.DragEvent): boolean =>
      event.dataTransfer?.types.includes('Files') ?? false
    const reset = (): void => {
      dragDepthRef.current = 0
      setDragActive(false)
    }
    const onDragEnter = (event: globalThis.DragEvent): void => {
      if (!hasFiles(event)) return
      event.preventDefault()
      dragDepthRef.current += 1
      setDragActive(true)
    }
    const onDragOver = (event: globalThis.DragEvent): void => {
      if (!hasFiles(event) || event.dataTransfer === null) return
      event.preventDefault()
      event.dataTransfer.dropEffect = canAcceptDrop ? 'copy' : 'none'
    }
    const onDragLeave = (event: globalThis.DragEvent): void => {
      if (!hasFiles(event)) return
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
      if (dragDepthRef.current === 0) setDragActive(false)
      // Leaving through the viewport edge does not balance the count on every
      // engine; a page-root leave at the border means the drag left the window.
      const leavingViewport = event.clientX <= 0 || event.clientY <= 0
        || event.clientX >= window.innerWidth || event.clientY >= window.innerHeight
      if ((event.target === document.documentElement || event.target === document.body) && leavingViewport) reset()
    }
    const onDrop = (event: globalThis.DragEvent): void => {
      if (!hasFiles(event)) return
      event.preventDefault()
      reset()
      if (!canAcceptDrop) return
      intakeImages([...(event.dataTransfer?.files ?? [])])
    }
    document.addEventListener('dragenter', onDragEnter)
    document.addEventListener('dragover', onDragOver)
    document.addEventListener('dragleave', onDragLeave)
    document.addEventListener('drop', onDrop)
    window.addEventListener('dragend', reset)
    return () => {
      document.removeEventListener('dragenter', onDragEnter)
      document.removeEventListener('dragover', onDragOver)
      document.removeEventListener('dragleave', onDragLeave)
      document.removeEventListener('drop', onDrop)
      window.removeEventListener('dragend', reset)
    }
  }, [canAcceptDrop, intakeImages])

  const closePreview = useCallback(() => { setPreview(null) }, [])

  // Rail thumbnails with their strings resolved here: the attachment atoms are
  // zero-cordis and read no locale.
  const railItems = useMemo<ComposerRailItem[]>(() => attachments.map(attachment => ({
    id: attachment.id,
    previewUrl: attachment.previewUrl,
    alt: attachment.file.name || t('image.pending'),
    removeLabel: t('image.remove', { name: attachment.file.name }),
    attachment,
  })), [attachments, t])

  const onSelect = (e: React.SyntheticEvent<HTMLTextAreaElement>): void => {
    // Any caret/selection gesture ends a live paste attempt (the machine
    // cannot observe DOM selection). Cheap no-op when none is live.
    if (keyboard !== undefined && keyboard.snapshot.paste !== undefined) keyboard.invalidatePaste()
    void e
  }

  // Button presses steal focus from the textarea; suppress at mousedown so
  // typing continues seamlessly. `preventScroll` for the same reason as the
  // unlock effect, and with no reveal of its own: the caret has not moved, and
  // the next keystroke gets the browser's native one.
  const keepFocus = (e: MouseEvent<HTMLButtonElement>): void => {
    e.preventDefault()
    inputRef.current?.focus({ preventScroll: true })
  }

  const onToggleCommandMenu = (): void => {
    const el = inputRef.current
    if (el !== null) toggleCommandMenu?.(selectionOf(el))
  }

  // Ordinary sessions retain their primary Send/Stop toggle. A continuable
  // child keeps Send as the primary action and exposes Stop independently so
  // pointer users can queue follow-ups while its current turn is running.
  const primaryStops = running && subagent === null
  const interruptible = running && continuable
  const primaryLabel = primaryStops ? t('input.stop') : t('input.send')
  const onPrimary = (): void => {
    if (primaryStops) {
      stop?.()
      return
    }
    if (inputActions === undefined) return // absent machine: the button is disabled
    /* v8 ignore next -- defensive: the primary button is disabled while empty||disabled, so a click cannot reach the false arm. */
    if (!empty && !disabled && !machineBusy) inputActions.submit()
  }

  // The Access seat: the projection-fed permission chip (renders nothing
  // while the permissions key is absent — permission-less host or Draft —
  // or while the command face is absent with the session).
  const accessSelect: ReactNode = command === undefined
    ? null
    : <PermissionSelect key={sessionId} value={permissions} locked={locked} command={command} t={t} />

  // Mirror-layer decorations: a visible backdrop with transparent text. The
  // claim token highlights through behind the textarea glyphs; each U+FFFC
  // placeholder renders as a chip (the textarea's own glyph is invisible, the
  // backdrop chip supplies the visual); the claim hint is ghost text.
  const deco = input === undefined ? INERT_DECORATIONS : deriveDecorations(input, lexicon)
  const backdrop: ReactNode[] = []
  {
    // Segment boundaries: the token range end, every chip offset, and every
    // text-ref range — merged in draft order (the sources never
    // overlap: chips sit on placeholders, text-refs on plain tokens, the
    // claim token only leads).
    let cursor = 0
    const pushPlain = (upTo: number): void => {
      if (upTo > cursor) backdrop.push(draft.slice(cursor, upTo))
      cursor = upTo
    }
    if (deco.token !== null) {
      backdrop.push(
        <mark key="token" className={css.hlToken} data-decoration="token">
          {draft.slice(deco.token.start, deco.token.end)}
        </mark>,
      )
      cursor = deco.token.end
    }
    type Boundary =
      | { at: number; kind: 'chip'; chip: (typeof deco.chips)[number] }
      | { at: number; kind: 'text-ref'; ref: (typeof deco.textRefs)[number] }
    const boundaries: Boundary[] = [
      ...deco.chips.map(chip => ({ at: chip.offset, kind: 'chip' as const, chip })),
      ...deco.textRefs.map(ref => ({ at: ref.start, kind: 'text-ref' as const, ref })),
    ].sort((a, b) => a.at - b.at)
    for (const b of boundaries) {
      if (b.at < cursor) continue // claim-token overlap: the leading mark wins
      pushPlain(b.at)
      if (b.kind === 'chip') {
        const chip = b.chip
        backdrop.push(
          // The cell's ::before renders U+FFFC itself so its advance equals the
          // textarea's placeholder exactly (same char, same font); the label is
          // a clipped overlay that never affects layout.
          <span
            key={`chip-${chip.occurrenceId}`}
            className={clsx(css.chip, chip.invalid && css.chipInvalid)}
            data-decoration="chip"
            data-occurrence={chip.occurrenceId}
            data-invalid={chip.invalid || undefined}
            title={chip.label}
          >
            <span className={css.chipLabel}>{chip.label}</span>
          </span>,
        )
        cursor = chip.offset + 1 // the placeholder char the chip stands for
      } else {
        // Plain-range highlight: the glyphs stay the
        // textarea's (advance untouched); the mark paints the chip look.
        backdrop.push(
          <mark key={`ref-${b.ref.start}`} className={css.textRef} data-decoration="text-ref">
            {draft.slice(b.ref.start, b.ref.end)}
          </mark>,
        )
        cursor = b.ref.end
      }
    }
    pushPlain(draft.length)
    if (deco.hint !== null) {
      // Claim tokens have the `/name ` format (trailing space); trim to the bare name.
      const commandName = input?.claim?.token.slice(1).trim() ?? ''
      const hintKey = `hint.${commandName === 'goal' && hasGoal ? 'goal.active' : commandName}`
      // Dynamic lookup by claimed command name: unknown commands miss the
      // dictionary and keep the machine's own hint, so the call is wide.
      const translated = (t as Translate)(hintKey)
      const displayHint = translated !== hintKey ? translated : deco.hint
      backdrop.push(<span key="hint" className={css.hint} data-decoration="hint">{displayHint}</span>)
    }
  }

  return (
    <div className={clsx(css.root, variant === 'hero' && css.hero)}>
      {dragActive && (
        <DropOverlay
          disabled={!canAcceptDrop}
          labels={dropOverlayLabels(t, canAcceptDrop, imageLimits === undefined ? undefined : {
            count: imageLimits.maxImagesPerMessage,
            size: imageSizeText(imageLimits.maxImageBytes),
          })}
        />
      )}
      {toast !== null && (
        <Toast
          key={toast.seq}
          text={toast.text}
          icon={<IconWarningOutline16 />}
          anchor={cardRef.current}
          onDone={dismissToast}
        />
      )}
      {notice !== null && (
        <div className={clsx(css.notice, notice.level === 'error' && css.noticeError)} role="status">
          {notice.text}
        </div>
      )}
      {/* Trigger clicks land on the card, not the textarea: the toolbar row's
          disabled controls swallow clicks otherwise (the CSS state disarms
          their pointer events), so the WHOLE capsule is the pick target.
          pointerdown stops here so the Menu's outside-close cannot race the
          click's reopen (close-then-open flickers the chip's open echo). */}
      <div
        ref={cardRef}
        className={clsx(css.card, workspaceTrigger && css.cardWorkspaceTrigger)}
        data-composer-card
        onClick={workspaceTrigger ? onRequestWorkspace : undefined}
        onPointerDown={workspaceTrigger ? (e) => { e.stopPropagation() } : undefined}
      >
        {overlay !== undefined && <div className={css.overlayAnchor}>{overlay}</div>}
        {accessory !== undefined && <div className={css.accessory}>{accessory}</div>}
        {railItems.length > 0 && (
          <div className={css.attachments}>
            <AttachmentRail
              items={railItems}
              labels={attachmentRailLabels(t)}
              onOpen={(item) => { setPreview(item.attachment) }}
              onRemove={(item) => { removeImage?.(item.attachment.id) }}
            />
          </div>
        )}
        {/* One scrollport, two text layers. The hidden mirror renders draft+'\n' and stretches the
            stack to the draft's FULL height (counting rows by '\n' cannot see soft wraps); the
            absolutely-positioned backdrop and textarea ride that height, and .scroll — capped at 14
            lines in CSS — is the only thing that scrolls. The caret belongs to the textarea and the
            glyphs to the backdrop, so they can only stay together by moving together: one scroll
            offset the browser applies to both layers at once, never a JS mirror between two boxes,
            which a compositor-driven gesture outruns and leaves the words trailing the caret. */}
        <div ref={scrollRef} className={css.scroll} data-input-scroll>
          <div className={css.grow} dir={textDirection(draft)}>
            <div aria-hidden className={css.backdrop} data-input-backdrop>{backdrop}</div>
            <textarea
              ref={inputRef}
              className={css.input}
              value={draft}
              disabled={textareaDisabled}
              readOnly={machineBusy || workspaceTrigger}
              aria-label={workspaceTrigger ? t('hero.chooseWorkspace') : undefined}
              aria-haspopup={workspaceTrigger ? 'menu' : undefined}
              aria-expanded={workspaceTrigger ? workspacePickerOpen : undefined}
              data-phase={input?.phase ?? 'inert'}
              placeholder={placeholder ?? (parentOffline
                ? t('placeholder.parentOffline')
                : disabled
                  ? t('placeholder.unavailable')
                  // The steer hint deliberately outranks the plan placeholder:
                  // while it shows, the whole-queue gesture is genuinely available
                  // (the gate never consults plan mode), so the actionable hint wins.
                  : canSteerQueue
                    ? t('placeholder.steerQueue')
                    : planActive ? t('placeholder.plan') : t('placeholder.default'))}
              rows={2}
              onChange={onChange}
              onKeyDown={onKeyDown}
              onSelect={onSelect}
              onCopy={(e) => { onCopyOrCut(e, false) }}
              onCut={(e) => { onCopyOrCut(e, true) }}
              onPaste={onPaste}
              onCompositionStart={onCompositionStart}
              onCompositionEnd={onCompositionEnd}
            />
            <div ref={mirrorRef} aria-hidden className={css.mirror} data-input-mirror>{`${draft}\n`}</div>
          </div>
        </div>
        <div className={css.row}>
          <div className={css.tools}>
            <Tooltip label={t('input.commands')} side="top" delayMs={500}>
              <button
                type="button"
                className={css.add}
                aria-label={t('input.commands')}
                aria-haspopup="listbox"
                aria-expanded={commandMenuOpen}
                disabled={locked || toggleCommandMenu === undefined}
                onMouseDown={keepFocus}
                onClick={onToggleCommandMenu}
              >
                <IconPlusOutline16 size={14} />
              </button>
            </Tooltip>
            <div className={css.modes}>
              {accessSelect}
              {renderSlot('conversation.input.plan', { locked })}
            </div>
            {leftItems}
          </div>
          <div className={css.trailing}>
            {rightItems}
            {renderSlot('conversation.input.model', { locked: modelSeatLocked })}
            <ContextMeter useProjection={useProjection} t={t} />
            {interruptible && (
              <Tooltip label={t('input.stop')} side="top" delayMs={500}>
                <button
                  type="button"
                  className={css.primary}
                  aria-label={t('input.stop')}
                  disabled={stop === undefined}
                  onMouseDown={keepFocus}
                  onClick={stop}
                >
                  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
                    <rect x="3" y="3" width="10" height="10" rx="3" fill="currentColor" />
                  </svg>
                </button>
              </Tooltip>
            )}
            <Tooltip label={primaryLabel} side="top" delayMs={500}>
              <button
                type="button"
                className={css.primary}
                aria-label={primaryLabel}
                disabled={primaryStops ? stop === undefined : empty || disabled || machineBusy}
                onMouseDown={keepFocus}
                onClick={onPrimary}
              >
                {primaryStops ? (
                  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
                    <rect x="3" y="3" width="10" height="10" rx="3" fill="currentColor" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
                    <path d="M8.3125 0.980183C8.66767 1.0531 8.97902 1.20418 9.2627 1.43233C9.48724 1.61297 9.73029 1.85793 9.97949 2.10714L14.707 6.83468L13.293 8.24874L9 3.95577V15.0417H7V3.95577L2.70703 8.24874L1.29297 6.83468L6.02051 2.10714C6.26971 1.85793 6.51277 1.61297 6.7373 1.43233C6.97662 1.23986 7.28445 1.04402 7.6875 0.980183C7.8973 0.947006 8.1031 0.95516 8.3125 0.980183Z" fill="currentColor" />
                  </svg>
                )}
              </button>
            </Tooltip>
          </div>
        </div>
      </div>
      {preview !== null && (
        <ImageLightbox
          src={preview.previewUrl}
          alt={preview.file.name || t('image.original')}
          labels={lightboxLabels(t)}
          onClose={closePreview}
        />
      )}
      {footer}
    </div>
  )
}
