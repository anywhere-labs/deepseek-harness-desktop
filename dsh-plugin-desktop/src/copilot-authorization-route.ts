import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { credentialKey, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { AuthorizationService } from '@deepseek-ai/dsh-authorization'
import type {
  AuthorizationNotice,
  AuthorizationPrompt,
  AuthorizationPromptOption,
} from '@deepseek-ai/dsh-authorization/types'
import type {
  DesktopCopilotAuthorizationPhase,
  DesktopCopilotAuthorizationPrompt,
  DesktopCopilotAuthorizationModelsResponse,
  DesktopCopilotAuthorizationView,
} from './copilot-authorization-contract.ts'
import { isSameOriginLoopbackRequest } from './desktop-settings-route.ts'

const COPILOT_CREDENTIAL_KEY = credentialKey('llm-pi-ai', 'github-copilot')
const GITHUB_ENTERPRISE_DOMAIN_PROMPT = 'GitHub Enterprise URL/domain (blank for github.com)'
const MAX_BODY_BYTES = 8 * 1024
const MAX_ANSWER_LENGTH = 4096

const COPILOT_HEADERS = {
  'User-Agent': 'GitHubCopilotChat/0.35.0',
  'Editor-Version': 'vscode/1.107.0',
  'Editor-Plugin-Version': 'copilot-chat/0.35.0',
  'Copilot-Integration-Id': 'vscode-chat',
} as const

class UnsupportedCopilotEnterpriseError extends Error {}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function copilotEstimatedCosts(): Map<string, number> {
  const piAiEntry = fileURLToPath(import.meta.resolve('@earendil-works/pi-ai'))
  const catalogPath = join(dirname(piAiEntry), 'providers', 'data', 'github-copilot.json')
  const catalog = asRecord(JSON.parse(readFileSync(catalogPath, 'utf8')) as unknown)
  const costs = new Map<string, number>()
  for (const group of Object.values(catalog ?? {})) {
    for (const value of Object.values(asRecord(group) ?? {})) {
      const model = asRecord(value)
      const cost = asRecord(model?.cost)
      const input = cost?.input
      const output = cost?.output
      if (typeof model?.id !== 'string' || typeof input !== 'number' || !Number.isFinite(input) || input < 0
        || typeof output !== 'number' || !Number.isFinite(output) || output < 0) continue
      costs.set(model.id, input * 0.8 + output * 0.2)
    }
  }
  return costs
}

const COPILOT_HIGH_COST_THRESHOLD = 10
const COPILOT_ESTIMATED_COST_BY_ID = copilotEstimatedCosts()

/** Follow the SDK's proxy-ep convention, but never let credential data choose an arbitrary host. */
function copilotModelsUrl(access: string): string {
  const proxy = /(?:^|;)proxy-ep=([^;]*)/u.exec(access)?.[1]
  if (proxy === undefined) return 'https://api.individual.githubcopilot.com/models'
  if (!/^proxy\.(?:[a-z0-9-]+\.)+githubcopilot\.com$/u.test(proxy)) {
    throw new Error('Untrusted Copilot API endpoint')
  }
  return `https://api.${proxy.slice('proxy.'.length)}/models`
}

async function fetchCopilotJson(url: string, token: string, signal: AbortSignal, models: boolean): Promise<unknown> {
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      ...COPILOT_HEADERS,
      ...(models ? { 'X-GitHub-Api-Version': '2026-06-01' } : {}),
    },
    cache: 'no-store',
    redirect: 'error',
    signal,
  })
  if (!response.ok) throw new Error('Copilot API request failed')
  return response.json() as Promise<unknown>
}

function copilotModels(raw: unknown, availableIds: ReadonlySet<string>, individual: boolean): DesktopCopilotAuthorizationModelsResponse['models'] {
  const data = asRecord(raw)?.data
  if (!Array.isArray(data)) throw new Error('Invalid Copilot models response')
  const entries = data.flatMap((value: unknown) => {
    const item = asRecord(value)
    const id = item?.id
    if (typeof id !== 'string' || id.length === 0 || id.length > 256 || !availableIds.has(id)) return []
    return [{
      id,
      picker: item?.model_picker_enabled === true,
      policy: asRecord(item?.policy)?.state,
      category: item?.model_picker_category,
    }]
  })
  // Match the SDK's all-false Individual fallback across the whole API catalog,
  // not just the stored subset (which may omit a picker-enabled model).
  const pickerAvailable = data.some((value: unknown) => {
    const item = asRecord(value)
    return typeof item?.id === 'string' && item.model_picker_enabled === true
      && asRecord(item.policy)?.state !== 'disabled'
  })
  const seen = new Set<string>()
  return entries.flatMap((item, order) => {
    if (seen.has(item.id) || !(
      (item.picker && item.policy !== 'disabled')
      || (individual && !pickerAvailable && item.policy === 'enabled')
    )) return []
    seen.add(item.id)
    const estimatedCost = COPILOT_ESTIMATED_COST_BY_ID.get(item.id)
    return [{
      order,
      estimatedCost,
      model: {
        id: item.id,
        ...(typeof item.category === 'string' && item.category.length <= 128 ? { category: item.category } : {}),
        ...(estimatedCost !== undefined && estimatedCost >= COPILOT_HIGH_COST_THRESHOLD ? { highCost: true } : {}),
      },
    }]
  }).sort((left, right) => {
    if (left.estimatedCost === undefined) {
      return right.estimatedCost === undefined ? left.order - right.order : 1
    }
    if (right.estimatedCost === undefined) return -1
    return left.estimatedCost - right.estimatedCost || left.order - right.order
  }).map(entry => entry.model)
}

interface PendingPrompt {
  readonly view: DesktopCopilotAuthorizationPrompt
  readonly answer: (value: string) => void
  readonly decline: (cause: Error) => void
  readonly signal?: AbortSignal
  readonly abort?: () => void
}

interface Attempt {
  readonly controller: AbortController
  phase: Exclude<DesktopCopilotAuthorizationPhase, 'idle'>
  notice?: AuthorizationNotice
  prompt?: PendingPrompt
}

export type DesktopCopilotAuthorizationStartResult = 'started' | 'unavailable' | 'busy'
export type DesktopCopilotAuthorizationAnswerResult = 'accepted' | 'stale' | 'invalid'

function boundedText(value: string, maxLength: number): string {
  return value.slice(0, maxLength).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, ' ')
}

function safeNotice(notice: AuthorizationNotice): AuthorizationNotice {
  const url = safeHttpsUrl(notice.url)
  const code = typeof notice.code === 'string' ? boundedText(notice.code, 128) : undefined
  return {
    message: boundedText(notice.message, 1000),
    ...(url === undefined ? {} : { url }),
    ...(code === undefined ? {} : { code }),
  }
}

function safeHttpsUrl(value: string | undefined): string | undefined {
  if (value === undefined || value.length > 2048) return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return undefined
    return url.href
  } catch {
    return undefined
  }
}

function safeOption(option: AuthorizationPromptOption): AuthorizationPromptOption {
  return {
    id: boundedText(option.id, 200),
    label: boundedText(option.label, 300),
    ...(option.description === undefined ? {} : { description: boundedText(option.description, 500) }),
  }
}

function promptView(id: string, prompt: AuthorizationPrompt): DesktopCopilotAuthorizationPrompt {
  const base = { id, kind: prompt.kind, message: boundedText(prompt.message, 1000) }
  if (prompt.kind === 'select') {
    return { ...base, options: prompt.options.slice(0, 100).map(safeOption) }
  }
  return {
    ...base,
    ...(prompt.placeholder === undefined ? {} : { placeholder: boundedText(prompt.placeholder, 300) }),
  }
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key))
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const declaredLength = req.headers['content-length']
  if (declaredLength !== undefined) {
    if (!/^\d+$/u.test(declaredLength)) throw new SyntaxError('invalid content length')
    if (Number(declaredLength) > MAX_BODY_BYTES) throw new RangeError('request body too large')
  }
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    size += buffer.byteLength
    if (size > MAX_BODY_BYTES) throw new RangeError('request body too large')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

function finishJson(res: ServerResponse, statusCode: number, value: object, allow?: string): void {
  res.statusCode = statusCode
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('x-content-type-options', 'nosniff')
  if (allow !== undefined) res.setHeader('allow', allow)
  res.end(JSON.stringify(value))
}

async function readPostBody(req: IncomingMessage, res: ServerResponse): Promise<unknown | undefined> {
  if (req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    finishJson(res, 415, { error: 'content type must be application/json' })
    return undefined
  }
  try {
    return await readJson(req)
  } catch (cause) {
    const tooLarge = cause instanceof RangeError
    finishJson(res, tooLarge ? 413 : 400, { error: tooLarge ? 'request body is too large' : 'invalid JSON request' })
    return undefined
  }
}

/** Desktop's narrow renderer bridge to the existing Copilot authorization flow. */
export class DesktopCopilotAuthorizationController {
  private attempt: Attempt | undefined

  constructor(
    private readonly authorization: AuthorizationService,
    private readonly credentials: CredentialProvider,
  ) {}

  async read(): Promise<DesktopCopilotAuthorizationView> {
    const [entry, credential] = await Promise.all([
      Promise.resolve(this.authorization.describe(COPILOT_CREDENTIAL_KEY)),
      this.credentials.describeRecord(COPILOT_CREDENTIAL_KEY),
    ])
    const oauth = entry?.methods.find(method => method.id === 'oauth')
    const attempt = this.attempt
    const phase = attempt?.phase === 'authorized' && !credential.configured
      ? 'idle'
      : attempt?.phase ?? (entry?.inFlight ? 'authorizing' : 'idle')
    const view: DesktopCopilotAuthorizationView = {
      available: oauth !== undefined,
      configured: credential.configured,
      phase,
      canCancel: attempt?.phase === 'authorizing' && !attempt.controller.signal.aborted,
      methods: oauth === undefined ? [] : [{ id: 'oauth', label: boundedText(oauth.label, 300) }],
      ...(attempt?.notice === undefined ? {} : { notice: attempt.notice }),
      ...(attempt?.prompt === undefined ? {} : { prompt: attempt.prompt.view }),
      ...(phase === 'failed' ? { error: 'GitHub Copilot sign-in failed. Please try again.' } : {}),
    }
    return view
  }

  async readModels(): Promise<DesktopCopilotAuthorizationModelsResponse> {
    const record = await this.credentials.readRecord(COPILOT_CREDENTIAL_KEY)
    if (record === undefined) return { models: [], configured: false }
    const payload = record.kind === 'grant' ? asRecord(record.payload) : undefined
    if (payload?.enterpriseUrl !== undefined && payload.enterpriseUrl !== '') {
      throw new UnsupportedCopilotEnterpriseError('GitHub Enterprise Copilot models are not supported')
    }
    const available = payload?.availableModelIds
    if (!Array.isArray(available) || !available.every(id => typeof id === 'string')) {
      throw new Error('Copilot model availability is not configured')
    }
    const availableIds = new Set<string>(available)
    if (availableIds.size === 0) return { models: [], configured: true }

    const signal = AbortSignal.timeout(5000)
    let access = payload?.access
    if (typeof payload?.expires === 'number' && payload.expires <= Date.now()) {
      if (typeof payload.refresh !== 'string' || payload.refresh.length === 0) {
        throw new Error('Copilot sign-in expired')
      }
      // SDK refreshes via api.github.com for github.com accounts. Use the fresh token
      // only for this read; never replace the stored grant or its available IDs.
      const refreshed = asRecord(await fetchCopilotJson(
        'https://api.github.com/copilot_internal/v2/token', payload.refresh, signal, false,
      ))
      access = refreshed?.token
    }
    if (typeof access !== 'string' || access.length === 0) throw new Error('Copilot sign-in required')
    const url = copilotModelsUrl(access)
    const raw = await fetchCopilotJson(url, access, signal, true)
    return { models: copilotModels(raw, availableIds, url === 'https://api.individual.githubcopilot.com/models'), configured: true }
  }

  start(): DesktopCopilotAuthorizationStartResult {
    const entry = this.authorization.describe(COPILOT_CREDENTIAL_KEY)
    if (entry?.methods.some(method => method.id === 'oauth') !== true) return 'unavailable'
    if (this.attempt?.phase === 'authorizing' || entry.inFlight) return 'busy'

    const attempt: Attempt = { controller: new AbortController(), phase: 'authorizing' }
    this.attempt = attempt
    void this.run(attempt)
    return 'started'
  }

  answer(promptId: string, answer: string): DesktopCopilotAuthorizationAnswerResult {
    const pending = this.attempt?.prompt
    if (pending === undefined || pending.view.id !== promptId) return 'stale'
    if (answer.length > MAX_ANSWER_LENGTH) return 'invalid'
    if (pending.view.kind === 'select'
      && pending.view.options?.some(option => option.id === answer) !== true) return 'invalid'
    this.clearPrompt(pending)
    pending.answer(answer)
    return 'accepted'
  }

  cancel(): boolean {
    const attempt = this.attempt
    if (attempt?.phase !== 'authorizing') return false
    if (attempt.prompt !== undefined) {
      const pending = attempt.prompt
      this.clearPrompt(pending)
      pending.decline(new Error('authorization prompt withdrawn'))
    }
    attempt.controller.abort()
    return true
  }

  private async run(attempt: Attempt): Promise<void> {
    try {
      const outcome = await this.authorization.begin({
        key: COPILOT_CREDENTIAL_KEY,
        method: 'oauth',
        signal: attempt.controller.signal,
        interaction: {
          notify: notice => {
            if (this.attempt === attempt && attempt.phase === 'authorizing') {
              attempt.notice = safeNotice(notice)
            }
          },
          prompt: prompt => prompt.kind === 'text' && prompt.message === GITHUB_ENTERPRISE_DOMAIN_PROMPT
            ? Promise.resolve('')
            : this.waitForPrompt(attempt, prompt),
        },
      })
      if (this.attempt === attempt) attempt.phase = outcome.status === 'authorized' ? 'authorized' : 'cancelled'
    } catch {
      if (this.attempt === attempt) attempt.phase = attempt.controller.signal.aborted ? 'cancelled' : 'failed'
    } finally {
      if (attempt.prompt !== undefined) {
        const pending = attempt.prompt
        this.clearPrompt(pending)
        pending.decline(new Error('authorization attempt ended'))
      }
    }
  }

  private waitForPrompt(attempt: Attempt, prompt: AuthorizationPrompt): Promise<string> {
    const id = randomUUID()
    return new Promise<string>((resolve, reject) => {
      const pending: PendingPrompt = {
        view: promptView(id, prompt),
        answer: resolve,
        decline: reject,
        ...(prompt.signal === undefined ? {} : { signal: prompt.signal }),
      }
      if (prompt.signal?.aborted) {
        reject(new Error('authorization prompt withdrawn'))
        return
      }
      if (prompt.signal !== undefined) {
        const abort = (): void => {
          if (attempt.prompt !== pending) return
          this.clearPrompt(pending)
          reject(new Error('authorization prompt withdrawn'))
        }
        Object.assign(pending, { abort })
        prompt.signal.addEventListener('abort', abort, { once: true })
      }
      attempt.prompt = pending
    })
  }

  private clearPrompt(pending: PendingPrompt): void {
    if (this.attempt?.prompt === pending) delete this.attempt.prompt
    if (pending.signal !== undefined && pending.abort !== undefined) {
      pending.signal.removeEventListener('abort', pending.abort)
    }
  }
}

/** Read the renderer-safe Copilot authorization status. */
export async function handleDesktopCopilotAuthorizationReadRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedOrigin: string,
  controller: DesktopCopilotAuthorizationController,
): Promise<void> {
  if (req.method !== 'GET') return finishJson(res, 405, { error: 'method not allowed' }, 'GET')
  if (!isSameOriginLoopbackRequest(req, expectedOrigin, false)) return finishJson(res, 403, { error: 'forbidden' })
  try {
    finishJson(res, 200, await controller.read())
  } catch {
    finishJson(res, 503, { error: 'Copilot authorization status unavailable' })
  }
}

/** Read only the account's eligible model categories, never its stored tokens. */
export async function handleDesktopCopilotAuthorizationModelsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedOrigin: string,
  controller: DesktopCopilotAuthorizationController,
): Promise<void> {
  if (req.method !== 'GET') return finishJson(res, 405, { error: 'method not allowed' }, 'GET')
  if (!isSameOriginLoopbackRequest(req, expectedOrigin, false)) return finishJson(res, 403, { error: 'forbidden' })
  try {
    finishJson(res, 200, await controller.readModels())
  } catch (cause) {
    finishJson(res, cause instanceof UnsupportedCopilotEnterpriseError ? 422 : 503, {
      error: cause instanceof UnsupportedCopilotEnterpriseError
        ? 'GitHub Enterprise Copilot models are not supported'
        : 'Copilot model categories unavailable. Please sign in again or retry.',
    })
  }
}

/** Begin the fixed GitHub Copilot OAuth method. */
export async function handleDesktopCopilotAuthorizationBeginRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedOrigin: string,
  controller: DesktopCopilotAuthorizationController,
): Promise<void> {
  if (req.method !== 'POST') return finishJson(res, 405, { error: 'method not allowed' }, 'POST')
  if (!isSameOriginLoopbackRequest(req, expectedOrigin, true)) return finishJson(res, 403, { error: 'forbidden' })
  const value = await readPostBody(req, res)
  if (value === undefined) return
  if (!isExactRecord(value, [])) return finishJson(res, 400, { error: 'invalid Copilot authorization request' })
  const result = controller.start()
  if (result === 'started') return finishJson(res, 202, { accepted: true })
  if (result === 'busy') return finishJson(res, 409, { error: 'Copilot authorization is already in progress' })
  return finishJson(res, 503, { error: 'GitHub Copilot sign-in is unavailable' })
}

/** Deliver one typed answer to the active flow prompt without persisting it. */
export async function handleDesktopCopilotAuthorizationAnswerRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedOrigin: string,
  controller: DesktopCopilotAuthorizationController,
): Promise<void> {
  if (req.method !== 'POST') return finishJson(res, 405, { error: 'method not allowed' }, 'POST')
  if (!isSameOriginLoopbackRequest(req, expectedOrigin, true)) return finishJson(res, 403, { error: 'forbidden' })
  const value = await readPostBody(req, res)
  if (value === undefined) return
  if (!isExactRecord(value, ['promptId', 'answer'])
    || typeof value.promptId !== 'string' || value.promptId.length > 64
    || typeof value.answer !== 'string' || value.answer.length > MAX_ANSWER_LENGTH) {
    return finishJson(res, 400, { error: 'invalid Copilot prompt answer' })
  }
  const result = controller.answer(value.promptId, value.answer)
  if (result === 'accepted') return finishJson(res, 200, { accepted: true })
  if (result === 'stale') return finishJson(res, 409, { error: 'Copilot prompt is no longer active' })
  return finishJson(res, 400, { error: 'invalid Copilot prompt answer' })
}

/** Cancel only the authorization attempt owned by this Desktop surface. */
export async function handleDesktopCopilotAuthorizationCancelRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedOrigin: string,
  controller: DesktopCopilotAuthorizationController,
): Promise<void> {
  if (req.method !== 'POST') return finishJson(res, 405, { error: 'method not allowed' }, 'POST')
  if (!isSameOriginLoopbackRequest(req, expectedOrigin, true)) return finishJson(res, 403, { error: 'forbidden' })
  const value = await readPostBody(req, res)
  if (value === undefined) return
  if (!isExactRecord(value, [])) return finishJson(res, 400, { error: 'invalid Copilot authorization request' })
  const cancelled = controller.cancel()
  return finishJson(res, cancelled ? 202 : 409, { accepted: cancelled })
}
