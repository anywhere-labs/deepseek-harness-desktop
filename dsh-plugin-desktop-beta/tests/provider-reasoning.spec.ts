import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { nativeReasoningPolicy, refreshReasoningConfig, ReasoningEffortId, type ModelReasoningConfig, type StreamChunk } from '@deepseek-ai/dsh-llm'
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { DeepSeekAdapter, resolveAdapterOptions, registerDeepSeekProvider } from '@deepseek-ai/dsh-llm-deepseek'
import { createServer } from 'node:http'

const contexts: Context[] = []
const disposers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const context of contexts.splice(0)) await context.fiber.dispose()
  for (const dispose of disposers.splice(0)) await dispose()
})

describe('provider model reasoning configuration', () => {
  it('uses off as the native inherited default when thinking is disabled', () => {
    expect(nativeReasoningPolicy('disabled', 'high')).toMatchObject({ inheritedDefault: 'off', allowedIds: ['off'] })
  })

  it('selects all efforts on the first known result after an unknown lookup', () => {
    const unknown = { status: 'unknown' as const, source: 'endpoint' as const, efforts: [] }
    const known = { status: 'known' as const, source: 'endpoint' as const, authoritative: true, efforts: ['low', 'high'].map(id => ({ id, name: id })) }
    const pending = refreshReasoningConfig(undefined, unknown)
    expect(refreshReasoningConfig(pending, known)?.selected).toEqual(['low', 'high'])
  })

  it('discovers native endpoint declarations ahead of the adapter contract', async () => {
    const server = createServer((_request, response) => response.end(JSON.stringify({ data: [
      { id: 'native', reasoning_efforts: ['off', 'low'] }, { id: 'plain', reasoning_efforts: false },
    ] })))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    disposers.push(() => new Promise(resolve => server.close(() => resolve())))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('missing fixture address')
    const baseURL = `http://127.0.0.1:${address.port}/v1`
    const context = new Context()
    contexts.push(context)
    await context.plugin(LlmRuntime)
    registerDeepSeekProvider(context, 'native', { options: () => resolveAdapterOptions({ baseURL, models: [{ id: 'native' }] }), resolveAuth: async () => ({ headers: {} }) })
    const found = await context.llm.discoverModels('llm-deepseek', { provider: 'native', baseURL })
    expect(found[0]?.reasoningCapability).toMatchObject({ status: 'known', source: 'endpoint', authoritative: true, efforts: [{ id: 'off', wireValue: 'off' }, { id: 'low', wireValue: 'low' }] })
    expect(found[1]?.reasoningCapability).toMatchObject({ status: 'unsupported', source: 'endpoint' })
  })
  it('uses the installed catalog for exact built-in connections and keeps the same model on a relay unknown', async () => {
    const context = new Context()
    contexts.push(context)
    await context.plugin(LlmRuntime)
    await context.plugin(PiAi, { providers: { openai: {} } })
    const catalog = await context.llm.discoverModels('llm-pi-ai', { provider: 'openai' })
    const thinking = catalog.find(model => model.reasoningCapability?.status === 'known')
    expect(thinking?.reasoningCapability).toMatchObject({ source: 'catalog', endpoint: expect.any(String), efforts: expect.arrayContaining([expect.objectContaining({ id: 'high' })]) })
    const server = createServer((_request, response) => response.end(JSON.stringify({ data: [{ id: thinking!.id }] })))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    disposers.push(() => new Promise(resolve => server.close(() => resolve())))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('missing fixture address')
    const models = await context.llm.discoverModels('llm-pi-ai', { provider: 'openai', baseURL: `http://127.0.0.1:${address.port}/v1`, api: 'openai-completions' })
    expect(models[0]?.reasoningCapability).toMatchObject({ status: 'unknown', source: 'endpoint' })
  })

  it('keeps the reasoning selections of the same model independent across providers', async () => {
    const context = new Context()
    contexts.push(context)
    await context.plugin(LlmRuntime)
    const manualEfforts = ['low', 'high'].map(id => ({ id, name: id, wireValue: id }))
    await context.plugin(PiAi, { providers: Object.fromEntries(['first', 'second'].map((provider, index) => [provider, {
      api: 'openai-completions' as const, baseURL: `http://127.0.0.1:${index + 1}/v1`,
      models: [{ id: 'same', reasoningConfig: { manualEfforts, selected: [index === 0 ? 'low' : 'high'], defaultEffort: index === 0 ? 'low' : 'high' } }],
    }])) })
    expect((await context.llm.prepareCall({ provider: 'first', model: 'same' })).config.reasoningEffort).toBe('low')
    expect((await context.llm.prepareCall({ provider: 'second', model: 'same' })).config.reasoningEffort).toBe('high')
  })
  it.each([{ native: false, effort: 'low' }, { native: true, effort: 'low' }, { native: true, effort: 'off' }])('sends adapter-owned fields and rejects an endpoint refusal without changing effort ($native native, $effort)', async ({ native, effort }) => {
    const bodies: Record<string, unknown>[] = []
    const server = createServer(async (request, response) => {
      let body = ''
      for await (const bytes of request) body += String(bytes)
      bodies.push(JSON.parse(body) as Record<string, unknown>)
      response.statusCode = 400
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'unsupported reasoning effort' } }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    disposers.push(() => new Promise(resolve => server.close(() => resolve())))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('missing fixture address')
    const baseURL = `http://127.0.0.1:${address.port}/v1`
    const context = new Context()
    contexts.push(context)
    await context.plugin(LlmRuntime)
    const reasoningConfig: ModelReasoningConfig = {
      manualEfforts: [{ id: 'off', name: 'Off', wireValue: native ? 'off' : null }, { id: 'low', name: 'Low', wireValue: 'low' }, { id: 'high', name: 'High', wireValue: 'high' }],
      selected: [effort], defaultEffort: effort,
    }
    if (native) {
      let connection = resolveAdapterOptions({ baseURL, models: [{ id: 'think', reasoningConfig }] })
      context.llm.registerAdapter(['gateway'], new DeepSeekAdapter({
        options: () => connection, resolveAuth: async () => ({ headers: {} }),
        resolveUserId: () => 'fixture' as import('@deepseek-ai/dsh-anonymous-user-id').AnonymousUserId,
        prepareExtensions: async () => ({ fields: {}, accept: async () => {} }),
      }))
      const prepared = await context.llm.prepareCall({ provider: 'gateway', model: 'think' })
      connection = resolveAdapterOptions({ baseURL, models: [{ id: 'think', reasoningConfig: { ...reasoningConfig, selected: ['high'], defaultEffort: 'high' } }] })
      expect((await context.llm.prepareCall({ provider: 'gateway', model: 'think' })).config.reasoningEffort).toBe('high')
      await expect(consume(prepared.stream({ ...prepared.config, messages: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }] })))
        .rejects.toMatchObject({ code: 'UNSUPPORTED_REASONING_EFFORT', message: expect.stringContaining('Open model settings') })
      if (effort === 'off') {
        expect(bodies[0]).toMatchObject({ thinking: { type: 'disabled' } })
        expect(bodies[0]).not.toHaveProperty('output_config')
      } else expect(bodies[0]).toMatchObject({ thinking: { type: 'enabled' }, output_config: { effort } })
    } else {
      await context.plugin(PiAi, { providers: { gateway: { api: 'openai-completions', baseURL, apiKeyEnv: 'REASONING_FIXTURE_KEY', models: [{ id: 'think', reasoningConfig }] } } })
      const prepared = await context.llm.prepareCall({ provider: 'gateway', model: 'think' })
      process.env.REASONING_FIXTURE_KEY = 'local-fixture'
      try {
        await expect(consume(prepared.stream({ ...prepared.config, messages: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }] })))
          .rejects.toMatchObject({ code: 'UNSUPPORTED_REASONING_EFFORT', message: expect.stringContaining('Open model settings') })
      } finally { delete process.env.REASONING_FIXTURE_KEY }
      expect(bodies[0]).toMatchObject({ reasoning_effort: 'low' })
    }
    expect(bodies).toHaveLength(1)
  })

  it('keeps legacy and unknown models loadable and localizes invalid saved defaults', async () => {
    const context = new Context()
    contexts.push(context)
    await context.plugin(LlmRuntime)
    await context.plugin(PiAi, { providers: { gateway: { api: 'openai-completions', baseURL: 'http://127.0.0.1:1/v1', reasoning: 'high', models: [
      { id: 'legacy', reasoningEfforts: { low: 'low', high: 'high' } },
      { id: 'unknown', reasoningEfforts: { low: 'low', high: 'high' }, reasoningConfig: { capability: { status: 'unknown', source: 'endpoint', efforts: [] }, selected: [] } },
      { id: 'invalid', reasoningConfig: { manualEfforts: [{ id: 'low', name: 'Low', wireValue: 'low' }], selected: ['low'] } },
    ] } } })
    expect((await context.llm.prepareCall({ provider: 'gateway', model: 'legacy' })).config.reasoningEffort).toBe('high')
    expect((await context.llm.prepareCall({ provider: 'gateway', model: 'unknown' })).config.reasoningEffort).toBe('high')
    expect((await context.llm.resolveModelInfo('gateway', 'invalid')).reasoning?.efforts.map(effort => effort.id)).toEqual(['low'])
    await expect(context.llm.prepareCall({ provider: 'gateway', model: 'invalid' })).rejects.toMatchObject({ code: 'UNSUPPORTED_REASONING_EFFORT', message: expect.stringContaining('default') })
  })
  it('uses the native DeepSeek selected range and per-model default', async () => {
    const context = new Context()
    contexts.push(context)
    await context.plugin(LlmRuntime)
    const connection = resolveAdapterOptions({ models: [{ id: 'native', reasoningConfig: {
      capability: { status: 'known', source: 'adapter', efforts: ['off', 'low', 'high', 'max'].map(id => ({ id, name: id })) },
      selected: ['low', 'max'], defaultEffort: 'max',
    } }] })
    context.llm.registerAdapter(['native-provider'], new DeepSeekAdapter({
      options: () => connection,
      resolveAuth: async () => ({ headers: {} }),
      resolveUserId: () => { throw new Error('metadata must not require user identity') },
      prepareExtensions: async () => ({ fields: {}, accept: async () => {} }),
    }))
    const info = await context.llm.resolveModelInfo('native-provider', 'native')
    expect(info.reasoning?.efforts.map(effort => effort.id)).toEqual(['low', 'max'])
    expect((await context.llm.prepareCall({ provider: 'native-provider', model: 'native' })).config.reasoningEffort).toBe('max')
    await expect(context.llm.prepareCall({ provider: 'native-provider', model: 'native', reasoningEffort: ReasoningEffortId('high') }))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_REASONING_EFFORT' })
  })
  it('discovers explicit endpoint capabilities and keeps missing metadata unknown', async () => {
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ data: [
        { id: 'think', reasoning_efforts: { low: 'low', high: 'high' } },
        { id: 'mystery' },
        { id: 'plain', reasoningEfforts: false },
      ] }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    disposers.push(() => new Promise(resolve => server.close(() => resolve())))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('missing fixture address')
    const baseURL = `http://127.0.0.1:${address.port}/v1`
    const context = new Context()
    contexts.push(context)
    await context.plugin(LlmRuntime)
    await context.plugin(PiAi, { providers: { gateway: { api: 'openai-completions', baseURL, models: [{ id: 'think' }] } } })

    const models = await context.llm.discoverModels('llm-pi-ai', { provider: 'gateway', baseURL, api: 'openai-completions' })
    expect(models).toEqual([
      expect.objectContaining({ id: 'think', reasoningCapability: expect.objectContaining({
        status: 'known', source: 'endpoint', authoritative: true,
        efforts: [{ id: 'low', name: 'low', wireValue: 'low' }, { id: 'high', name: 'high', wireValue: 'high' }],
      }) }),
      expect.objectContaining({ id: 'mystery', reasoningCapability: expect.objectContaining({ status: 'unknown', source: 'endpoint', efforts: [] }) }),
      expect.objectContaining({ id: 'plain', reasoningCapability: expect.objectContaining({ status: 'unsupported', source: 'endpoint', authoritative: true, efforts: [] }) }),
    ])
  })
  it('advertises only selected efforts and applies the independent model default', async () => {
    const context = new Context()
    contexts.push(context)
    await context.plugin(LlmRuntime)
    const model = {
      id: 'think',
      reasoningEfforts: { low: 'low', high: 'high' },
      reasoningConfig: {
        capability: {
          status: 'known' as const, source: 'endpoint' as const, authoritative: true,
          efforts: [{ id: 'low', name: 'Low', wireValue: 'low' }, { id: 'high', name: 'High', wireValue: 'high' }],
        },
        selected: ['high'], defaultEffort: 'high',
      },
    }
    await context.plugin(PiAi, {
      providers: { gateway: { api: 'openai-completions', baseURL: 'http://127.0.0.1:1/v1', models: [model] } },
    })

    const info = await context.llm.resolveModelInfo('gateway', 'think')
    expect(info.reasoning?.efforts.map(effort => effort.id)).toEqual(['high'])
    const call = await context.llm.prepareCall({ provider: 'gateway', model: 'think' })
    expect(call.config.reasoningEffort).toBe('high')
    await expect(context.llm.prepareCall({ provider: 'gateway', model: 'think', reasoningEffort: ReasoningEffortId('low') }))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_REASONING_EFFORT' })
  })
})

async function consume(stream: AsyncIterable<StreamChunk>) {
  for await (const chunk of stream) {
    if (chunk.type === 'finish' && chunk.reason.kind === 'error') throw chunk.reason.failure
  }
}
