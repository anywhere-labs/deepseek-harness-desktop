import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ModelReasoningEffort, ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import {
  IconCheckOutline16,
  IconChevronDownOutline14,
  IconWarningOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { VisionLocaleKey } from './vision-locales.ts'
import { modelCapabilityBadges, type VisionCatalogModel } from './vision-experience.ts'

export interface DesktopCatalogModel extends VisionCatalogModel {
  description?: string
  reasoning?: {
    efforts: readonly ModelReasoningEffort[]
    defaultEffort?: string
  }
}

export interface DesktopModelDirectoryState {
  current: ModelSelection | null
  groups: readonly {
    id: string
    name: string
    models: readonly DesktopCatalogModel[]
  }[]
  failures: readonly { id: string; name: string; message: string }[]
  status: 'idle' | 'loading' | 'ready' | 'selecting' | 'error'
  error: string | null
}

export interface VisionModelSelectInjected {
  available: boolean
  directory: SnapshotStore<DesktopModelDirectoryState>
  load: () => void
  select: (selection: ModelSelection) => Promise<boolean>
}

export interface VisionModelSelectProps extends VisionModelSelectInjected, PropsLocale<'desktop.vision'> {
  locked: boolean
}

interface ModelChoice {
  provider: string
  providerName: string
  model: DesktopCatalogModel
}

export function VisionModelSelect({ locked, available, directory, load, select, t }: VisionModelSelectProps) {
  const state = useSyncExternalStore(
    listener => directory.subscribe(listener),
    () => directory.getSnapshot(),
  )
  const [open, setOpen] = useState(false)
  const [selectionError, setSelectionError] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const id = useId()
  const choices = useMemo<ModelChoice[]>(() => state.groups.flatMap(group =>
    group.models.map(model => ({ provider: group.id, providerName: group.name, model }))), [state.groups])
  const current = choices.find(choice => choice.provider === state.current?.provider && choice.model.id === state.current.model)
  const currentEffort = state.current?.reasoningEffort ?? current?.model.reasoning?.defaultEffort
  const busy = state.status === 'selecting'

  useEffect(() => {
    if (available) load()
  }, [available, load])

  useEffect(() => {
    if (!open) return
    const close = (event: globalThis.MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => { document.removeEventListener('mousedown', close) }
  }, [open])

  if (!available) return null

  const chooseModel = (choice: ModelChoice): void => {
    if (busy) return
    setSelectionError(false)
    const effort = choice.model.reasoning?.defaultEffort
    void select({
      provider: choice.provider,
      model: choice.model.id,
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
    }).then((accepted) => {
      setSelectionError(!accepted)
      if (accepted) {
        setOpen(false)
        queueMicrotask(() => { triggerRef.current?.focus() })
      }
    })
  }

  const chooseEffort = (effort: string | undefined): void => {
    if (busy || state.current === null) return
    setSelectionError(false)
    void select({
      provider: state.current.provider,
      model: state.current.model,
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
    }).then((accepted) => {
      setSelectionError(!accepted)
      if (accepted) setOpen(false)
    })
  }

  const label = current?.model.name ?? state.current?.model ?? t('model.menu')
  const currentBadges = current === undefined ? [] : modelCapabilityBadges(current.model)

  return (
    <div ref={rootRef} className="dshVisionModelRoot">
      <button
        ref={triggerRef}
        type="button"
        className="dshVisionModelTrigger"
        aria-label={t('model.current', { model: label })}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        disabled={locked}
        onClick={() => {
          setOpen(value => !value)
          if (!open) load()
        }}
      >
        <span className="dshVisionModelTriggerLabel">{label}</span>
        {currentBadges.includes('vision') && <span className="dshVisionTriggerMark" aria-label={t('badge.vision')}>V</span>}
        <IconChevronDownOutline14 className="dshVisionChevron" data-open={open || undefined} />
      </button>

      {open && (
        <div id={`${id}-menu`} className="dshVisionModelMenu" role="menu" aria-label={t('model.menu')}>
          {(state.status === 'loading' || busy) && <div className="dshVisionMenuStatus">{t('model.loading')}</div>}
          {(state.error !== null || selectionError) && (
            <div className="dshVisionMenuError" role="alert">
              <IconWarningOutline16 />
              <span>{selectionError ? t('model.selectFailure') : state.error}</span>
              <button type="button" onClick={load}>{t('model.retry')}</button>
            </div>
          )}
          {state.failures.map(failure => (
            <div className="dshVisionMenuWarning" key={failure.id} title={failure.message}>
              {t('model.failure', { provider: failure.name })}
            </div>
          ))}
          <div className="dshVisionModelGroups">
            {state.groups.map(group => (
              <section className="dshVisionModelGroup" key={group.id} aria-label={group.name}>
                <div className="dshVisionModelGroupTitle">{group.name}</div>
                {group.models.map(model => {
                  const selected = state.current?.provider === group.id && state.current.model === model.id
                  const badges = modelCapabilityBadges(model)
                  return (
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={selected}
                      className="dshVisionModelOption"
                      key={model.id}
                      disabled={busy}
                      onClick={() => { chooseModel({ provider: group.id, providerName: group.name, model }) }}
                    >
                      <span className="dshVisionModelCopy">
                        <span className="dshVisionModelNameRow">
                          <span className="dshVisionModelName">{model.name}</span>
                          {badges.map(badge => (
                            <span className="dshVisionBadge" data-badge={badge} key={badge}>{t(`badge.${badge}` as VisionLocaleKey)}</span>
                          ))}
                        </span>
                        {model.description !== undefined && <span className="dshVisionModelDescription">{model.description}</span>}
                      </span>
                      <span className="dshVisionModelCheck">{selected ? <IconCheckOutline16 /> : null}</span>
                    </button>
                  )
                })}
              </section>
            ))}
          </div>
          {choices.length === 0 && state.status !== 'loading' && <div className="dshVisionMenuStatus">{t('model.empty')}</div>}
          {current?.model.reasoning !== undefined && (
            <section className="dshVisionEffortSection" aria-label={t('model.effort')}>
              <div className="dshVisionModelGroupTitle">{t('model.effort')}</div>
              {current.model.reasoning.defaultEffort === undefined && (
                <EffortOption
                  label={t('model.providerDefault')}
                  selected={currentEffort === undefined}
                  disabled={busy}
                  onClick={() => { chooseEffort(undefined) }}
                />
              )}
              {current.model.reasoning.efforts.map(effort => (
                <EffortOption
                  key={effort.id}
                  label={effort.name}
                  selected={currentEffort === effort.id}
                  disabled={busy}
                  onClick={() => { chooseEffort(effort.id) }}
                />
              ))}
            </section>
          )}
        </div>
      )}
    </div>
  )
}

function EffortOption({ label, selected, disabled, onClick }: {
  label: string
  selected: boolean
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      className="dshVisionEffortOption"
      disabled={disabled}
      onClick={onClick}
    >
      <span>{label}</span>
      {selected && <IconCheckOutline16 />}
    </button>
  )
}
