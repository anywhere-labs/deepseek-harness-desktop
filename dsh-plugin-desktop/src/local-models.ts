/** Loopback OpenAI-compatible discovery. Never ships tokens or takes over a running service. */

import { LOCAL_MODEL_API_KEY_ENV } from './workbench-settings.ts'

/** One supported loopback runtime the Host can probe or optionally start. */
export interface LocalModelTarget {
  readonly id: string
  readonly displayName: string
  readonly origin: string
  readonly modelsPath: string
  readonly tagsPath?: string
  readonly startCommand: string
  readonly startArgs: readonly string[]
}

/** Built-in Ollama and LM Studio loopback targets. Custom origins stay user-supplied. */
export const LOCAL_MODEL_TARGETS: readonly LocalModelTarget[] = Object.freeze([
  {
    id: 'ollama',
    displayName: 'Ollama',
    origin: 'http://127.0.0.1:11434',
    modelsPath: '/v1/models',
    tagsPath: '/api/tags',
    startCommand: 'ollama',
    startArgs: Object.freeze(['serve']),
  },
  {
    id: 'lmstudio',
    displayName: 'LM Studio',
    origin: 'http://127.0.0.1:1234',
    modelsPath: '/v1/models',
    startCommand: 'lms',
    startArgs: Object.freeze(['server', 'start']),
  },
])

/** One model id discovered on a loopback runtime. */
export interface DiscoveredLocalModel {
  readonly id: string
  readonly name: string
}

/** Result of probing one loopback OpenAI-compatible origin. */
export interface LocalModelProbeResult {
  readonly id: string
  readonly displayName: string
  readonly origin: string
  readonly running: boolean
  readonly started: boolean
  readonly models: readonly DiscoveredLocalModel[]
  readonly error?: string
}

/** Provider row written into `llm-pi-ai.providers` after the user applies a probe. */
export interface LocalModelProviderConfig {
  readonly displayName: string
  readonly api: 'openai-completions'
  readonly baseURL: string
  readonly apiKeyEnv: typeof LOCAL_MODEL_API_KEY_ENV
  readonly models: readonly { readonly id: string; readonly name: string }[]
}

export type LocalModelFetch = (url: string, init: RequestInit) => Promise<Response>

export type LocalModelCommandExists = (command: string) => boolean

export type LocalModelSpawn = (
  command: string,
  args: readonly string[],
) => void

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost'])

/**
 * Reject anything that is not a loopback http(s) origin.
 * Discovery must never leave the machine.
 */
export function assertLoopbackOrigin(value: string): URL {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('local model origin must be an http(s) URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('local model origin must use http or https')
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error('local model origin must be 127.0.0.1 or localhost')
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error('local model origin must not include credentials')
  }
  return parsed
}

function readModelList(value: unknown): DiscoveredLocalModel[] {
  if (!value || typeof value !== 'object') return []
  const record = value as { data?: unknown; models?: unknown }
  const rows = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : []
  const models: DiscoveredLocalModel[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const entry = row as { id?: unknown; name?: unknown; model?: unknown }
    const id = typeof entry.id === 'string'
      ? entry.id
      : typeof entry.name === 'string'
        ? entry.name
        : typeof entry.model === 'string'
          ? entry.model
          : ''
    if (id.length === 0 || seen.has(id)) continue
    seen.add(id)
    const name = typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : id
    models.push({ id, name })
  }
  return models
}

async function getJson(
  fetchImpl: LocalModelFetch,
  url: string,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`probe failed: ${String(response.status)}`)
    return await response.json() as unknown
  } finally {
    clearTimeout(timer)
  }
}

/** Probe one loopback runtime. A failed probe is a result, not a throw. */
export async function probeLocalModelRuntime(
  target: LocalModelTarget,
  fetchImpl: LocalModelFetch = fetch,
  timeoutMs = 1_500,
): Promise<LocalModelProbeResult> {
  assertLoopbackOrigin(target.origin)
  try {
    const modelsUrl = new URL(target.modelsPath, `${target.origin}/`).href
    const payload = await getJson(fetchImpl, modelsUrl, timeoutMs)
    let models = readModelList(payload)
    if (models.length === 0 && target.tagsPath !== undefined) {
      const tagsUrl = new URL(target.tagsPath, `${target.origin}/`).href
      models = readModelList(await getJson(fetchImpl, tagsUrl, timeoutMs))
    }
    return {
      id: target.id,
      displayName: target.displayName,
      origin: target.origin,
      running: true,
      started: false,
      models,
    }
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    return {
      id: target.id,
      displayName: target.displayName,
      origin: target.origin,
      running: false,
      started: false,
      models: [],
      error: detail,
    }
  }
}

/**
 * Start a supported runtime only when it is not already listening.
 * Never kills or reconfigures a process that answered the probe.
 */
export async function startLocalModelRuntime(
  target: LocalModelTarget,
  options: {
    readonly fetchImpl?: LocalModelFetch
    readonly commandExists?: LocalModelCommandExists
    readonly spawn?: LocalModelSpawn
    readonly timeoutMs?: number
    readonly waitMs?: number
  } = {},
): Promise<LocalModelProbeResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 1_500
  const existing = await probeLocalModelRuntime(target, fetchImpl, timeoutMs)
  if (existing.running) return existing
  const commandExists = options.commandExists ?? (() => false)
  const spawn = options.spawn
  if (spawn === undefined || !commandExists(target.startCommand)) {
    return { ...existing, error: existing.error ?? 'runtime is not installed' }
  }
  spawn(target.startCommand, target.startArgs)
  if (options.waitMs !== undefined && options.waitMs > 0) {
    await new Promise(resolve => setTimeout(resolve, options.waitMs))
  }
  const next = await probeLocalModelRuntime(target, fetchImpl, timeoutMs)
  return { ...next, started: next.running }
}

/** Map a successful probe onto the official llm-pi-ai provider shape. No token is stored. */
export function createLocalModelProviderConfig(probe: LocalModelProbeResult): LocalModelProviderConfig {
  if (!probe.running) throw new Error(`local runtime "${probe.id}" is not running`)
  const origin = assertLoopbackOrigin(probe.origin)
  const baseURL = new URL('v1', `${origin.origin}/`).href.replace(/\/$/u, '')
  return {
    displayName: probe.displayName,
    api: 'openai-completions',
    baseURL,
    apiKeyEnv: LOCAL_MODEL_API_KEY_ENV,
    models: probe.models.map(model => ({ id: model.id, name: model.name })),
  }
}

/** Merge one discovered provider into an existing llm-pi-ai providers map. */
export function mergeLocalModelProvider(
  existing: Record<string, unknown>,
  providerId: string,
  config: LocalModelProviderConfig,
): Record<string, unknown> {
  if (providerId.trim().length === 0) throw new Error('local model provider id must not be empty')
  return {
    ...existing,
    [providerId]: {
      displayName: config.displayName,
      api: config.api,
      baseURL: config.baseURL,
      apiKeyEnv: config.apiKeyEnv,
      models: config.models.map(model => ({ id: model.id, name: model.name })),
    },
  }
}

/** Resolve a built-in target or a user-supplied loopback origin. */
export function resolveLocalModelTarget(input: {
  readonly id?: string
  readonly origin?: string
}): LocalModelTarget {
  if (typeof input.origin === 'string' && input.origin.length > 0) {
    const origin = assertLoopbackOrigin(input.origin).origin
    const builtIn = LOCAL_MODEL_TARGETS.find(target => target.origin === origin)
    if (builtIn !== undefined) return builtIn
    return {
      id: typeof input.id === 'string' && input.id.length > 0 ? input.id : 'custom',
      displayName: 'Custom loopback',
      origin,
      modelsPath: '/v1/models',
      startCommand: '',
      startArgs: [],
    }
  }
  const match = LOCAL_MODEL_TARGETS.find(target => target.id === input.id)
  if (match === undefined) throw new Error('unknown local model target')
  return match
}
