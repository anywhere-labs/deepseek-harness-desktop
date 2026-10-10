/** Observe official logging and event seams without changing their results or stream lifetime. */
import { recordOfficialInspector, recordOfficialPluginInventory } from './official-diagnostics.ts'
import { randomUUID } from 'node:crypto'
import { Logger, type Context, type Exporter, type Message } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { HOST_LOG_PREFIX, LOG_LEVELS, sanitize, type LogInput } from '../log-record.ts'
import type { DesktopPreferences } from '../desktop-contract.ts'

let preferences: Pick<DesktopPreferences, 'developerLogging' | 'logLevel'> = { developerLogging: false, logLevel: 'info' }
let loggingContext: Context | undefined
let blocked = false
let dropped = 0
export function configureHostLogging(value: Pick<DesktopPreferences, 'developerLogging' | 'logLevel'>): void {
  const enabled = value.developerLogging && !preferences.developerLogging
  preferences = value
  if (enabled && loggingContext) auditHostPlugins(loggingContext)
}
export function hostLog(input: LogInput): void {
  if (input.developer && !preferences.developerLogging) return
  if (input.developer && LOG_LEVELS.indexOf(input.level ?? 'info') < LOG_LEVELS.indexOf(preferences.logLevel)) return
  try {
    if (blocked) { dropped++; return }
    const line = HOST_LOG_PREFIX + JSON.stringify(sanitize({ ...input, pid: process.pid })) + '\n'
    if (!process.stdout.write(line)) {
      blocked = true
      process.stdout.once('drain', () => {
        blocked = false
        const count = dropped; dropped = 0
        if (count) hostLog({ source: 'host.logging', event: 'records.dropped', level: 'warn', fields: { count } })
      })
    }
  } catch { /* Diagnostics must never change the observed application. */ }
}

export function hostOperation(source: string, event: string, fields?: LogInput['fields'], developer = false) {
  const operationId = randomUUID()
  const started = Date.now()
  hostLog({ source, event: `${event}.start`, fields, operationId, developer })
  let finished = false
  return (error?: unknown, result?: LogInput['fields']) => {
    if (finished) return
    finished = true
    hostLog({ source, event: `${event}.${error === undefined ? 'complete' : 'failed'}`, operationId,
      fields: { ...fields, ...result, durationMs: Date.now() - started },
      level: error === undefined ? 'info' : 'error', developer: error === undefined && developer, error })
  }
}

class KernelExporter implements Exporter {
  colors = false as const
  maxLength = 16384
  levels = { default: 3 }
  formatters = {}
  export(message: Message): void {
    try {
      if (LOG_LEVELS.indexOf(message.type) < LOG_LEVELS.indexOf(preferences.logLevel) && message.type !== 'error') return
      hostLog({ source: `host.kernel.${message.name}`, event: 'log', level: message.type,
        message: Logger.format(this, message), developer: message.type === 'debug',
        fields: { hostTime: message.ts, hostSequence: message.sn, pluginId: message.fiber?.deref()?.entry?.id } })
    } catch { /* A malformed plugin log is not an application failure. */ }
  }
}

export function auditHostPlugins(ctx: Context): void {
  if (!preferences.developerLogging) return
  void recordOfficialPluginInventory(ctx, hostLog)
  void recordOfficialInspector(ctx, hostLog)
}

/** Resources follow the capabilities fiber across reload and shutdown. */
export function installHostLogging(ctx: Context): void {
  loggingContext = ctx
  ctx.effect(() => () => { if (loggingContext === ctx) loggingContext = undefined }, 'Next logging context')
  ctx.inject(['inspector'], child => {
    if (preferences.developerLogging) void recordOfficialInspector(child, hostLog)
  })
  const exporter = new KernelExporter()
  ctx.logger.exporter(exporter)
  // The runner has no pre-mount hook. Replay its bounded buffer and audit the settled graph.
  for (const message of ctx.logger.buffer) exporter.export(message)
  ctx.on('internal/status', fiber => {
    if (preferences.developerLogging && fiber.entry) void recordOfficialPluginInventory(ctx, hostLog, fiber.entry.id)
  })
  ctx.on('agent/error', ({ agent, turn, step, error }) => hostLog({ source: 'host.agent', event: 'agent.failed',
    level: 'error', fields: { sessionId: String(agent.id), turn, step }, error }))
  ctx.on('agent/request-error', async ({ agent, turn, step, provider, failure }, next) => {
    hostLog({ source: 'host.llm', event: 'request.attempt-failed', level: 'warn', fields: {
      sessionId: String(agent.id), turn, step, provider, failureCode: failure.code }, developer: true })
    const action = await next()
    hostLog({ source: 'host.llm', event: 'request.retry-decision', fields: { sessionId: String(agent.id), turn, step,
      retry: action?.kind === 'retry' }, developer: true })
    return action
  })
  ctx.on('llm/stream', async function* (options, next) {
    const end = hostOperation('host.llm', 'request', { provider: options.provider, model: options.model,
      sessionId: options.sessionId ? String(options.sessionId) : null, purpose: options.purpose ?? null,
      messageCount: options.messages.length, toolCount: options.tools?.length ?? 0 }, true)
    let outcome = 'consumer-closed'
    let chunks = 0
    let failed = false
    try {
      for await (const chunk of next()) { chunks++; yield chunk }
      outcome = options.signal?.aborted ? 'cancelled' : 'completed'
    } catch (error) { failed = true; end(error, { outcome: options.signal?.aborted ? 'cancelled' : 'failed', chunks }); throw error }
    finally { if (!failed) end(undefined, { outcome, chunks }) }
  })
  ctx.on('tools/execute', async (exec, next) => {
    const end = hostOperation('host.tools', 'execute', { callId: String(exec.callId), rootCallId: String(exec.rootCallId),
      tool: exec.name, sessionId: exec.agent ? String(exec.agent.id) : null }, true)
    try {
      const result = await next()
      if (result.isError) end(new Error(result.error.message), { failureCode: result.error.info?.code ?? null, cancelled: exec.signal.aborted })
      else end(undefined, { cancelled: exec.signal.aborted, contentBlocks: result.content.length })
      return result
    } catch (error) { end(error); throw error }
  })
  ctx.inject(['sessions'], child => {
    child.on('session/event', (session, event) => {
      const coordinates = { sessionId: String(session.header.id), sessionEventType: event.type,
        sessionSequence: event.seq, sessionTime: event.time }
      if (event.type === 'turn/start' || event.type === 'turn/end' || event.type === 'step/start' || event.type === 'step/end') {
        hostLog({ source: 'host.session', event: event.type, fields: { ...coordinates, turn: event.data.turn,
          ...('step' in event.data ? { step: event.data.step } : {}),
          ...('reason' in event.data ? { outcome: event.data.reason.kind } : {}) }, developer: true })
      }
      if (event.type === 'assistant/attempt' || event.type === 'assistant/message') {
        hostLog({ source: 'host.session', event: event.type, fields: { ...coordinates,
          turn: event.data.turn, step: event.data.step, streamRecords: event.data.stream.length }, developer: true })
      }
      if (event.type === 'tool/call') hostLog({ source: 'host.session', event: event.type,
        fields: { ...coordinates, turn: event.data.turn, step: event.data.step,
          callId: String(event.data.callId), tool: event.data.name }, developer: true })
      if (event.type === 'tool/result') hostLog({ source: 'host.session', event: event.type,
        level: event.data.message.isError ? 'error' : 'info', developer: !event.data.message.isError,
        fields: { ...coordinates, turn: event.data.turn, step: event.data.step,
          callId: String(event.data.message.toolCallId), isError: event.data.message.isError ?? false,
          failureCode: event.data.error?.code ?? null } })
    })
  })
}
