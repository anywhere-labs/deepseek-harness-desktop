import { createElement, useEffect, useState } from 'react'
import type { ChangeEvent, FormEvent } from 'react'

import type { ProviderCardExtrasOwnerProps } from '@deepseek-ai/dsh-client-ui-settings-models/client'
import type { DesktopSettingsLocaleKey } from './desktop-settings-locales.ts'
import {
  DESKTOP_COPILOT_AUTHORIZATION_ANSWER_PATH,
  DESKTOP_COPILOT_AUTHORIZATION_BEGIN_PATH,
  DESKTOP_COPILOT_AUTHORIZATION_CANCEL_PATH,
  DESKTOP_COPILOT_AUTHORIZATION_MODELS_PATH,
  DESKTOP_COPILOT_AUTHORIZATION_PATH,
  type DesktopCopilotAuthorizationModelsResponse,
  type DesktopCopilotAuthorizationView,
} from '../copilot-authorization-contract.ts'


interface CopilotProviderCardProps extends ProviderCardExtrasOwnerProps {
  readonly t: (key: DesktopSettingsLocaleKey) => string
}

async function requestJson(path: string, method: 'GET' | 'POST', body?: object): Promise<Record<string, unknown>> {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    redirect: 'error',
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const value: unknown = await response.json()
  if (!response.ok || typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Copilot authorization request failed')
  }
  return value as Record<string, unknown>
}

function parseView(value: Record<string, unknown>): DesktopCopilotAuthorizationView | undefined {
  if (typeof value.available !== 'boolean' || typeof value.configured !== 'boolean'
    || typeof value.canCancel !== 'boolean'
    || !['idle', 'authorizing', 'authorized', 'cancelled', 'failed'].includes(String(value.phase))) return undefined
  return value as unknown as DesktopCopilotAuthorizationView
}

function parseModels(value: Record<string, unknown>): DesktopCopilotAuthorizationModelsResponse | undefined {
  if (typeof value.configured !== 'boolean' || !Array.isArray(value.models)
    || !value.models.every((item: unknown) => typeof item === 'object' && item !== null
      && typeof (item as { id?: unknown }).id === 'string'
      && ((item as { category?: unknown }).category === undefined
        || typeof (item as { category?: unknown }).category === 'string')
      && ((item as { highCost?: unknown }).highCost === undefined
        || typeof (item as { highCost?: unknown }).highCost === 'boolean'))) return undefined
  return value as unknown as DesktopCopilotAuthorizationModelsResponse
}

function button(label: string, disabled: boolean, onClick: () => void, secondary = false, type: 'button' | 'submit' = 'button') {
  return createElement('button', {
    type,
    className: `dshDesktopCopilotButton${secondary ? ' dshDesktopCopilotButtonSecondary' : ''}`,
    disabled,
    onClick,
  }, label)
}

/** Add the native GitHub device-code sign-in action to pi-ai's Copilot model card. */
export function CopilotProviderCard(props: CopilotProviderCardProps) {
  if (props.provider.settingsNs !== 'llm-pi-ai' || props.provider.provider !== 'github-copilot') return null
  return createElement(CopilotAuthorizationControls, { t: props.t })
}

function CopilotAuthorizationControls({ t }: Pick<CopilotProviderCardProps, 't'>) {
  const [view, setView] = useState<DesktopCopilotAuthorizationView | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const [answer, setAnswer] = useState('')
  const [selection, setSelection] = useState('')
  const [models, setModels] = useState<DesktopCopilotAuthorizationModelsResponse['models']>()
  const [modelsError, setModelsError] = useState(false)
  const [modelRefresh, setModelRefresh] = useState(0)

  useEffect(() => {
    let disposed = false
    const refresh = async (): Promise<void> => {
      try {
        const next = parseView(await requestJson(DESKTOP_COPILOT_AUTHORIZATION_PATH, 'GET'))
        if (!disposed && next !== undefined) {
          setView(next)
          setError(undefined)
        }
      } catch {
        if (!disposed) setError(t('copilotStatusUnavailable'))
      }
    }
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, view?.phase === 'authorizing' ? 700 : 2500)
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [t, view?.phase])

  useEffect(() => {
    if (!view?.configured) {
      setModels(undefined)
      setModelsError(false)
      return
    }
    let disposed = false
    setModelsError(false)
    void requestJson(DESKTOP_COPILOT_AUTHORIZATION_MODELS_PATH, 'GET')
      .then(parseModels)
      .then(result => {
        if (disposed) return
        if (result === undefined || !result.configured) throw new Error('Invalid Copilot models response')
        setModels(result.models)
      })
      .catch(() => { if (!disposed) { setModels(undefined); setModelsError(true) } })
    return () => { disposed = true }
  }, [view?.configured, modelRefresh])

  const run = async (path: string, body: object): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      await requestJson(path, 'POST', body)
      if (path === DESKTOP_COPILOT_AUTHORIZATION_ANSWER_PATH) {
        setAnswer('')
        setSelection('')
      }
      const next = parseView(await requestJson(DESKTOP_COPILOT_AUTHORIZATION_PATH, 'GET'))
      if (next !== undefined) {
        setView(next)
        if (next.phase === 'authorized') setModelRefresh(value => value + 1)
      }
    } catch {
      setError(t('copilotActionFailed'))
    } finally {
      setBusy(false)
    }
  }

  const active = view?.phase === 'authorizing'
  const prompt = active ? view.prompt : undefined
  const message: string | undefined = view?.configured
    ? t('copilotConnected')
    : view?.phase === 'authorized'
      ? t('copilotConnected')
      : view?.phase === 'cancelled'
        ? t('copilotCancelled')
        : active && view.notice === undefined && prompt === undefined
          ? t('copilotWaiting')
          : undefined

  return createElement('div', { className: 'dshDesktopCopilotCard', 'data-provider': 'github-copilot' },
    createElement('div', { className: 'dshDesktopCopilotCopy' },
      createElement('strong', null, t('copilotTitle')),
      createElement('p', null, t('copilotIntro')),
    ),
    view?.available === false
      ? createElement('p', { className: 'dshDesktopCopilotStatus', role: 'status' }, t('copilotUnavailable'))
      : null,
    view?.notice === undefined
      ? null
      : createElement('div', { className: 'dshDesktopCopilotNotice', role: 'status' },
          createElement('p', null, view.notice.message),
          view.notice.url === undefined
            ? null
            : createElement('a', {
                href: view.notice.url,
                target: '_blank',
                rel: 'noopener noreferrer',
              }, t('copilotOpenVerification')),
          view.notice.code === undefined
            ? null
            : createElement('code', { className: 'dshDesktopCopilotCode' }, view.notice.code),
        ),
    prompt === undefined
      ? null
      : createElement('form', {
          className: 'dshDesktopCopilotPrompt',
          onSubmit: (event: FormEvent<HTMLFormElement>) => {
            event.preventDefault()
            const value = prompt.kind === 'select' ? selection : answer
            if (value.length > 0) void run(DESKTOP_COPILOT_AUTHORIZATION_ANSWER_PATH, { promptId: prompt.id, answer: value })
          },
        },
          createElement('label', null,
            createElement('span', null, prompt.message),
            prompt.kind === 'select'
              ? createElement('select', {
                  value: selection,
                  onChange: (event: ChangeEvent<HTMLSelectElement>) => { setSelection(event.currentTarget.value) },
                  required: true,
                  disabled: busy,
                },
                  createElement('option', { value: '' }, t('copilotChooseOption')),
                  ...(prompt.options ?? []).map(option => createElement('option', { key: option.id, value: option.id }, option.label)),
                )
              : createElement('input', {
                  type: prompt.kind === 'secret' ? 'password' : 'text',
                  value: answer,
                  placeholder: prompt.placeholder,
                  onChange: (event: ChangeEvent<HTMLInputElement>) => { setAnswer(event.currentTarget.value) },
                  autoComplete: prompt.kind === 'secret' ? 'off' : 'one-time-code',
                  required: true,
                  maxLength: 4096,
                  disabled: busy,
                }),
          ),
          createElement('div', { className: 'dshDesktopCopilotActions' },
            button(t('copilotSubmitAnswer'), busy || (prompt.kind === 'select' ? selection.length === 0 : answer.length === 0), () => {}, false, 'submit'),
          ),
        ),
    message === undefined ? null : createElement('p', { className: 'dshDesktopCopilotStatus', role: 'status' }, message),
    view?.configured
      ? createElement('section', { className: 'dshDesktopCopilotModels', 'aria-label': t('copilotModelsTitle') },
          createElement('strong', null, t('copilotModelsTitle')),
          modelsError
            ? createElement('p', { role: 'status' }, t('copilotModelsUnavailable'))
            : models === undefined
              ? createElement('p', { role: 'status' }, t('copilotModelsLoading'))
              : models.length === 0
                ? createElement('p', { role: 'status' }, t('copilotModelsEmpty'))
                : createElement('ul', null, ...models.map(model => createElement('li', { key: model.id },
                    createElement('span', null, model.id),
                    createElement('span', { className: 'dshDesktopCopilotBadges' },
                      createElement('span', { className: 'dshDesktopCopilotCategory' },
                        model.category === undefined || model.category.length === 0
                          ? t('copilotCategoryUnavailable')
                          : model.category.replace(/^[a-z]/u, initial => initial.toUpperCase())),
                      model.highCost === true
                        ? createElement('span', { className: 'dshDesktopCopilotCategory' }, t('copilotHighCost'))
                        : null,
                    ),
                  ))),
          modelsError ? button(t('copilotModelsRetry'), false, () => { setModelRefresh(value => value + 1) }, true) : null,
        )
      : null,
    error === undefined && view?.phase !== 'failed'
      ? null
      : createElement('p', { className: 'dshDesktopCopilotError', role: 'alert' }, error ?? t('copilotActionFailed')),
    createElement('div', { className: 'dshDesktopCopilotActions' },
      active
        ? view.canCancel
          ? button(t('copilotCancel'), busy, () => { void run(DESKTOP_COPILOT_AUTHORIZATION_CANCEL_PATH, {}) }, true)
          : null
        : button(
            view?.configured ? t('copilotSignedIn') : t('copilotSignIn'),
            busy || view?.available !== true,
            () => { void run(DESKTOP_COPILOT_AUTHORIZATION_BEGIN_PATH, {}) },
          ),
    ),
  )
}
