import { WORKBENCH_API_PREFIX } from '../workbench-settings.ts'

export interface LocalModelProbeView {
  readonly id: string
  readonly displayName: string
  readonly origin: string
  readonly running: boolean
  readonly started: boolean
  readonly models: readonly { readonly id: string; readonly name: string }[]
  readonly error?: string
}

export interface HomeMigrationPreviewView {
  readonly source: string
  readonly target: string
  readonly token: string
  readonly domains: readonly {
    readonly domain: string
    readonly sourcePresent: boolean
    readonly targetPresent: boolean
    readonly sourceEntries: number
    readonly targetEntries: number
    readonly conflicts: readonly string[]
    readonly sourceNamespaces?: readonly string[]
  }[]
}

export interface HomeMigrationApplyView {
  readonly source: string
  readonly target: string
  readonly copied: readonly string[]
  readonly preserved: readonly string[]
  readonly skipped: readonly string[]
}

async function readJson<T>(response: Response): Promise<T> {
  const value = await response.json() as T & { error?: unknown }
  if (!response.ok) {
    throw new Error(typeof value.error === 'string' ? value.error : `request failed: ${response.status}`)
  }
  return value
}

async function postJson<T>(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  return await readJson<T>(await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  }))
}

/** Probe built-in or custom loopback OpenAI-compatible runtimes. */
export async function scanLocalModels(
  input: { readonly id?: string; readonly origin?: string } = {},
  signal?: AbortSignal,
): Promise<readonly LocalModelProbeView[]> {
  const response = await postJson<{ results: LocalModelProbeView[] }>(
    `${WORKBENCH_API_PREFIX}/models/scan`,
    input,
    signal,
  )
  return response.results
}

/** Start a supported runtime only when it is not already listening. */
export async function startLocalModel(
  input: { readonly id?: string; readonly origin?: string },
  signal?: AbortSignal,
): Promise<LocalModelProbeView> {
  const response = await postJson<{ result: LocalModelProbeView }>(
    `${WORKBENCH_API_PREFIX}/models/start`,
    input,
    signal,
  )
  return response.result
}

/** Write a discovered provider into official llm-pi-ai settings. No token is stored. */
export async function applyLocalModel(
  input: { readonly id?: string; readonly origin?: string },
  signal?: AbortSignal,
): Promise<LocalModelProbeView> {
  const response = await postJson<{ result: LocalModelProbeView }>(
    `${WORKBENCH_API_PREFIX}/models/apply`,
    input,
    signal,
  )
  return response.result
}

/** Preview a source DSH home against the current home. */
export async function previewHomeMigrationSource(
  source: string,
  signal?: AbortSignal,
): Promise<HomeMigrationPreviewView> {
  return await postJson<HomeMigrationPreviewView>(`${WORKBENCH_API_PREFIX}/home/preview`, { source }, signal)
}

/** Merge a previewed source home after the user repeats the preview token. */
export async function applyHomeMigrationSource(
  source: string,
  token: string,
  signal?: AbortSignal,
): Promise<HomeMigrationApplyView> {
  return await postJson<HomeMigrationApplyView>(
    `${WORKBENCH_API_PREFIX}/home/apply`,
    { source, token },
    signal,
  )
}

export interface RemoteStatusView {
  readonly enabled: boolean
  readonly trustedHost: string
  readonly loopbackOrigin: string
  readonly pixelStreaming: false
  readonly home: string
}

/** Read the default-off remote control-plane status. */
export async function readRemoteStatus(signal?: AbortSignal): Promise<RemoteStatusView> {
  return await readJson<RemoteStatusView>(await fetch(`${WORKBENCH_API_PREFIX}/status`, {
    cache: 'no-store',
    ...(signal === undefined ? {} : { signal }),
  }))
}
