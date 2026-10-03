import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { Readable } from 'node:stream'
import type {
  AuthorizationInteraction,
  AuthorizationOutcome,
  AuthorizationRequest,
  AuthorizationService,
} from '@deepseek-ai/dsh-authorization'
import { credentialKey, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DESKTOP_COPILOT_AUTHORIZATION_ANSWER_PATH,
  DESKTOP_COPILOT_AUTHORIZATION_BEGIN_PATH,
  DESKTOP_COPILOT_AUTHORIZATION_CANCEL_PATH,
  DESKTOP_COPILOT_AUTHORIZATION_MODELS_PATH,
} from '../src/copilot-authorization-contract.ts'
import { apply } from '../src/index.ts'
import {
  DesktopCopilotAuthorizationController,
  handleDesktopCopilotAuthorizationAnswerRequest,
  handleDesktopCopilotAuthorizationBeginRequest,
  handleDesktopCopilotAuthorizationCancelRequest,
  handleDesktopCopilotAuthorizationModelsRequest,
  handleDesktopCopilotAuthorizationReadRequest,
} from '../src/copilot-authorization-route.ts'

const ORIGIN = 'http://127.0.0.1:43120'
const COPILOT_KEY = credentialKey('llm-pi-ai', 'github-copilot')

function request(method: string, body?: unknown, headers: Record<string, string | undefined> = {}): IncomingMessage {
  const encoded = body === undefined ? undefined : JSON.stringify(body)
  const req = Readable.from(encoded === undefined ? [] : [encoded]) as IncomingMessage
  req.method = method
  req.headers = {
    host: '127.0.0.1:43120',
    origin: ORIGIN,
    'sec-fetch-site': 'same-origin',
    ...(encoded === undefined ? {} : {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(encoded)),
    }),
    ...headers,
  }
  Object.defineProperty(req, 'socket', { configurable: true, value: { remoteAddress: '127.0.0.1' } })
  return req
}

function response(): ServerResponse & {
  body: string
  end: ReturnType<typeof vi.fn>
  setHeader: ReturnType<typeof vi.fn>
  writeHead: ReturnType<typeof vi.fn>
} {
  const res = {
    body: '',
    statusCode: 200,
    setHeader: vi.fn(),
    writeHead: vi.fn((status: number) => { res.statusCode = status; return res }),
    end: vi.fn((body?: string) => { res.body = body ?? '' }),
  }
  return res as unknown as ServerResponse & typeof res
}

function setup(run: (request: AuthorizationRequest) => Promise<AuthorizationOutcome> = async () => ({ status: 'authorized' })) {
  const authorization = {
    describe: vi.fn(() => ({
      key: COPILOT_KEY,
      label: 'GitHub Copilot',
      methods: [{ id: 'oauth', label: 'Sign in with GitHub' }],
      inFlight: false,
    })),
    begin: vi.fn(run),
  } as unknown as AuthorizationService
  const credentials = {
    describeRecord: vi.fn(async () => ({ configured: false, writable: true })),
    readRecord: vi.fn(async () => undefined),
  } as unknown as CredentialProvider
  return { authorization, credentials, controller: new DesktopCopilotAuthorizationController(authorization, credentials) }
}

function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('Desktop Copilot authorization controller', () => {
  it('uses the fixed OAuth key and relays a GitHub device code and typed prompt', async () => {
    let interaction: AuthorizationInteraction | undefined
    let answer: string | undefined
    const { authorization, credentials, controller } = setup(async request => {
      interaction = request.interaction
      request.interaction.notify({
        message: 'Enter the code on GitHub.',
        url: 'https://github.com/login/device',
        code: 'ABCD-EFGH',
      })
      answer = await request.interaction.prompt({ kind: 'text', message: 'GitHub verification code' })
      return { status: 'authorized' }
    })

    expect(controller.start()).toBe('started')
    await flush()
    const waiting = await controller.read()
    expect(waiting.notice).toEqual({
      message: 'Enter the code on GitHub.',
      url: 'https://github.com/login/device',
      code: 'ABCD-EFGH',
    })
    expect(waiting.prompt?.kind).toBe('text')
    expect(authorization.begin).toHaveBeenCalledWith(expect.objectContaining({ key: COPILOT_KEY, method: 'oauth' }))
    vi.mocked(credentials.describeRecord).mockResolvedValue({ configured: true, writable: true })
    expect(controller.answer(waiting.prompt!.id, 'sample-code')).toBe('accepted')
    await flush()
    expect(answer).toBe('sample-code')
    expect((await controller.read()).phase).toBe('authorized')
    expect(interaction).toBeDefined()
  })

  it('defaults the optional GitHub Enterprise prompt to github.com without interrupting sign-in', async () => {
    let enterpriseDomain: string | undefined
    const { controller, credentials } = setup(async request => {
      enterpriseDomain = await request.interaction.prompt({
        kind: 'text',
        message: 'GitHub Enterprise URL/domain (blank for github.com)',
      })
      request.interaction.notify({
        message: 'Enter the code on GitHub.',
        url: 'https://github.com/login/device',
        code: 'ABCD-EFGH',
      })
      return { status: 'authorized' }
    })

    controller.start()
    await flush()

    expect(enterpriseDomain).toBe('')
    vi.mocked(credentials.describeRecord).mockResolvedValue({ configured: true, writable: true })
    const view = await controller.read()
    expect(view.prompt).toBeUndefined()
    expect(view.notice?.url).toBe('https://github.com/login/device')
    expect(view.phase).toBe('authorized')
  })

  it('cancels an active prompt without exposing flow errors or credentials', async () => {
    const { controller } = setup(async request => {
      await request.interaction.prompt({ kind: 'secret', message: 'Temporary value' })
      return { status: 'authorized' }
    })
    controller.start()
    await flush()
    expect((await controller.read()).prompt?.kind).toBe('secret')
    expect(controller.cancel()).toBe(true)
    await flush()
    const view = await controller.read()
    expect(view.phase).toBe('cancelled')
    expect(JSON.stringify(view)).not.toContain('token')
  })

  it('rejects a stale prompt answer and unavailable OAuth methods', () => {
    const { authorization, controller } = setup()
    expect(controller.answer('unknown', 'answer')).toBe('stale')
    vi.mocked(authorization.describe).mockReturnValueOnce({
      key: COPILOT_KEY,
      label: 'GitHub Copilot',
      methods: [{ id: 'api-key', label: 'API key' }],
      inFlight: false,
    } as unknown as ReturnType<AuthorizationService['describe']>)
    expect(controller.start()).toBe('unavailable')
  })
})

describe('Desktop Copilot model categories', () => {
  const access = 'tid=private-access;proxy-ep=proxy.individual.githubcopilot.com;exp=123'
  const credential = (payload: Record<string, unknown>) => ({ kind: 'grant' as const, payload: {
    access, availableModelIds: ['model-a', 'model-b', 'model-c', 'model-d', 'model-e', 'model-f', 'missing-in-api'], ...payload,
  } })

  it('sorts by catalog input/output prices, marks the threshold, and keeps unknown-price models stable at the end', async () => {
    const { credentials, controller } = setup()
    vi.mocked(credentials.readRecord).mockResolvedValue(credential({
      availableModelIds: ['gpt-5.5', 'gpt-6-luna', 'model-f', 'model-e'],
    }))
    const fetchModels = vi.fn(async () => new Response(JSON.stringify({ data: [
      { id: 'gpt-5.5', model_picker_enabled: true, policy: { state: 'enabled' }, model_picker_category: 'powerful', billing: { multiplier: 1 } },
      { id: 'gpt-6-luna', model_picker_enabled: true, policy: { state: 'enabled' }, model_picker_category: 'versatile', billing: { multiplier: 20 } },
      { id: 'model-f', model_picker_enabled: true, policy: { state: 'enabled' }, model_picker_category: 'standard' },
      { id: 'model-e', model_picker_enabled: true, model_picker_category: 123, billing: { multiplier: 20 } },
      { id: 'gpt-6-astra', model_picker_enabled: false, policy: { state: 'enabled' }, model_picker_category: 'hidden' },
      { id: 'model-d', model_picker_enabled: true, policy: { state: 'disabled' }, model_picker_category: 'blocked' },
      { id: 'outside', model_picker_enabled: true, policy: { state: 'enabled' }, model_picker_category: 'other' },
    ] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchModels)

    const res = response()
    await handleDesktopCopilotAuthorizationModelsRequest(request('GET'), res, ORIGIN, controller)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({
      models: [
        { id: 'gpt-6-luna', category: 'versatile' },
        { id: 'gpt-5.5', category: 'powerful', highCost: true },
        { id: 'model-f', category: 'standard' },
        { id: 'model-e' },
      ],
      configured: true,
    })
    expect(res.setHeader).toHaveBeenCalledWith('cache-control', 'no-store')
    expect(fetchModels).toHaveBeenCalledOnce()
    expect(fetchModels).toHaveBeenCalledWith('https://api.individual.githubcopilot.com/models', expect.objectContaining({
      method: 'GET', cache: 'no-store', redirect: 'error',
      headers: expect.objectContaining({
        Authorization: `Bearer ${access}`,
        'X-GitHub-Api-Version': '2026-06-01',
        'Copilot-Integration-Id': 'vscode-chat',
      }),
      signal: expect.any(AbortSignal),
    }))
    expect(credentials.readRecord).toHaveBeenCalledWith(COPILOT_KEY)
    expect(res.body).not.toContain('private-access')
    expect(res.body).not.toContain('billing')
    expect(DESKTOP_COPILOT_AUTHORIZATION_MODELS_PATH).toBe('/api/desktop/copilot-authorization/models')
  })

  it('uses the SDK Individual all-false picker fallback only for enabled policies', async () => {
    const { credentials, controller } = setup()
    vi.mocked(credentials.readRecord).mockResolvedValue(credential({}))
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [
      { id: 'model-a', model_picker_enabled: false, policy: { state: 'enabled' }, model_picker_category: 'fast' },
      { id: 'model-b', model_picker_enabled: false, policy: { state: 'disabled' } },
      { id: 'model-c', model_picker_enabled: false, policy: { state: 'unconfigured' } },
      { id: 'outside', model_picker_enabled: true, policy: { state: 'disabled' } },
    ] }), { status: 200 })))
    expect((await controller.readModels()).models).toEqual([{ id: 'model-a', category: 'fast' }])
    vi.mocked(credentials.readRecord).mockResolvedValue(credential({
      access: 'tid=private-access;proxy-ep=proxy.business.githubcopilot.com',
    }))
    expect((await controller.readModels()).models).toEqual([])
  })

  it('does not apply Individual fallback when any other eligible API model has its picker enabled', async () => {
    const { credentials, controller } = setup()
    vi.mocked(credentials.readRecord).mockResolvedValue(credential({ availableModelIds: ['model-a'] }))
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [
      { id: 'model-a', model_picker_enabled: false, policy: { state: 'enabled' }, model_picker_category: 'fast' },
      { id: 'not-in-credential', model_picker_enabled: true, policy: { state: 'enabled' } },
    ] }), { status: 200 })))
    expect((await controller.readModels()).models).toEqual([])
  })

  it('returns an empty unconfigured response without any upstream request', async () => {
    const { controller, credentials } = setup()
    const fetchModels = vi.fn()
    vi.stubGlobal('fetch', fetchModels)
    const res = response()
    await handleDesktopCopilotAuthorizationModelsRequest(request('GET'), res, ORIGIN, controller)
    expect(JSON.parse(res.body)).toEqual({ models: [], configured: false })
    vi.mocked(credentials.readRecord).mockResolvedValue(credential({ availableModelIds: [] }))
    expect(await controller.readModels()).toEqual({ models: [], configured: true })
    expect(fetchModels).not.toHaveBeenCalled()
  })

  it('refreshes an expired individual token in memory without writing credentials', async () => {
    const { controller, credentials } = setup()
    const stored = credential({
      access: 'expired-access', refresh: 'private-refresh', expires: 1, availableModelIds: ['model-a'],
    })
    vi.mocked(credentials.readRecord).mockResolvedValue(stored)
    const refreshed = 'tid=new-access;proxy-ep=proxy.individual.githubcopilot.com'
    const fetchModels = vi.fn(async (url: string) => new Response(JSON.stringify(
      url === 'https://api.github.com/copilot_internal/v2/token'
        ? { token: refreshed, expires_at: 9999999999 }
        : { data: [{ id: 'model-a', model_picker_enabled: true, model_picker_category: 'standard' }] },
    ), { status: 200 }))
    vi.stubGlobal('fetch', fetchModels)
    expect(await controller.readModels()).toEqual({ models: [{ id: 'model-a', category: 'standard' }], configured: true })
    expect(fetchModels).toHaveBeenCalledTimes(2)
    expect(fetchModels).toHaveBeenNthCalledWith(1, 'https://api.github.com/copilot_internal/v2/token', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer private-refresh' }), redirect: 'error',
    }))
    expect(fetchModels).toHaveBeenNthCalledWith(2, 'https://api.individual.githubcopilot.com/models', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: `Bearer ${refreshed}` }), redirect: 'error',
    }))
    expect(credentials.readRecord).toHaveBeenCalledOnce()
    expect(stored.payload).toEqual({
      access: 'expired-access', refresh: 'private-refresh', expires: 1, availableModelIds: ['model-a'],
    })
  })

  it('rejects methods and cross-origin or non-loopback reads before touching the secret', async () => {
    const { controller, credentials } = setup()
    for (const req of [
      request('POST'),
      request('GET', undefined, { origin: 'https://example.com' }),
      request('GET', undefined, { host: 'evil.example' }),
      request('GET', undefined, { origin: undefined, referer: 'https://example.com/', 'sec-fetch-site': 'cross-site' }),
    ]) {
      const res = response()
      await handleDesktopCopilotAuthorizationModelsRequest(req, res, ORIGIN, controller)
      expect(res.statusCode).toBe(req.method === 'POST' ? 405 : 403)
      if (req.method === 'POST') expect(res.setHeader).toHaveBeenCalledWith('allow', 'GET')
    }
    expect(credentials.readRecord).not.toHaveBeenCalled()
  })

  it('rejects unsupported enterprise credentials and untrusted token endpoints before fetching', async () => {
    const { controller, credentials } = setup()
    const fetchModels = vi.fn()
    vi.stubGlobal('fetch', fetchModels)
    for (const enterpriseUrl of ['https://company.ghe.com', 'http://127.0.0.1/private', 'github.com@localhost']) {
      vi.mocked(credentials.readRecord).mockResolvedValue(credential({ enterpriseUrl, expires: 1, refresh: 'private-refresh' }))
      const enterprise = response()
      await handleDesktopCopilotAuthorizationModelsRequest(request('GET'), enterprise, ORIGIN, controller)
      expect(enterprise.statusCode).toBe(422)
      expect(JSON.parse(enterprise.body)).toEqual({ error: 'GitHub Enterprise Copilot models are not supported' })
    }
    for (const proxy of [
      'proxy.evil.example.com',
      '',
      'proxy.individual.githubcopilot.com.evil.example',
      'proxy.individual.githubcopilot.com:443',
      'proxy.individual.githubcopilot.com@localhost',
      'proxy.individual.githubcopilot.com/path',
    ]) {
      vi.mocked(credentials.readRecord).mockResolvedValue(credential({ access: `tid=x;proxy-ep=${proxy}` }))
      const malicious = response()
      await handleDesktopCopilotAuthorizationModelsRequest(request('GET'), malicious, ORIGIN, controller)
      expect(malicious.statusCode).toBe(503)
      if (proxy) expect(malicious.body).not.toContain(proxy)
    }
    expect(fetchModels).not.toHaveBeenCalled()
  })

  it('keeps model reads independent of the authorization status route, including on failure', async () => {
    const { controller, authorization, credentials } = setup()
    vi.mocked(credentials.describeRecord).mockResolvedValue({ configured: true, writable: true })
    vi.mocked(credentials.readRecord).mockResolvedValue(credential({}))
    const fetchModels = vi.fn(async () => new Response('unavailable', { status: 401 }))
    vi.stubGlobal('fetch', fetchModels)
    const before = response()
    await handleDesktopCopilotAuthorizationReadRequest(request('GET'), before, ORIGIN, controller)
    const models = response()
    await handleDesktopCopilotAuthorizationModelsRequest(request('GET'), models, ORIGIN, controller)
    const after = response()
    await handleDesktopCopilotAuthorizationReadRequest(request('GET'), after, ORIGIN, controller)
    expect(before.statusCode).toBe(200)
    expect(JSON.parse(after.body)).toEqual(JSON.parse(before.body))
    expect(JSON.parse(before.body)).toMatchObject({ configured: true, phase: 'idle' })
    expect(models.statusCode).toBe(503)
    expect(authorization.begin).not.toHaveBeenCalled()
    expect(authorization.describe).toHaveBeenCalledTimes(2)
    expect(credentials.describeRecord).toHaveBeenCalledTimes(2)
    expect(credentials.readRecord).toHaveBeenCalledOnce()
    expect(fetchModels).toHaveBeenCalledOnce()
  })

  it('returns generic errors without leaking tokens for invalid records, upstream failures or bad JSON', async () => {
    const { controller, credentials } = setup()
    for (const payload of [
      { availableModelIds: ['model-a'], access: 'expired-access', expires: 1 },
      { availableModelIds: 'not-an-array' },
      { availableModelIds: ['model-a'], access: 'tid=x;proxy-ep=proxy.individual.githubcopilot.com' },
    ]) {
      vi.mocked(credentials.readRecord).mockResolvedValue(credential(payload))
      vi.stubGlobal('fetch', vi.fn(async () => new Response('private-upstream-error', { status: 401 })))
      const res = response()
      await handleDesktopCopilotAuthorizationModelsRequest(request('GET'), res, ORIGIN, controller)
      expect(res.statusCode).toBe(503)
      expect(res.body).not.toContain('private')
    }
    vi.mocked(credentials.readRecord).mockResolvedValue(credential({}))
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ nope: [] }), { status: 200 })))
    const malformed = response()
    await handleDesktopCopilotAuthorizationModelsRequest(request('GET'), malformed, ORIGIN, controller)
    expect(malformed.statusCode).toBe(503)
    expect(malformed.body).not.toContain(access)
  })
})

describe('Desktop Copilot Host registration', () => {
  it('applies connection.requestRejection to /models before reading any credential', async () => {
    const { authorization, credentials } = setup()
    const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>()
    const requestRejection = vi.fn(() => 401 as 401 | 403 | undefined)
    const runtime = { platform: 'linux' }
    const services: Record<string, unknown> = {
      desktopRuntime: runtime,
      appExit: () => {},
      authorization,
      credentials,
      desktopBrowserAccess: {},
      desktopLanHttps: { attach: () => {} },
    }
    const field = <T>(value: T) => ({ get: () => value })
    const config = {
      mode: field('compatibility'), macosMaterial: field('off'), windowsMaterial: field('off'),
      linuxMaterial: field('off'), port: field(43120), openBrowser: field(false),
      networkExposure: field('loopback'), logLevel: field('info'),
      width: 1280, height: 840, minWidth: 900, minHeight: 640,
    } as unknown as Parameters<typeof apply>[1]
    const ctx = {
      get: (key: string) => services[key],
      webServer: {
        host: '127.0.0.1', port: 43120,
        register: (route: { path: string, handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }) => {
          routes.set(route.path, route.handler)
          return () => { routes.delete(route.path) }
        },
      },
      connection: { requestRejection },
      on: () => () => {},
      inject: () => {},
      // Only the first five effects register Copilot routes; stop this focused
      // fixture before unrelated native-shell initialization.
      effect: (register: () => void) => {
        if (routes.size === 5) throw new Error('Copilot routes registered')
        register()
      },
    } as unknown as Context
    expect(() => apply(ctx, config)).toThrow('Copilot routes registered')
    const handler = routes.get(DESKTOP_COPILOT_AUTHORIZATION_MODELS_PATH)
    expect(handler).toBeDefined()
    for (const rejection of [401, 403] as const) {
      requestRejection.mockReturnValue(rejection)
      const res = response()
      await handler!(request('GET'), res)
      expect(res.writeHead).toHaveBeenCalledWith(rejection)
      expect(res.statusCode).toBe(rejection)
      expect(credentials.readRecord).not.toHaveBeenCalled()
    }
    requestRejection.mockReturnValue(undefined)
    const allowed = response()
    await handler!(request('GET'), allowed)
    expect(JSON.parse(allowed.body)).toEqual({ models: [], configured: false })
    expect(credentials.readRecord).toHaveBeenCalledOnce()
    expect(requestRejection).toHaveBeenCalledTimes(3)
  })
})

describe('Desktop Copilot authorization routes', () => {
  it('starts only a strict empty-body same-origin request', async () => {
    const { authorization, controller } = setup()
    const accepted = response()
    await handleDesktopCopilotAuthorizationBeginRequest(request('POST', {}), accepted, ORIGIN, controller)
    expect(accepted.statusCode).toBe(202)
    expect(JSON.parse(accepted.body)).toEqual({ accepted: true })
    expect(authorization.begin).toHaveBeenCalledOnce()

    const forged = response()
    await handleDesktopCopilotAuthorizationBeginRequest(request('POST', { key: 'other/credential' }), forged, ORIGIN, controller)
    expect(forged.statusCode).toBe(400)
    expect(authorization.begin).toHaveBeenCalledOnce()

    const crossOrigin = response()
    await handleDesktopCopilotAuthorizationBeginRequest(request('POST', {}, { origin: 'https://example.com' }), crossOrigin, ORIGIN, controller)
    expect(crossOrigin.statusCode).toBe(403)
  })

  it('answers the current prompt and cancels the same authorization attempt', async () => {
    const { controller } = setup(async request => {
      await request.interaction.prompt({
        kind: 'select',
        message: 'Choose an account',
        options: [{ id: 'personal', label: 'Personal' }],
      })
      return { status: 'authorized' }
    })
    controller.start()
    await flush()
    const prompt = (await controller.read()).prompt!
    const answered = response()
    await handleDesktopCopilotAuthorizationAnswerRequest(
      request('POST', { promptId: prompt.id, answer: 'personal' }), answered, ORIGIN, controller,
    )
    expect(answered.statusCode).toBe(200)
    expect(JSON.parse(answered.body)).toEqual({ accepted: true })
    await flush()

    const cancel = response()
    await handleDesktopCopilotAuthorizationCancelRequest(request('POST', {}), cancel, ORIGIN, controller)
    expect(cancel.statusCode).toBe(409)
    expect(DESKTOP_COPILOT_AUTHORIZATION_BEGIN_PATH).toContain('copilot-authorization')
    expect(DESKTOP_COPILOT_AUTHORIZATION_ANSWER_PATH).toContain('/answer')
    expect(DESKTOP_COPILOT_AUTHORIZATION_CANCEL_PATH).toContain('/cancel')
  })
})
