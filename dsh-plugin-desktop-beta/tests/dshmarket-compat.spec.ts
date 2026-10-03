import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

interface DesktopOperationHandle {
  readonly stdout: NodeJS.ReadableStream
  readonly stderr: NodeJS.ReadableStream
  readonly done: Promise<{ readonly exitCode: number | null; readonly signal: NodeJS.Signals | null }>
  cancel(): void
}

interface DshMarketRuntime {
  runPlugin(profile: string, args: string[]): Promise<{
    readonly exitCode: number | null
    readonly timedOut: boolean
    readonly cancelled: boolean
  }>
  dispose(): Promise<void>
}

interface RouteRuntimeResult {
  readonly exitCode: number | null
  readonly timedOut: boolean
  readonly cancelled: boolean
  readonly stdout: string
  readonly stderr: string
}

interface MarketCommandRuntime {
  runPlugin(profile: string, args: string[]): Promise<RouteRuntimeResult>
  probePnpm(): Promise<boolean>
  provisionPnpm(): Promise<{ ok: boolean; hint?: string }>
  cancelActive(): boolean
}

type MarketRoute = (request: object, response: object) => void | Promise<void>

const { registryFetch } = vi.hoisted(() => ({ registryFetch: vi.fn<typeof fetch>() }))
// Market uses undici's fetch with its own dispatcher, bypassing global fetch.
// Mock that transport so version lookups cannot escape to the live registry.
vi.mock('undici', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  fetch: registryFetch,
}))
const temporaryProfiles: string[] = []

afterEach(() => {
  registryFetch.mockReset()
  for (const profile of temporaryProfiles.splice(0)) rmSync(profile, { recursive: true, force: true })
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

async function runtimeFactory(): Promise<(
  service: object,
  activeProfileDir: string,
  invokingDir?: string,
) => DshMarketRuntime> {
  const require = createRequire(import.meta.url)
  const manifest = require.resolve('dshmarket/package.json')
  const moduleUrl = pathToFileURL(join(dirname(manifest), 'lib', 'dsh-cli.js')).href
  const loaded = await import(moduleUrl) as {
    createDesktopPluginRuntime: (
      service: object,
      activeProfileDir: string,
      invokingDir?: string,
    ) => DshMarketRuntime
  }
  return loaded.createDesktopPluginRuntime
}

function completedHandle(): DesktopOperationHandle {
  return {
    stdout: Readable.from([]),
    stderr: Readable.from([]),
    done: Promise.resolve({ exitCode: 0, signal: null }),
    cancel: vi.fn(),
  }
}

function writeProfileManifest(profileDir: string, manifest: object): void {
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}

function installMarketFixture(profileDir: string, options: { validPatch: boolean }): void {
  const packageDir = join(profileDir, 'node_modules', 'dshmarket')
  mkdirSync(join(packageDir, 'lib'), { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
    name: 'dshmarket',
    version: '9999.0.0',
    main: './lib/index.js',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  writeFileSync(join(packageDir, 'lib', 'index.js'), 'export default {}\n')
  if (options.validPatch) writeFileSync(join(packageDir, 'cordis.patch.yml'), '[]\n')
}

async function mountUpdateRoute(
  profileDir: string,
  commandRuntime: MarketCommandRuntime,
): Promise<{ route: MarketRoute; dispose: () => void }> {
  const require = createRequire(import.meta.url)
  const manifest = require.resolve('dshmarket/package.json')
  const routesUrl = pathToFileURL(join(dirname(manifest), 'lib', 'routes.js')).href
  const loaded = await import(routesUrl) as {
    mountMarketRoutes: (
      host: object,
      config: { profile: string; profileDirectory: string; allowRestart: boolean },
      commandRuntime: MarketCommandRuntime,
      agentsLookup: () => { list(): unknown[] },
    ) => () => void
  }
  const routes = new Map<string, MarketRoute>()
  const dispose = loaded.mountMarketRoutes({
    webServer: {
      register(route: { path: string; handler: MarketRoute }) {
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    },
    loader: { entries: () => [] },
    plugin: () => ({ await: async () => undefined, dispose: () => undefined }),
  }, { profile: 'desktop', profileDirectory: profileDir, allowRestart: false }, commandRuntime, () => ({ list: () => [] }))
  const route = routes.get('/dsh-market/update')
  if (route === undefined) throw new Error('update route was not registered')
  return { route, dispose }
}

async function invokeUpdate(route: MarketRoute, compatVersion?: string, name = 'dshmarket'): Promise<{ status: number; body: Record<string, unknown> }> {
  const request = Object.assign(Readable.from([JSON.stringify({ name, force: true, compatVersion })]), {
    method: 'POST',
    url: '/dsh-market/update',
    headers: { origin: 'http://localhost', host: 'localhost' },
  })
  let status = 0
  let body = ''
  await route(request, {
    writeHead(code: number) { status = code },
    end(chunk?: string) { body = chunk ?? '' },
  })
  return { status, body: JSON.parse(body) as Record<string, unknown> }
}

describe('dsh-market Desktop install compatibility', () => {
  it('offers the host-provided market update when the Profile omits dshmarket', async () => {
    for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
      vi.stubEnv(name, '')
    }
    registryFetch.mockImplementation(async () => new Response(
      JSON.stringify({ version: '9999.0.0' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))

    const profileDir = mkdtempSync(join(tmpdir(), 'dshmarket-desktop-self-update-'))
    temporaryProfiles.push(profileDir)
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-desktop',
      private: true,
      dependencies: {},
    }))

    const require = createRequire(import.meta.url)
    const manifest = require.resolve('dshmarket/package.json')
    const routesUrl = pathToFileURL(join(dirname(manifest), 'lib', 'routes.js')).href
    const loaded = await import(routesUrl) as {
      mountMarketRoutes: (
        host: object,
        config: { profile: string; profileDirectory: string; allowRestart: boolean },
      ) => () => void
    }
    const routes = new Map<string, (request: object, response: object) => void | Promise<void>>()
    const dispose = loaded.mountMarketRoutes({
      webServer: {
        register(route: { path: string; handler: (request: object, response: object) => void | Promise<void> }) {
          routes.set(route.path, route.handler)
          return () => routes.delete(route.path)
        },
      },
      loader: { entries: () => [] },
      plugin: () => ({ await: async () => undefined, dispose: () => undefined }),
    }, { profile: 'desktop', profileDirectory: profileDir, allowRestart: false })

    let status = 0
    let body = ''
    await routes.get('/dsh-market/updates')?.(
      { method: 'GET', url: '/dsh-market/updates?force=1' },
      {
        writeHead(code: number) { status = code },
        end(chunk?: string) { body = chunk ?? '' },
      },
    )
    dispose()

    expect(status).toBe(200)
    expect(JSON.parse(body).updates.dshmarket).toMatchObject({
      kind: 'npm',
      version: JSON.parse(readFileSync(manifest, 'utf8')).version,
      current: JSON.parse(readFileSync(manifest, 'utf8')).version,
      latest: '9999.0.0',
      updateAvailable: true,
    })

    const client = readFileSync(join(dirname(manifest), 'client', 'client.js'), 'utf8')
    expect(client).toContain('installed["dshmarket"] !== void 0 || updates["dshmarket"] !== void 0')
    expect(client).toContain('const status = updates[self]')
  })

  it.each([
    '@liustack/modlens',
    '@liustack/modlens@latest',
  ])('resolves npm latest target %s and enters the external Market install boundary', async (target) => {
    for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) {
      vi.stubEnv(name, '')
    }
    registryFetch.mockImplementation(async () => new Response(
      JSON.stringify({ version: '3.18.1' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))
    const runPlugin = vi.fn(() => completedHandle())
    const runExternalMarketPluginInstall = vi.fn((
      _args: readonly string[],
      _invokingDir: string,
      _signal?: AbortSignal,
    ) => completedHandle())
    const createRuntime = await runtimeFactory()
    const runtime = createRuntime(
      { runPlugin, runExternalMarketPluginInstall },
      '/private/dsh-profile',
      '/private/dsh-invoking',
    )

    await expect(runtime.runPlugin('desktop', ['add', target])).resolves.toMatchObject({
      exitCode: 0,
      timedOut: false,
      cancelled: false,
    })
    expect(runPlugin).not.toHaveBeenCalled()
    expect(runExternalMarketPluginInstall).toHaveBeenCalledOnce()
    expect(runExternalMarketPluginInstall.mock.calls[0]?.[0]).toEqual([
      'add',
      '@liustack/modlens@3.18.1',
      '--reporter=ndjson',
    ])
    expect(runExternalMarketPluginInstall.mock.calls[0]?.[1]).toBe('/private/dsh-invoking')

    await runtime.dispose()
  })

  it('keeps non-add operations on the ordinary managed command boundary', async () => {
    const runPlugin = vi.fn(() => completedHandle())
    const runExternalMarketPluginInstall = vi.fn(() => completedHandle())
    const createRuntime = await runtimeFactory()
    const runtime = createRuntime(
      { runPlugin, runExternalMarketPluginInstall },
      '/private/dsh-profile',
      '/private/dsh-invoking',
    )

    await expect(runtime.runPlugin('desktop', ['remove', '@liustack/modlens'])).resolves.toMatchObject({
      exitCode: 0,
      timedOut: false,
      cancelled: false,
    })
    expect(runPlugin).toHaveBeenCalledOnce()
    expect(runExternalMarketPluginInstall).not.toHaveBeenCalled()

    await runtime.dispose()
  })

  it('allows dshmarket itself to be upgraded through the external Market boundary', async () => {
    const runPlugin = vi.fn(() => completedHandle())
    const runExternalMarketPluginInstall = vi.fn(() => completedHandle())
    const createRuntime = await runtimeFactory()
    const runtime = createRuntime(
      { runPlugin, runExternalMarketPluginInstall },
      '/private/dsh-profile',
      '/private/dsh-invoking',
    )

    await expect(runtime.runPlugin('desktop', ['add', 'dshmarket@9999.0.0'])).resolves.toMatchObject({
      exitCode: 0,
      timedOut: false,
      cancelled: false,
    })
    expect(runPlugin).not.toHaveBeenCalled()
    expect(runExternalMarketPluginInstall).toHaveBeenCalledWith(
      ['add', 'dshmarket@9999.0.0', '--reporter=ndjson'],
      '/private/dsh-invoking',
      expect.any(AbortSignal),
    )
    await runtime.dispose()
  })

  it.each([undefined, '9999.0.0'])('does not reject a host-provided market update for a pre-existing missing bundle (compatVersion=%s)', async (compatVersion) => {
    registryFetch.mockImplementation(async () => new Response(
      JSON.stringify({ version: '9999.0.0' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))
    const profileDir = mkdtempSync(join(tmpdir(), 'dshmarket-trial-baseline-'))
    temporaryProfiles.push(profileDir)
    vi.stubEnv('DSH_HOME', join(profileDir, 'empty-home'))
    writeProfileManifest(profileDir, {
      name: 'dsh-profile-desktop',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['orphan'] } },
    })
    const runPlugin = vi.fn(async (_profile: string, args: string[]): Promise<RouteRuntimeResult> => {
      if (args[0] === 'add' && !args.includes('--force')) {
        writeProfileManifest(profileDir, {
          name: 'dsh-profile-desktop',
          private: true,
          dependencies: { dshmarket: '^9999.0.0' },
          dsh: { profile: { bundles: ['orphan', 'dshmarket'] } },
        })
        installMarketFixture(profileDir, { validPatch: true })
      }
      return { exitCode: 0, timedOut: false, cancelled: false, stdout: '', stderr: '' }
    })
    const { route, dispose } = await mountUpdateRoute(profileDir, {
      runPlugin,
      probePnpm: async () => true,
      provisionPnpm: async () => ({ ok: true }),
      cancelActive: () => false,
    })

    const result = await invokeUpdate(route, compatVersion)
    dispose()

    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ ok: true })
    expect(runPlugin).toHaveBeenCalledOnce()
    expect(runPlugin.mock.calls[0]?.[1]).toContain('dshmarket@9999.0.0')
    expect(JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))).toMatchObject({
      dependencies: { dshmarket: '^9999.0.0' },
      dsh: { profile: { bundles: ['orphan', 'dshmarket'] } },
    })
  })

  it('uses the bundled market version to skip an already installed compatible release', async () => {
    const profileDir = mkdtempSync(join(tmpdir(), 'dshmarket-compat-current-'))
    temporaryProfiles.push(profileDir)
    writeProfileManifest(profileDir, { name: 'dsh-profile-desktop', private: true, dependencies: {} })
    const require = createRequire(import.meta.url)
    const version = (require('dshmarket/package.json') as { version: string }).version
    const runPlugin = vi.fn(async (): Promise<RouteRuntimeResult> => ({
      exitCode: 0, timedOut: false, cancelled: false, stdout: '', stderr: '',
    }))
    const { route, dispose } = await mountUpdateRoute(profileDir, {
      runPlugin,
      probePnpm: async () => true,
      provisionPnpm: async () => ({ ok: true }),
      cancelActive: () => false,
    })

    const result = await invokeUpdate(route, version)
    dispose()

    expect(result).toMatchObject({ status: 200, body: { ok: true, skipped: 'current', name: 'dshmarket', version } })
    expect(runPlugin).not.toHaveBeenCalled()
  })

  it('uses the bundled market version to reject a compatible release that would downgrade it', async () => {
    const profileDir = mkdtempSync(join(tmpdir(), 'dshmarket-compat-downgrade-'))
    temporaryProfiles.push(profileDir)
    writeProfileManifest(profileDir, { name: 'dsh-profile-desktop', private: true, dependencies: {} })
    const runPlugin = vi.fn(async (): Promise<RouteRuntimeResult> => ({
      exitCode: 0, timedOut: false, cancelled: false, stdout: '', stderr: '',
    }))
    const { route, dispose } = await mountUpdateRoute(profileDir, {
      runPlugin,
      probePnpm: async () => true,
      provisionPnpm: async () => ({ ok: true }),
      cancelActive: () => false,
    })

    const result = await invokeUpdate(route, '0.0.1')
    dispose()

    expect(result.status).toBe(400)
    expect(result.body.error).toContain('would be a downgrade')
    expect(runPlugin).not.toHaveBeenCalled()
    expect(JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')).dependencies).toEqual({})
  })

  it('does not treat an unrelated missing plugin as a bundled market update', async () => {
    const profileDir = mkdtempSync(join(tmpdir(), 'dshmarket-compat-unrelated-'))
    temporaryProfiles.push(profileDir)
    writeProfileManifest(profileDir, { name: 'dsh-profile-desktop', private: true, dependencies: {} })
    const runPlugin = vi.fn(async (): Promise<RouteRuntimeResult> => ({
      exitCode: 0, timedOut: false, cancelled: false, stdout: '', stderr: '',
    }))
    const { route, dispose } = await mountUpdateRoute(profileDir, {
      runPlugin,
      probePnpm: async () => true,
      provisionPnpm: async () => ({ ok: true }),
      cancelActive: () => false,
    })

    const result = await invokeUpdate(route, '9999.0.0', 'unrelated-plugin')
    dispose()

    expect(result).toMatchObject({ status: 400, body: { error: 'plugin is not installed' } })
    expect(runPlugin).not.toHaveBeenCalled()
  })

  it('restores dependencies and the bundle stack when an update introduces a trial failure', async () => {
    registryFetch.mockImplementation(async () => new Response(
      JSON.stringify({ version: '9999.0.0' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))
    const profileDir = mkdtempSync(join(tmpdir(), 'dshmarket-trial-rollback-'))
    temporaryProfiles.push(profileDir)
    vi.stubEnv('DSH_HOME', join(profileDir, 'empty-home'))
    const initialManifest = {
      name: 'dsh-profile-desktop',
      private: true,
      dependencies: { existing: '1.0.0' },
      dsh: { profile: { bundles: [] as string[] } },
    }
    writeProfileManifest(profileDir, initialManifest)
    const runPlugin = vi.fn(async (_profile: string, args: string[]): Promise<RouteRuntimeResult> => {
      if (args[0] === 'add' && !args.includes('--force')) {
        writeProfileManifest(profileDir, {
          ...initialManifest,
          dependencies: { ...initialManifest.dependencies, dshmarket: '^9999.0.0' },
          dsh: { profile: { bundles: ['dshmarket'] } },
        })
        installMarketFixture(profileDir, { validPatch: false })
      }
      return { exitCode: 0, timedOut: false, cancelled: false, stdout: '', stderr: '' }
    })
    const { route, dispose } = await mountUpdateRoute(profileDir, {
      runPlugin,
      probePnpm: async () => true,
      provisionPnpm: async () => ({ ok: true }),
      cancelActive: () => false,
    })

    const result = await invokeUpdate(route)
    dispose()

    expect(result.status).toBe(502)
    expect(result.body).toMatchObject({ ok: false })
    expect(String(result.body.error)).toContain('declared patch ./cordis.patch.yml is missing')
    expect(runPlugin).toHaveBeenCalledTimes(2)
    expect(runPlugin.mock.calls[1]?.[1]).toEqual(['add', '--force', '--config.minimum-release-age=0', `dshmarket@${JSON.parse(readFileSync(createRequire(import.meta.url).resolve('dshmarket/package.json'), 'utf8')).version}`])
    expect(JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))).toEqual(initialManifest)
  })
})
