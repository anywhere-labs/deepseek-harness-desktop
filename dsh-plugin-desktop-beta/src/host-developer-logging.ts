/** Observe official Host waterfalls without recording business payloads or changing results. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { developerLoggingEnabled, diagnosticLog, diagnosticOperation } from './developer-logging.ts'
import { recordOfficialInspector, recordOfficialPluginInventory } from './official-diagnostics.ts'
export function installHostDeveloperLogging(ctx: Context): void {
  ctx.inject(['inspector'], child => {
    if (developerLoggingEnabled()) void recordOfficialInspector(child, diagnosticLog)
  })
  ctx.on('internal/status', fiber => {
    if (developerLoggingEnabled() && fiber.entry) void recordOfficialPluginInventory(ctx, diagnosticLog, fiber.entry.id)
  })
  ctx.on('agent/request-error', async ({ agent, turn, step, provider, failure }, next) => {
    diagnosticLog({ source: 'host.llm', event: 'request.attempt-failed', level: 'warn', fields: {
      sessionId: String(agent.id), turn, step, provider, failureCode: failure.code }, developer: true })
    const action = await next()
    diagnosticLog({ source: 'host.llm', event: 'request.retry-decision', fields: { sessionId: String(agent.id), turn, step,
      retry: action?.kind === 'retry' }, developer: true })
    return action
  })
  ctx.on('llm/stream', async function* (options, next) {
    const end = diagnosticOperation('host.llm', 'request', { provider: options.provider, model: options.model,
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
    const end = diagnosticOperation('host.tools', 'execute', { callId: String(exec.callId), rootCallId: String(exec.rootCallId),
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
        diagnosticLog({ source: 'host.session', event: event.type, fields: { ...coordinates, turn: event.data.turn,
          ...('step' in event.data ? { step: event.data.step } : {}),
          ...('reason' in event.data ? { outcome: event.data.reason.kind } : {}) }, developer: true })
      }
      if (event.type === 'assistant/attempt' || event.type === 'assistant/message') {
        diagnosticLog({ source: 'host.session', event: event.type, fields: { ...coordinates,
          turn: event.data.turn, step: event.data.step, streamRecords: event.data.stream.length }, developer: true })
      }
      if (event.type === 'tool/call') diagnosticLog({ source: 'host.session', event: event.type,
        fields: { ...coordinates, turn: event.data.turn, step: event.data.step,
          callId: String(event.data.callId), tool: event.data.name }, developer: true })
      if (event.type === 'tool/result') diagnosticLog({ source: 'host.session', event: event.type,
        level: event.data.message.isError ? 'error' : 'info', developer: !event.data.message.isError,
        fields: { ...coordinates, turn: event.data.turn, step: event.data.step,
          callId: String(event.data.message.toolCallId), isError: event.data.message.isError ?? false,
          failureCode: event.data.error?.code ?? null } })
    })
  })
}
/** Snapshot after settings are readable so initial plugin state is included when enabled. */
export function auditHostDeveloperPlugins(ctx: Context): void {
  if (!developerLoggingEnabled()) return
  void recordOfficialPluginInventory(ctx, diagnosticLog)
  void recordOfficialInspector(ctx, diagnosticLog)
}
