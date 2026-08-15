import { useMemo, useState, type ChangeEvent, type KeyboardEvent } from 'react'
import clsx from 'clsx'
import {
  Button, IconCheckOutline14, IconChevronLeftOutline14, IconChevronRightOutline14,
  IconCloseOutline16, IconEditOutline16, MarkdownText, textDirection,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  PendingQuestion, planReviewOf,
  type QuestionAnswer, type QuestionComposerProps,
} from './contract/slots.ts'
import { PlanReviewPanel } from './PlanReviewPanel.tsx'
import css from './QuestionComposer.module.css'

interface DraftAnswer {
  selected: string[]
  custom: string
  skipped: boolean
}

/**
 * Displayed feedback: validation feedback is stored as a dictionary KEY and
 * translated at render, so already-shown feedback follows a locale switch;
 * runtime failure messages (finished strings from the wire) pass through
 * verbatim.
 */
type Feedback = { key: 'error.incomplete' | 'error.unanswered' } | { text: string }

/**
 * Split the conventional recommendation suffix without changing the answer value.
 * @param label - Original option label returned if selected.
 * @returns Display label plus recommendation state.
 */
export function parseRecommendedLabel(label: string): { label: string; recommended: boolean } {
  const suffix = /\s*(?:\((?:recommended|推荐)\)|（(?:recommended|推荐)）)\s*$/i
  return suffix.test(label)
    ? { label: label.replace(suffix, ''), recommended: true }
    : { label, recommended: false }
}

/** Return whether a text-field key event belongs to an active IME composition. */
function isComposing(event: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>): boolean {
  // keyCode 229 is the legacy IME-composition signal engines emit without isComposing.
  // oxlint-disable-next-line typescript/no-deprecated
  return event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229
}

/**
 * Composer takeover boundary; the carrier key keys local drafts, so a
 * same-request replay (same key, new carrier object) preserves them.
 *
 * One takeover, two shapes: a request that declares a presentation intent this
 * package renders takes that shape (a plan review is one decision over one
 * plan, not a question set), and every other request takes the generic flow.
 * The routing lives here, at the one entry that owns the composer seat, so
 * neither shape can claim a request the other is already rendering.
 *
 * @param props - the selector-matched pending question carrier plus the framework standard kit.
 * @returns The question flow, or the intent's own surface, for this request.
 */
export function QuestionComposer(props: QuestionComposerProps) {
  // Domain-face mint rides the carrier's stable identity (never minted in a
  // select/render dispatch — per-dispatch minting would churn memo identity).
  const question = useMemo(() => new PendingQuestion(props.matched), [props.matched])
  const review = useMemo(() => planReviewOf(question.questions), [question])
  return review === undefined
    ? <QuestionFlow key={question.key} pending={question} t={props.t} />
    : <PlanReviewPanel key={question.key} pending={question} review={review} t={props.t} />
}

function QuestionFlow({ pending, t }: { pending: PendingQuestion } & Pick<QuestionComposerProps, 't'>) {
  const questions = pending.questions
  const [index, setIndex] = useState(0)
  const [drafts, setDrafts] = useState<DraftAnswer[]>(() => questions.map(() => ({
    selected: [], custom: '', skipped: false,
  })))
  const [busy, setBusy] = useState<'answer' | 'cancel' | null>(null)
  const [error, setError] = useState<Feedback | null>(null)
  // index stays in bounds (every setIndex site clamps) and drafts mirrors questions 1:1.
  // oxlint-disable-next-line typescript/no-non-null-assertion
  const question = questions[index]!
  // oxlint-disable-next-line typescript/no-non-null-assertion
  const draft = drafts[index]!
  const hasOptions = (question.options?.length ?? 0) > 0

  const cancelFlow = (): void => {
    setBusy('cancel')
    setError(null)
    void pending.cancel().catch((cause: unknown) => {
      setBusy(null)
      setError({ text: cause instanceof Error ? cause.message : String(cause) })
    })
  }

  const updateDraft = (update: (current: DraftAnswer) => DraftAnswer): void => {
    setDrafts(current => current.map((item, itemIndex) => itemIndex === index ? update(item) : item))
    setError(null)
  }

  const choose = (label: string): void => {
    updateDraft((current) => {
      if (question.multiSelect === true) {
        const selected = current.selected.includes(label)
          ? current.selected.filter(item => item !== label)
          : [...current.selected, label]
        return { ...current, selected, skipped: false }
      }
      return { selected: [label], custom: '', skipped: false }
    })
    if (question.multiSelect !== true && index < questions.length - 1) {
      setIndex(current => current + 1)
    }
  }

  const answered = (item: DraftAnswer): boolean =>
    item.selected.length > 0 || item.custom.trim() !== ''

  const completed = (item: DraftAnswer): boolean => answered(item) || item.skipped

  const submitDrafts = (values: DraftAnswer[]): void => {
    const missing = values.findIndex(item => !completed(item))
    if (missing >= 0) {
      setIndex(missing)
      setError({ key: 'error.incomplete' })
      return
    }
    const answer: QuestionAnswer = {
      answers: questions.map((item, itemIndex) => {
        const value = values[itemIndex] as DraftAnswer
        if (value.skipped) return { id: item.id, selected: [] }
        const custom = value.custom.trim()
        return {
          id: item.id,
          selected: custom === '' || item.multiSelect === true ? value.selected : [],
          ...(custom === '' ? {} : { custom }),
        }
      }),
    }
    setBusy('answer')
    setError(null)
    void pending.answer(answer).catch((cause: unknown) => {
      setBusy(null)
      setError({ text: cause instanceof Error ? cause.message : String(cause) })
    })
  }

  const continueFlow = (): void => {
    if (!answered(draft)) {
      setError({ key: 'error.unanswered' })
      return
    }
    if (index < questions.length - 1) {
      setIndex(current => current + 1)
      setError(null)
      return
    }
    submitDrafts(drafts)
  }

  // Shared by the inline custom input and the optionless textarea: a
  // multi-select draft retains checked labels, while a single-select custom
  // answer replaces its selection. Enter continues the flow (Shift+Enter
  // stays a newline in the textarea; on the single-line input it is inert).
  const draftCustom = (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
    const value = event.target.value
    updateDraft(current => ({
      ...current,
      selected: question.multiSelect === true ? current.selected : [],
      custom: value,
      skipped: false,
    }))
  }

  const continueFromCustom = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey || isComposing(event)) return
    event.preventDefault()
    continueFlow()
  }

  const skipQuestion = (): void => {
    const nextDrafts = drafts.map((item, itemIndex) => itemIndex === index
      ? { selected: [], custom: '', skipped: true }
      : item)
    setDrafts(nextDrafts)
    setError(null)
    if (index < questions.length - 1) {
      setIndex(current => current + 1)
      return
    }
    submitDrafts(nextDrafts)
  }

  return (
    <div className={css.frame} data-question-key={pending.key}>
      <section className={css.card} aria-labelledby={`question-${pending.key}-${String(index)}`}>
        <header className={css.header}>
          <div className={css.headingBlock}>
            {question.header !== undefined && <div className={css.eyebrow}>{question.header}</div>}
            <h2 className={css.title} dir={textDirection(question.question)} id={`question-${pending.key}-${String(index)}`}>
              {question.question}
            </h2>
          </div>
          <button
            type="button" className={css.iconButton} aria-label={t('nav.cancel')}
            title={t('nav.cancel')}
            disabled={busy !== null} onClick={cancelFlow}
          >
            <IconCloseOutline16 />
          </button>
        </header>

        <div className={css.body} data-question-scroll>
          {question.detail !== undefined && (
            <div className={css.detail}><MarkdownText text={question.detail} /></div>
          )}
          <div className={css.options} role={question.multiSelect === true ? 'group' : 'radiogroup'}>
            {(question.options ?? []).map((option, optionIndex) => {
              const selected = draft.selected.includes(option.label)
              const display = parseRecommendedLabel(option.label)
              return (
                <button
                  type="button" key={`${option.label}-${String(optionIndex)}`}
                  className={clsx(css.option, selected && question.multiSelect !== true && css.optionSelected)}
                  role={question.multiSelect === true ? 'checkbox' : 'radio'}
                  aria-checked={selected}
                  aria-label={display.label}
                  disabled={busy !== null}
                  onClick={() => { choose(option.label) }}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' || !drafts.every(completed)) return
                    event.preventDefault()
                    submitDrafts(drafts)
                  }}
                >
                  {question.multiSelect === true
                    ? (
                      <span className={clsx(css.checkbox, selected && css.checkboxChecked)} aria-hidden="true">
                        {selected && <IconCheckOutline14 size={12} />}
                      </span>
                    )
                    : <span className={css.number}>{optionIndex + 1}</span>}
                  <span className={css.optionCopy}>
                    <span className={css.optionLine}>
                      <span className={css.optionLabel}>{display.label}</span>
                      {display.recommended && (
                        <span className={css.badge}>{t('option.recommended')}</span>
                      )}
                      {option.description !== undefined && (
                        <span className={css.description}>{option.description}</span>
                      )}
                    </span>
                  </span>
                </button>
              )
            })}

            {hasOptions
              ? (
                <div className={clsx(css.customRow, draft.custom !== '' && css.customRowActive)}>
                  {question.multiSelect === true
                    ? (
                      <span
                        className={clsx(css.checkbox, draft.custom !== '' && css.checkboxChecked)}
                        aria-hidden="true"
                      >
                        {draft.custom !== '' && <IconCheckOutline14 size={12} />}
                      </span>
                    )
                    : (
                      <span className={css.number} aria-hidden="true">
                        <IconEditOutline16 size={12} />
                      </span>
                    )}
                  <input
                    type="text"
                    className={css.customInput}
                    dir={textDirection(draft.custom)}
                    value={draft.custom}
                    disabled={busy !== null}
                    placeholder={t('custom.placeholder')}
                    onChange={draftCustom}
                    onKeyDown={continueFromCustom}
                  />
                </div>
              )
              : (
                <textarea
                  autoFocus
                  className={css.customTextarea}
                  dir={textDirection(draft.custom)}
                  value={draft.custom}
                  disabled={busy !== null}
                  rows={2}
                  placeholder={t('custom.placeholder')}
                  onChange={draftCustom}
                  onKeyDown={continueFromCustom}
                />
              )}
          </div>
        </div>

        <footer className={css.footer}>
          <div className={css.pager}>
            <button
              type="button" className={css.iconButton} aria-label={t('nav.prev')}
              disabled={index === 0 || busy !== null}
              onClick={() => { setIndex(index - 1); setError(null) }}
            >
              <IconChevronLeftOutline14 />
            </button>
            <span className={css.progress}>{index + 1} / {questions.length}</span>
            <button
              type="button" className={css.iconButton} aria-label={t('nav.next')}
              disabled={index === questions.length - 1 || busy !== null}
              onClick={() => { setIndex(index + 1); setError(null) }}
            >
              <IconChevronRightOutline14 />
            </button>
          </div>
          <div className={css.feedback} role="status">
            {error === null ? null : 'key' in error ? t(error.key) : error.text}
          </div>
          <div className={css.footerActions}>
            <Button variant="outline" disabled={busy !== null} onClick={skipQuestion}>
              {t('action.skip')}
            </Button>
            <Button
              variant="primary"
              disabled={busy !== null || !answered(draft)} onClick={continueFlow}
            >
              {busy === 'answer'
                ? t('submitting')
                : index === questions.length - 1 ? t('submit') : t('action.next')}
            </Button>
          </div>
        </footer>
      </section>
    </div>
  )
}
