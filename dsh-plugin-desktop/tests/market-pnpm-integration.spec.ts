import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { FileSettingsProvider } from '@deepseek-ai/dsh-settings-file'
import type { SubprocessHandle, SubprocessRuntime, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { describe, expect, it, vi } from 'vitest'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import {
  apply as applyDesktopPnpm,
  inject as desktopPnpmInject,
  name as desktopPnpmName,
  type DesktopPnpmBootstrap,
} from '../src/pnpm.js'

const PACKAGE_NAME = 'dsh-plugin-market-integration'
const PACKAGE_VERSION = '1.2.3'
const INTEGRITY = `sha512-${Buffer.alloc(64).toString('base64')}`

interface CommunityMarketModule {
  readonly name: string
  readonly inject: string[]
  readonly apply: (ctx: Context) => void
  readonly marketRoutes: {
    readonly operationPreview: string
    readonly operationExecute: string
  }
}

function bootstrap(root: string, profileDir: string): DesktopPnpmBootstrap {
  return {
    activeProfileName: 'web',
    activeProfileDir: profileDir,
    homeDir: join(root, 'home'),
    appExecutable: join(root, 'DSH Desktop'),
    pnpmBinPath: join(root, 'runtime', 'pnpm.mjs'),
    electronVersion: '43.4.0',
    nodeBinDir: join(root, 'runtime', 'node-bin'),
    nodeShimPath: join(root, 'runtime', 'node-bin', 'node'),
    clearEnvironmentPath: join(root, 'runtime', 'clear-env.mjs'),
    dshBootstrapPath: join(root, 'app.asar', 'lib', 'desktop-cli.js'),
    installRecoveryStatePath: join(root, 'plugin-install-recovery', 'state.json'),
    generationId: 'market-integration-generation-0001',
    externalMarketInstallEnabled: false,
  }
}

async function writeInstalledProfile(profileDir: string): Promise<void> {
  const pluginDir = join(profileDir, 'node_modules', PACKAGE_NAME)
  await mkdir(pluginDir, { recursive: true })
  await writeFile(join(pluginDir, 'cordis.patch.yml'), '[]\n')
  await writeFile(join(pluginDir, 'package.json'), JSON.stringify({
    name: PACKAGE_NAME,
    version: PACKAGE_VERSION,
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  await writeFile(join(profileDir, 'package.json'), JSON.stringify({
    name: 'market-integration-profile',
    dependencies: { [PACKAGE_NAME]: PACKAGE_VERSION },
    dsh: { profile: { bundles: [PACKAGE_NAME] } },
  }))
  await writeFile(join(profileDir, 'pnpm-lock.yaml'), stringifyYaml({
    lockfileVersion: '9.0',
    importers: {
      '.': {
        dependencies: {
          [PACKAGE_NAME]: { specifier: PACKAGE_VERSION, version: PACKAGE_VERSION },
        },
      },
    },
    packages: {
      [`${PACKAGE_NAME}@${PACKAGE_VERSION}`]: { resolution: { integrity: INTEGRITY } },
    },
    snapshots: { [`${PACKAGE_NAME}@${PACKAGE_VERSION}`]: {} },
  }))
}

async function removeInstalledProfilePlugin(profileDir: string): Promise<void> {
  await rm(join(profileDir, 'node_modules', PACKAGE_NAME), { recursive: true, force: true })
  await writeFile(join(profileDir, 'package.json'), JSON.stringify({
    name: 'market-integration-profile',
    dependencies: {},
    dsh: { profile: { bundles: [] } },
  }))
  await writeFile(join(profileDir, 'pnpm-lock.yaml'), stringifyYaml({
    lockfileVersion: '9.0',
    importers: { '.': {} },
    packages: {},
    snapshots: {},
  }))
}

async function createWebServer() {
  type Handler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
  const handlers = new Map<string, Handler>()
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname
    const handler = handlers.get(path)
    if (handler === undefined) {
      response.statusCode = 404
      response.end()
      return
    }
    void Promise.resolve(handler(request, response)).catch(() => {
      if (!response.writableEnded) {
        response.statusCode = 500
        response.end()
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture web server did not bind TCP')
  const origin = `http://127.0.0.1:${address.port}`
  return {
    service: {
      port: address.port,
      register(route: { path: string; handler: Handler }) {
        handlers.set(route.path, route.handler)
        return () => { handlers.delete(route.path) }
      },
    },
    async post(path: string, body: unknown) {
      const response = await fetch(`${origin}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin,
          'sec-fetch-site': 'same-origin',
        },
        body: JSON.stringify(body),
      })
      return { status: response.status, body: await response.json() as Record<string, unknown> }
    },
    close: async () => await new Promise<void>((resolve, reject) => {
      server.close(error => { if (error === undefined) resolve(); else reject(error) })
    }),
  }
}

describe('desktop pnpm and community market integration', () => {
  it('executes a market uninstall route through the managed desktop pnpm boundary', async () => {
    const marketModuleUrl = new URL('../../dsh-community-market/src/index.js', import.meta.url).href
    const market = await import(marketModuleUrl) as CommunityMarketModule
    const root = await mkdtemp(join(tmpdir(), 'dsh-market-desktop-pnpm-'))
    const profileDir = join(root, 'profiles', 'web')
    const settingsPath = join(root, 'settings.yaml')
    const receipt = {
      receiptId: 'receipt:desktop-market-integration-0001',
      profileName: 'web',
      packageName: PACKAGE_NAME,
      version: PACKAGE_VERSION,
      integrity: INTEGRITY,
      bundlePatch: './cordis.patch.yml',
      sourceRecordId: 'source-integration-1',
      providerId: 'provider-integration-1',
      itemId: 'example/dsh-plugin-market-integration',
      displayName: 'Market Integration Plugin',
      installedAt: '2026-08-18T00:00:00.000Z',
    }
    const ctx = new Context()
    const webServer = await createWebServer()
    try {
      await writeInstalledProfile(profileDir)
      await writeFile(settingsPath, stringifyYaml({
        'dsh-community-market': { sources: [], installReceipts: [receipt] },
      }))

      const selectedBootstrap = bootstrap(root, profileDir)
      const spawn = vi.fn<(spec: SubprocessSpawnSpec) => SubprocessHandle>((_spec) => ({
        pid: 43_120,
        stdin: undefined,
        stdout: Readable.from([]),
        stderr: Readable.from([]),
        collected: {},
        done: (async () => {
          await removeInstalledProfilePlugin(profileDir)
          return { exitCode: 0, signal: null }
        })(),
        terminate: vi.fn(),
        waitForExit: vi.fn(async () => true),
      }))
      ctx.provide('webServer', webServer.service as never)
      ctx.provide('desktopProfiles', { current: { name: 'web', dir: profileDir } })
      ctx.provide('desktopPnpmBootstrap', selectedBootstrap)
      ctx.provide('subprocess', { spawn } as unknown as SubprocessRuntime)
      await ctx.plugin(FileSettingsProvider, { path: settingsPath, watch: false })
      await ctx.plugin({ name: desktopPnpmName, inject: desktopPnpmInject, apply: applyDesktopPnpm })
      await ctx.plugin({ name: market.name, inject: market.inject, apply: market.apply })

      const preview = await webServer.post(market.marketRoutes.operationPreview, {
        action: 'uninstall',
        receiptId: receipt.receiptId,
      })
      expect(preview).toMatchObject({
        status: 200,
        body: { action: 'uninstall', packageName: PACKAGE_NAME },
      })
      expect(preview.body.previewId).toEqual(expect.any(String))

      const executed = await webServer.post(market.marketRoutes.operationExecute, {
        previewId: preview.body.previewId,
      })
      expect(executed).toMatchObject({
        status: 200,
        body: {
          action: 'uninstall',
          receiptId: receipt.receiptId,
          packageName: PACKAGE_NAME,
        },
      })
      expect(spawn).toHaveBeenCalledOnce()
      expect(spawn.mock.calls[0]?.[0]).toMatchObject({
        argv: [
          selectedBootstrap.appExecutable,
          '--expose-internals',
          selectedBootstrap.dshBootstrapPath,
          'plugin',
          '--profile',
          'web',
          'remove',
          PACKAGE_NAME,
        ],
        cwd: profileDir,
        env: { ELECTRON_RUN_AS_NODE: '1', DSH_HOME: selectedBootstrap.homeDir },
      })

      const persisted = parseYaml(await readFile(settingsPath, 'utf8')) as {
        'dsh-community-market': { installReceipts: unknown[] }
      }
      expect(persisted['dsh-community-market'].installReceipts).toEqual([])
      const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8')) as {
        dependencies: Record<string, string>
      }
      expect(manifest.dependencies).not.toHaveProperty(PACKAGE_NAME)
    } finally {
      await ctx.fiber.dispose()
      await webServer.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
