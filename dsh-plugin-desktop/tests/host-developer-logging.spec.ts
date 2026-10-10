import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { configureDeveloperLogging, initializeDeveloperLogging } from '../src/developer-logging.ts'
import { installHostDeveloperLogging } from '../src/host-developer-logging.ts'

const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  configureDeveloperLogging({ developerLogging: false, logLevel: 'info' })
  initializeDeveloperLogging(() => {})
  vi.restoreAllMocks()
})
async function environment(developerLogging = true) {
  configureDeveloperLogging({ developerLogging, logLevel: 'debug' })
  const written: string[] = []
  initializeDeveloperLogging((_level, line) => { written.push(line) }, 'test-run')
  const ctx = new Context(); contexts.push(ctx)
  const fiber = ctx.plugin({ name: 'test-next-logging', apply: installHostDeveloperLogging })
  await fiber.await()
  expect(fiber.state).toBe(2)
  const records = () => written.map(line => JSON.parse(line))
  // Deliberately partial business payloads: exercise the real bus and observers without starting services.
  const dispatch = ctx.waterfall.bind(ctx) as (...args: any[]) => any
  return { ctx, fiber, records, dispatch }
}

it('observes model streams without logging messages or modifying yielded chunks', async () => {
  const { records, dispatch } = await environment()
  const options = { provider: 'test', model: 'example', sessionId: 'session-a', messages: [{ role: 'user', content: 'private prompt' }] }
  const chunks = [{ type: 'text', text: 'private response' }, { type: 'end' }]
  const stream = dispatch('llm/stream', options, async function* () { yield* chunks })
  const result = []
  for await (const chunk of stream) result.push(chunk)
  expect(result).toEqual(chunks)
  const request = records().filter(record => record.source === 'host.llm')
  expect(request).toHaveLength(2)
  expect(request[0].operationId).toBe(request[1].operationId)
  expect(request[1]).toMatchObject({ event: 'request.complete', fields: { chunks: 2, outcome: 'completed', sessionId: 'session-a' } })
  expect(JSON.stringify(request)).not.toContain('private prompt')
  expect(JSON.stringify(request)).not.toContain('private response')
})

it('keeps stream errors and early-consumer cancellation semantics intact', async () => {
  const { records, dispatch } = await environment()
  const options = { provider: 'test', model: 'example', messages: [] }
  const failure = new Error('network failed', { cause: new Error('socket closed') })
  const failed = dispatch('llm/stream', options, async function* () { throw failure })
  await expect(failed.next()).rejects.toBe(failure)
  expect(records().at(-1)).toMatchObject({ event: 'request.failed', error: { cause: { message: 'socket closed' } } })
  const disposed = vi.fn()
  const stream = dispatch('llm/stream', options, async function* () { try { yield { type: 'text', text: 'hidden' }; yield {} } finally { disposed() } })
  await stream.next(); await stream.return()
  expect(disposed).toHaveBeenCalledOnce()
  expect(records().at(-1)).toMatchObject({ event: 'request.complete', fields: { outcome: 'consumer-closed' } })
})

it('returns the identical tool result while recording execution metadata without arguments and content', async () => {
  const { records, dispatch } = await environment()
  const exec = { callId: 'call-a', rootCallId: 'call-a', name: 'bash', agent: { id: 'session-a' }, arguments: { command: 'private command' }, signal: new AbortController().signal }
  const result = { isError: false, value: 'private value', content: [{ type: 'text', text: 'private output' }] }
  await expect(dispatch('tools/execute', exec, async () => result)).resolves.toBe(result)
  const events = records().filter(record => record.source === 'host.tools')
  expect(events[1]).toMatchObject({ event: 'execute.complete', fields: { callId: 'call-a', sessionId: 'session-a', contentBlocks: 1 } })
  expect(events[0].operationId).toBe(events[1].operationId)
  expect(JSON.stringify(events)).not.toContain('private')
})

it('keeps failed tool outcomes and errors visible when developer logging is disabled', async () => {
  const { records, dispatch } = await environment(false)
  const exec = { callId: 'call-a', rootCallId: 'call-a', name: 'bash', signal: new AbortController().signal }
  const failure = { isError: true, error: { message: 'failed', info: { code: 'ABORTED' } }, content: [] }
  await expect(dispatch('tools/execute', exec, async () => failure)).resolves.toBe(failure)
  expect(records().at(-1)).toMatchObject({ event: 'execute.failed', level: 'error', fields: { failureCode: 'ABORTED' } })
  expect(records().some(record => record.event === 'execute.start')).toBe(false)
})

it('records the retry decision while delegating the official request-error waterfall exactly once', async () => {
  const { records, dispatch } = await environment()
  const next = vi.fn(async () => ({ kind: 'retry' }))
  const action = await dispatch('agent/request-error', { agent: { id: 'session-a' }, turn: 1, step: 2, provider: 'test', failure: { code: 'RATE_LIMIT' } }, next)
  expect(action).toEqual({ kind: 'retry' }); expect(next).toHaveBeenCalledOnce()
  expect(records().at(-1)).toMatchObject({ event: 'request.retry-decision', fields: { sessionId: 'session-a', turn: 1, step: 2, retry: true } })
})
