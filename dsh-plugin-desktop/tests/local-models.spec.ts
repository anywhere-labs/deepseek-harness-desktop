import { describe, expect, it, vi } from 'vitest'
import {
  createLocalModelProviderConfig,
  mergeLocalModelProvider,
  probeLocalModelRuntime,
  resolveLocalModelTarget,
  startLocalModelRuntime,
} from '../src/local-models.ts'
import { LOCAL_MODEL_API_KEY_ENV } from '../src/workbench-settings.ts'

describe('local model discovery', () => {
  it('rejects non-loopback origins', () => {
    expect(() => resolveLocalModelTarget({ origin: 'https://example.invalid' })).toThrow('127.0.0.1')
    expect(() => resolveLocalModelTarget({ origin: 'http://10.0.0.2:11434' })).toThrow('127.0.0.1')
    expect(resolveLocalModelTarget({ id: 'ollama' }).origin).toBe('http://127.0.0.1:11434')
  })

  it('reads OpenAI-compatible and Ollama tag lists without storing a token', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).endsWith('/v1/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'llama3', name: 'Llama 3' }] }), { status: 200 })
      }
      return new Response('missing', { status: 404 })
    })
    const probe = await probeLocalModelRuntime(
      resolveLocalModelTarget({ id: 'ollama' }),
      fetchImpl,
      200,
    )
    expect(probe).toMatchObject({
      running: true,
      started: false,
      models: [{ id: 'llama3', name: 'Llama 3' }],
    })
    expect(JSON.stringify(createLocalModelProviderConfig(probe))).not.toMatch(/sk-|Bearer |token/i)
    expect(createLocalModelProviderConfig(probe).apiKeyEnv).toBe(LOCAL_MODEL_API_KEY_ENV)
  })

  it('does not spawn when a runtime is already listening', async () => {
    const spawn = vi.fn()
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'local' }] }), { status: 200 }))
    const result = await startLocalModelRuntime(resolveLocalModelTarget({ id: 'lmstudio' }), {
      fetchImpl,
      commandExists: () => true,
      spawn,
      timeoutMs: 200,
    })
    expect(result.running).toBe(true)
    expect(result.started).toBe(false)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('may start a stopped supported runtime and then writes only a loopback provider', async () => {
    let running = false
    const spawn = vi.fn(() => { running = true })
    const fetchImpl = vi.fn(async () => {
      if (!running) return new Response('down', { status: 503 })
      return new Response(JSON.stringify({ data: [{ id: 'qwen' }] }), { status: 200 })
    })
    const result = await startLocalModelRuntime(resolveLocalModelTarget({ id: 'ollama' }), {
      fetchImpl,
      commandExists: () => true,
      spawn,
      timeoutMs: 200,
      waitMs: 0,
    })
    expect(spawn).toHaveBeenCalledWith('ollama', ['serve'])
    expect(result).toMatchObject({ running: true, started: true, models: [{ id: 'qwen', name: 'qwen' }] })
    expect(mergeLocalModelProvider({}, 'ollama', createLocalModelProviderConfig(result)).ollama).toEqual(
      expect.objectContaining({
        api: 'openai-completions',
        baseURL: 'http://127.0.0.1:11434/v1',
        apiKeyEnv: LOCAL_MODEL_API_KEY_ENV,
      }),
    )
  })
})
