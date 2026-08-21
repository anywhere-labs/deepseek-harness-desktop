import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import { FileSettingsProvider } from '@deepseek-ai/dsh-settings-file'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { stringify as stringifyYaml } from 'yaml'
import { DSH_1024STORE_ADAPTER_ID, DSH_1024STORE_PROVIDER_ID } from '../src/adapters/dsh-1024store.js'
import type { MarketSettingsDocument } from '../src/catalog/source-store.js'
import type { CatalogFullIndex } from '../src/catalog/service.js'
import type { CatalogHttpClient, CatalogSnapshot } from '../src/contracts/index.js'
import {
  createNpmRegistryVerifier,
  MarketInstallError,
  MarketInstallService,
  type MarketDesktopPnpm,
  type MarketInstallReceipt,
} from '../src/install/service.js'
import { marketRoutes, registerMarketRoutes, registerMarketSettings } from '../src/host/routes.js'
import { manualInstallHint } from '../src/install/manual.js'

const packageName = 'dsh-plugin-safe'
const version = '1.2.3'
const repository = { url: 'https://github.com/example/dsh-plugin-safe' }
const integrity = `sha512-${Buffer.alloc(64).toString('base64')}`
const tarball = 'https://registry.npmjs.org/dsh-plugin-safe/-/dsh-plugin-safe-1.2.3.tgz'
const verification = { integrity, bundlePatch: './cordis.patch.yml', tarball }
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async path => await rm(path, { recursive: true, force: true })))
})

function snapshot(overrides: Record<string, unknown> = {}): CatalogSnapshot {
  return {
    schemaVersion: '1.0.0',
    source: {
      sourceRecordId: 'source-1',
      providerId: DSH_1024STORE_PROVIDER_ID,
      adapterId: DSH_1024STORE_ADAPTER_ID,
      registrationKind: 'built-in',
      fetchedAt: '2026-08-18T00:00:00.000Z',
      finalUrl: 'https://deepseek1024.com/api/v1/plugins',
    },
    items: [{
      id: 'example/dsh-plugin-safe',
      name: packageName,
      displayName: 'Safe Plugin',
      summary: 'Fixture plugin',
      latestVersion: version,
      package: { registry: 'npm', name: packageName },
      repository,
      provenance: {
        sourceRecordId: 'source-1',
        providerId: DSH_1024STORE_PROVIDER_ID,
        itemId: 'example/dsh-plugin-safe',
      },
      ...overrides,
    }],
    page: {},
  } as CatalogSnapshot
}

function snapshotWithCandidates(count: number): CatalogSnapshot {
  const base = snapshot()
  const item = base.items[0]!
  return {
    ...base,
    items: Array.from({ length: count }, (_, index) => {
      const candidatePackage = `${packageName}-${index}`
      const candidateId = `example/${candidatePackage}`
      return {
        ...item,
        id: candidateId,
        name: candidatePackage,
        displayName: `Safe Plugin ${index}`,
        package: { registry: 'npm' as const, name: candidatePackage },
        repository: { url: `https://github.com/example/${candidatePackage}` },
        provenance: {
          ...item.provenance,
          itemId: candidateId,
        },
      }
    }),
  }
}

function fullIndex(value: CatalogSnapshot, scanKey = 'scan-1'): CatalogFullIndex {
  const snapshots = Array.from(
    { length: Math.max(1, Math.ceil(value.items.length / 100)) },
    (_, index) => ({ ...value, items: value.items.slice(index * 100, index * 100 + 100) }),
  )
  return {
    source: {
      sourceRecordId: value.source.sourceRecordId,
      registrationKind: value.source.registrationKind,
      adapterId: value.source.adapterId,
      providerId: value.source.providerId,
      builtInProviderKey: 'dsh-1024store',
      enabled: true,
      order: 0,
      name: 'DSH 1024Store',
      endpoint: value.source.finalUrl,
      partnership: true,
    },
    snapshots,
    scannedAt: '2026-08-18T00:00:00.000Z',
    expiresAt: '2099-08-18T00:05:00.000Z',
    cacheStatus: 'fresh',
    scanKey,
    sourceGeneration: 0,
  }
}

async function createProfile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'market-install-'))
  temporaryDirectories.push(dir)
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: 'fixture-profile',
    dependencies: {},
    dsh: { profile: { bundles: [] } },
  }))
  return dir
}

interface LockFixtureOptions {
  readonly lockfileVersion?: string | number
  readonly specifier?: string
  readonly importerVersion?: string
  readonly integrity?: string
  readonly slashPackageKey?: boolean
  readonly slashSnapshotKey?: boolean
  readonly omitPackage?: boolean
  readonly omitSnapshot?: boolean
}

async function writeProfileLock(profileDir: string, options: LockFixtureOptions = {}): Promise<void> {
  const importerVersion = options.importerVersion ?? version
  const packageKey = `${options.slashPackageKey === true ? '/' : ''}${packageName}@${version}`
  const snapshotKey = `${options.slashSnapshotKey === true ? '/' : ''}${packageName}@${importerVersion}`
  await writeFile(join(profileDir, 'pnpm-lock.yaml'), stringifyYaml({
    lockfileVersion: options.lockfileVersion ?? '9.0',
    importers: {
      '.': {
        dependencies: {
          [packageName]: {
            specifier: options.specifier ?? version,
            version: importerVersion,
          },
        },
      },
    },
    packages: options.omitPackage === true ? {} : {
      [packageKey]: { resolution: { integrity: options.integrity ?? integrity } },
    },
    snapshots: options.omitSnapshot === true ? {} : {
      [snapshotKey]: {},
    },
  }))
}

async function writeInstalledPlugin(profileDir: string, lockOptions: LockFixtureOptions = {}): Promise<void> {
  const pluginDir = join(profileDir, 'node_modules', packageName)
  await mkdir(pluginDir, { recursive: true })
  await writeFile(join(pluginDir, 'cordis.patch.yml'), '[]\n')
  await writeFile(join(pluginDir, 'package.json'), JSON.stringify({
    name: packageName,
    version,
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  await writeFile(join(profileDir, 'package.json'), JSON.stringify({
    name: 'fixture-profile',
    dependencies: { [packageName]: version },
    dsh: { profile: { bundles: [packageName] } },
  }))
  await writeProfileLock(profileDir, lockOptions)
}

async function removeInstalledPlugin(profileDir: string): Promise<void> {
  await rm(join(profileDir, 'node_modules', packageName), { recursive: true, force: true })
  await writeFile(join(profileDir, 'package.json'), JSON.stringify({
    name: 'fixture-profile',
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

function memoryScope(initial: readonly MarketInstallReceipt[] = []): {
  readonly scope: SettingsScope<MarketSettingsDocument>
  readonly receipts: () => readonly MarketInstallReceipt[]
} {
  let document: MarketSettingsDocument = { sources: [], installReceipts: initial }
  return {
    scope: {
      get: () => document,
      watch: () => () => {},
      update: vi.fn(async patch => { document = { ...document, ...patch } as MarketSettingsDocument }),
      replace: vi.fn(async section => { document = section as MarketSettingsDocument }),
    },
    receipts: () => document.installReceipts ?? [],
  }
}

function runner(
  profileDir: string,
  calls: Array<{ args: readonly string[]; dir: string; signal?: AbortSignal }>,
  outcome: { exitCode: number | null; signal: NodeJS.Signals | null } = { exitCode: 0, signal: null },
): MarketDesktopPnpm {
  return recoverableRunner(profileDir, {
    runPlugin(args, dir, signal) {
      calls.push({ args: [...args], dir, ...(signal === undefined ? {} : { signal }) })
      const done = (async () => {
        if (outcome.exitCode === 0 && outcome.signal === null) {
          if (args[0] === 'add') await writeInstalledPlugin(profileDir)
          if (args[0] === 'remove') await removeInstalledPlugin(profileDir)
        }
        return outcome
      })()
      return {
        stdout: Readable.from([]),
        stderr: Readable.from([]),
        done,
        cancel: vi.fn(),
      }
    },
  })
}

function recoverableRunner(
  profileDir: string,
  implementation: Pick<MarketDesktopPnpm, 'runPlugin'>,
): MarketDesktopPnpm {
  let pendingPackageName: string | undefined
  return {
    ...implementation,
    async installPlugin(request) {
      pendingPackageName = request.recovery.packageName
      return implementation.runPlugin([
        'add',
        ...(request.pnpmOptions ?? []),
        `${request.recovery.packageName}@${request.recovery.packageVersion}`,
      ], request.invokingDir, request.signal)
    },
    async recoveredInstallReceiptIds() { return [] },
    async acknowledgeRecoveredInstall() {},
    async rollbackPluginInstall() {
      if (pendingPackageName === undefined) return false
      const handle = implementation.runPlugin(['remove', pendingPackageName], profileDir)
      handle.stdout.resume()
      handle.stderr.resume()
      const outcome = await handle.done
      pendingPackageName = undefined
      return outcome.exitCode === 0 && outcome.signal === null
    },
  }
}

describe('npm registry verification', () => {
  it('pins exact identity, repository, origin, and rejects lifecycle/deprecated metadata', async () => {
    const getJson = vi.fn<(...args: any[]) => Promise<{ finalUrl: string; value: unknown }>>(async () => ({
      finalUrl: `https://registry.npmjs.org/${packageName}/${version}`,
      value: {
        name: packageName,
        version,
        repository: { type: 'git', url: 'git+https://github.com/example/dsh-plugin-safe.git' },
        scripts: { test: 'vitest' },
        dependencies: { '@deepseek-ai/dsh-agent': '^0.1.1-rc.2' },
        peerDependencies: { '@deepseek-ai/cordis': '^4.0.1' },
        engines: { node: '>=22.19.0' },
        dist: { integrity, tarball },
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      },
    }))
    const verifier = createNpmRegistryVerifier({ getJson } as CatalogHttpClient)
    await expect(verifier.verify({ packageName, version, repository }, new AbortController().signal)).resolves.toEqual(verification)
    expect(getJson).toHaveBeenCalledWith(
      `https://registry.npmjs.org/${packageName}/${version}`,
      expect.any(AbortSignal),
      { allowedOrigin: 'https://registry.npmjs.org' },
    )
    getJson.mockResolvedValueOnce({
      finalUrl: `https://registry.npmjs.org/${packageName}/${version}`,
      value: {
        name: packageName,
        version,
        repository,
        dist: { integrity, tarball },
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      },
    })
    await expect(verifier.verify({ packageName, version, repository }, new AbortController().signal))
      .resolves.toEqual(verification)

    for (const value of [
      { name: packageName, version, repository, deprecated: 'unsafe', engines: { node: '>=22' }, dist: { integrity, tarball }, dsh: { bundle: { patch: './cordis.patch.yml' } } },
      { name: packageName, version, repository, scripts: { postinstall: 'node unsafe.js' }, engines: { node: '>=22' }, dist: { integrity, tarball }, dsh: { bundle: { patch: './cordis.patch.yml' } } },
      { name: packageName, version, repository: { url: 'https://github.com/attacker/other' }, engines: { node: '>=22' }, dist: { integrity, tarball }, dsh: { bundle: { patch: './cordis.patch.yml' } } },
      { name: packageName, version, repository, engines: { node: '>=22' }, dist: { integrity: 'sha512-not-a-digest', tarball }, dsh: { bundle: { patch: './cordis.patch.yml' } } },
      { name: packageName, version, repository, engines: { node: '>=22' }, dist: { integrity, tarball }, dsh: { bundle: { patch: '../escape.yml' } } },
      { name: packageName, version, repository, dependencies: { '@deepseek-ai/dsh-agent': '^0.2.0' }, engines: { node: '>=22' }, dist: { integrity, tarball }, dsh: { bundle: { patch: './cordis.patch.yml' } } },
      { name: packageName, version, repository, dependencies: { '@deepseek-ai/dsh-agent': 'workspace:^' }, engines: { node: '>=22' }, dist: { integrity, tarball }, dsh: { bundle: { patch: './cordis.patch.yml' } } },
      { name: packageName, version, repository, optionalDependencies: { '@deepseek-ai/dsh-agent': '^0.2.0' }, engines: { node: '>=22' }, dist: { integrity, tarball }, dsh: { bundle: { patch: './cordis.patch.yml' } } },
      { name: packageName, version, repository, peerDependencies: { cordis: '^3.0.0' }, engines: { node: '>=22' }, dist: { integrity, tarball }, dsh: { bundle: { patch: './cordis.patch.yml' } } },
      { name: packageName, version, repository, engines: { node: '<24' }, dist: { integrity, tarball }, dsh: { bundle: { patch: './cordis.patch.yml' } } },
      { name: packageName, version, repository, engines: { node: '>=22' }, dist: { integrity, tarball: 'https://evil.example/plugin.tgz' }, dsh: { bundle: { patch: './cordis.patch.yml' } } },
    ]) {
      getJson.mockResolvedValueOnce({ finalUrl: 'https://registry.npmjs.org/x', value })
      await expect(verifier.verify({ packageName, version, repository }, new AbortController().signal))
        .rejects.toBeInstanceOf(MarketInstallError)
    }
  })
})

describe('manual install display instructions', () => {
  it('reconstructs only safe exact npm commands and never guesses from a repository', () => {
    const npm = manualInstallHint(snapshot().items[0]!)
    expect(npm).toMatchObject({
      kind: 'npm',
      mutable: false,
      desktopVerification: 'not-verified',
      displayCommand: `dsh plugin add --save-exact ${packageName}@${version}`,
    })

    const githubItem = structuredClone(snapshot().items[0]!) as Record<string, unknown>
    delete githubItem.package
    delete githubItem.latestVersion
    githubItem.repository = {
      url: 'https://github.com/tianxia--/safe-repo',
      subdirectory: 'packages/plugin',
    }
    githubItem.command = 'dsh plugin add attacker; rm -rf /'
    expect(manualInstallHint(githubItem as CatalogSnapshot['items'][number])).toBeUndefined()
  })
})

describe('market install service', () => {
  it('removes an exact startup-rolled-back receipt before acknowledging recovery', async () => {
    const profileDir = await createProfile()
    const recovered: MarketInstallReceipt = {
      receiptId: 'receipt:startup-rollback-0001',
      profileName: 'web',
      packageName,
      version,
      integrity,
      bundlePatch: './cordis.patch.yml',
      sourceRecordId: 'source-1',
      providerId: DSH_1024STORE_PROVIDER_ID,
      itemId: 'example/dsh-plugin-safe',
      displayName: 'Safe Plugin',
      installedAt: '2026-08-18T00:00:00.000Z',
    }
    const retained = { ...recovered, receiptId: 'receipt:retained-install-0001', packageName: 'retained-plugin' }
    let document: MarketSettingsDocument = { sources: [], installReceipts: [recovered, retained] }
    let failSave = true
    const events: string[] = []
    const scope: SettingsScope<MarketSettingsDocument> = {
      get: () => document,
      watch: () => () => {},
      update: vi.fn(async patch => {
        events.push('save')
        if (failSave) throw new Error('fixture settings failure')
        document = { ...document, ...patch } as MarketSettingsDocument
      }),
      replace: vi.fn(),
    }
    const base = runner(profileDir, [])
    const acknowledgeRecoveredInstall = vi.fn(async (receiptId: string) => {
      events.push(`ack:${receiptId}`)
    })
    const service = new MarketInstallService(
      scope,
      () => ({ name: 'web', dir: profileDir }),
      {
        ...base,
        recoveredInstallReceiptIds: vi.fn(async () => [recovered.receiptId]),
        acknowledgeRecoveredInstall,
      },
      { verify: vi.fn(async () => verification) },
    )

    await expect(service.listReceipts()).rejects.toThrow('fixture settings failure')
    expect(acknowledgeRecoveredInstall).not.toHaveBeenCalled()
    expect(document.installReceipts).toEqual([recovered, retained])

    failSave = false
    await expect(service.listReceipts()).resolves.toEqual([retained])
    expect(events.slice(-2)).toEqual(['save', `ack:${recovered.receiptId}`])
    expect(acknowledgeRecoveredInstall).toHaveBeenCalledOnce()
  })

  it('uses one-shot opaque intents, fixed argv, verified bundle state, and profile receipts', async () => {
    const profileDir = await createProfile()
    const calls: Array<{ args: readonly string[]; dir: string; signal?: AbortSignal }> = []
    const settings = memoryScope()
    const verify = vi.fn(async () => verification)
    let profileName = 'web'
    const service = new MarketInstallService(
      settings.scope,
      () => ({ name: profileName, dir: profileDir }),
      runner(profileDir, calls),
      { verify },
    )
    service.observeCatalog(snapshot())

    const preview = await service.previewInstall('source-1', 'example/dsh-plugin-safe', new AbortController().signal)
    expect(preview.intent).not.toContain(packageName)
    expect(preview.intent).not.toContain(version)
    const installedResult = await service.executePreview(preview.intent, new AbortController().signal)
    if (installedResult.action !== 'install') throw new Error('expected install result')
    const installed = installedResult
    expect(calls[0]).toMatchObject({
      args: ['add', '--save-exact', '--registry=https://registry.npmjs.org/', `${packageName}@${version}`],
      dir: profileDir,
    })
    expect(verify).toHaveBeenCalledTimes(2)
    expect(installed.receipt.integrity).toBe(integrity)
    expect(installed.restartToken).not.toContain(packageName)
    expect(settings.receipts()).toEqual([installed.receipt])
    await expect(service.executePreview(preview.intent, new AbortController().signal)).rejects.toMatchObject({
      code: 'intent-expired',
    })
    service.consumeRestartToken(installed.restartToken)
    expect(() => service.consumeRestartToken(installed.restartToken)).toThrow(/already used/u)

    const uninstall = await service.previewUninstall(installed.receipt.receiptId, new AbortController().signal)
    const removed = await service.executePreview(uninstall.intent, new AbortController().signal)
    if (removed.action !== 'uninstall') throw new Error('expected uninstall result')
    expect(calls[1]).toMatchObject({ args: ['remove', packageName], dir: profileDir })
    expect(removed.receiptId).toBe(installed.receipt.receiptId)
    profileName = 'other'
    expect(() => service.consumeRestartToken(removed.restartToken)).toThrow(/active desktop profile changed/u)
    expect(settings.receipts()).toEqual([])
  })

  it('restores an installed receipt through a new service and file-backed settings context', async () => {
    const profileDir = await createProfile()
    const settingsPath = join(profileDir, 'settings.yaml')
    const firstContext = new Context()
    await firstContext.plugin(FileSettingsProvider, { path: settingsPath, watch: false })
    const firstService = new MarketInstallService(
      registerMarketSettings(firstContext),
      () => ({ name: 'web', dir: profileDir }),
      runner(profileDir, []),
      { verify: vi.fn(async () => verification) },
    )
    firstService.observeCatalog(snapshot())
    const preview = await firstService.previewInstall(
      'source-1',
      'example/dsh-plugin-safe',
      new AbortController().signal,
    )
    const installed = await firstService.executeInstall(preview.intent, new AbortController().signal)
    firstService.dispose()
    await firstContext.fiber.dispose()

    const secondContext = new Context()
    await secondContext.plugin(FileSettingsProvider, { path: settingsPath, watch: false })
    const secondService = new MarketInstallService(
      registerMarketSettings(secondContext),
      () => ({ name: 'web', dir: profileDir }),
      runner(profileDir, []),
      { verify: vi.fn(async () => verification) },
    )
    try {
      await expect(secondService.listReceipts()).resolves.toEqual([installed.receipt])
    } finally {
      secondService.dispose()
      await secondContext.fiber.dispose()
    }
  })

  it('lists structural catalog candidates independently of profile, receipt, and disabled state without registry fan-out', async () => {
    const profileDir = await createProfile()
    await writeFile(join(profileDir, 'package.json'), JSON.stringify({
      name: 'fixture-profile',
      dependencies: { [`${packageName}-0`]: version },
      dsh: { profile: { bundles: [`${packageName}-0`] } },
    }))
    const receipt: MarketInstallReceipt = {
      receiptId: 'receipt:list-state-independent-0001',
      profileName: 'web',
      packageName: `${packageName}-1`,
      version,
      integrity,
      bundlePatch: './cordis.patch.yml',
      sourceRecordId: 'source-1',
      providerId: DSH_1024STORE_PROVIDER_ID,
      itemId: `example/${packageName}-1`,
      displayName: 'Safe Plugin 1',
      installedAt: '2026-08-18T00:00:00.000Z',
    }
    const verifier = {
      verify: vi.fn(async () => verification),
    }
    const recoveredInstallReceiptIds = vi.fn(async () => [receipt.receiptId])
    const acknowledgeRecoveredInstall = vi.fn(async () => {})
    const currentProfile = vi.fn(() => ({ name: 'web', dir: profileDir }))
    const disabledPackageNames = vi.fn(() => [`${packageName}-2`])
    const service = new MarketInstallService(
      memoryScope([receipt]).scope,
      currentProfile,
      {
        ...runner(profileDir, []),
        recoveredInstallReceiptIds,
        acknowledgeRecoveredInstall,
      },
      verifier,
      { disabledPackageNames },
    )
    const index = fullIndex(snapshotWithCandidates(7))
    const installable = await service.listInstallable(index, new AbortController().signal)
    expect(installable.items.map(target => target.package?.name)).toEqual([
      `${packageName}-0`,
      `${packageName}-1`,
      `${packageName}-2`,
      `${packageName}-3`,
      `${packageName}-4`,
      `${packageName}-5`,
      `${packageName}-6`,
    ])
    expect(installable.items[0]).toMatchObject({
      id: `example/${packageName}-0`,
      latestVersion: version,
    })
    await expect(service.listInstallable(index, new AbortController().signal)).resolves.toMatchObject({ items: installable.items })
    expect(verifier.verify).not.toHaveBeenCalled()
    expect(currentProfile).not.toHaveBeenCalled()
    expect(disabledPackageNames).not.toHaveBeenCalled()
    expect(recoveredInstallReceiptIds).not.toHaveBeenCalled()
    expect(acknowledgeRecoveredInstall).not.toHaveBeenCalled()
  })

  it('returns the complete local catalog beyond the former 2048-candidate cap', async () => {
    const profileDir = await createProfile()
    const verifier = { verify: vi.fn(async () => verification) }
    const service = new MarketInstallService(
      memoryScope().scope,
      () => ({ name: 'web', dir: profileDir }),
      runner(profileDir, []),
      verifier,
    )
    const index = fullIndex(snapshotWithCandidates(2_050))
    const first = await service.listInstallable(index, new AbortController().signal)
    expect(verifier.verify).not.toHaveBeenCalled()
    expect(first.items).toHaveLength(2_050)
    expect(first.items.some(target => target.package?.name === `${packageName}-0`)).toBe(true)
    expect(first.items.some(target => target.package?.name === `${packageName}-2049`)).toBe(true)
    const second = await service.listInstallable(index, new AbortController().signal)
    expect(verifier.verify).not.toHaveBeenCalled()
    expect(second.items).toHaveLength(2_050)
  })

  it('prunes candidates removed from a newer complete index', async () => {
    const profileDir = await createProfile()
    const service = new MarketInstallService(
      memoryScope().scope,
      () => ({ name: 'web', dir: profileDir }),
      runner(profileDir, []),
      { verify: vi.fn(async () => verification) },
    )
    await service.listInstallable(fullIndex(snapshotWithCandidates(2), 'scan-before'), new AbortController().signal)
    await service.listInstallable(fullIndex(snapshotWithCandidates(1), 'scan-after'), new AbortController().signal)

    await expect(service.previewInstall(
      'source-1',
      `example/${packageName}-1`,
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'not-available' })
  })

  it('honors cancellation and disposal before local installable filtering', async () => {
    const profileDir = await createProfile()
    const service = new MarketInstallService(
      memoryScope().scope,
      () => ({ name: 'web', dir: profileDir }),
      runner(profileDir, []),
      {
        verify: vi.fn(async () => verification),
      },
    )
    const controller = new AbortController()
    controller.abort(new DOMException('fixture abort', 'AbortError'))
    await expect(service.listInstallable(fullIndex(snapshot()), controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' })
    service.dispose()
    await expect(service.listInstallable(fullIndex(snapshot()), new AbortController().signal))
      .rejects.toMatchObject({ code: 'operation-failed' })
  })

  it('rejects prerelease targets while allowing normalized standard-source candidates', async () => {
    const profileDir = await createProfile()
    const settings = memoryScope()
    const service = new MarketInstallService(
      settings.scope,
      () => ({ name: 'web', dir: profileDir }),
      runner(profileDir, []),
      { verify: vi.fn(async () => verification) },
    )
    service.observeCatalog(snapshot({ latestVersion: '1.2.3-beta.1' }))
    await expect(service.previewInstall('source-1', 'example/dsh-plugin-safe', new AbortController().signal))
      .rejects.toMatchObject({ code: 'not-available' })
    const standardSnapshot = {
      ...snapshot(),
      source: { ...snapshot().source, adapterId: 'market.standard-http-v1' },
    }
    service.observeCatalog(standardSnapshot)
    await expect(service.previewInstall('source-1', 'example/dsh-plugin-safe', new AbortController().signal))
      .resolves.toMatchObject({ packageName, version })
  })

  it('blocks product-owned packages and pins both registries for scoped targets', async () => {
    const profileDir = await createProfile()
    const calls: Array<{ args: readonly string[]; dir: string }> = []
    const service = new MarketInstallService(
      memoryScope().scope,
      () => ({ name: 'web', dir: profileDir }),
      runner(profileDir, calls, { exitCode: 1, signal: null }),
      { verify: vi.fn(async () => verification) },
    )
    for (const reservedPackage of ['dsh-plugin-desktop', 'dsh-community-market']) {
      service.observeCatalog(snapshot({
        name: reservedPackage,
        package: { registry: 'npm', name: reservedPackage },
      }))
      await expect(service.previewInstall('source-1', 'example/dsh-plugin-safe', new AbortController().signal))
        .rejects.toMatchObject({ code: 'not-available' })
    }

    const scopedPackage = '@example/dsh-plugin-safe'
    service.observeCatalog(snapshot({
      name: scopedPackage,
      package: { registry: 'npm', name: scopedPackage },
    }))
    const preview = await service.previewInstall('source-1', 'example/dsh-plugin-safe', new AbortController().signal)
    await expect(service.executeInstall(preview.intent, new AbortController().signal)).rejects.toMatchObject({
      code: 'operation-failed',
      message: 'The desktop package manager did not complete successfully.',
    })
    expect(calls[0]?.args).toEqual([
      'add',
      '--save-exact',
      '--registry=https://registry.npmjs.org/',
      '--@example:registry=https://registry.npmjs.org/',
      `${scopedPackage}@${version}`,
    ])
  })

  it('refuses changed profile state and nonzero package-manager outcomes without issuing receipts', async () => {
    const profileDir = await createProfile()
    const calls: Array<{ args: readonly string[]; dir: string }> = []
    const settings = memoryScope()
    const service = new MarketInstallService(
      settings.scope,
      () => ({ name: 'web', dir: profileDir }),
      runner(profileDir, calls, { exitCode: 1, signal: null }),
      { verify: vi.fn(async () => verification) },
    )
    service.observeCatalog(snapshot())
    const preview = await service.previewInstall('source-1', 'example/dsh-plugin-safe', new AbortController().signal)
    await expect(service.executeInstall(preview.intent, new AbortController().signal)).rejects.toMatchObject({
      code: 'operation-failed',
    })
    expect(settings.receipts()).toEqual([])
    expect(JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8')).dependencies).toEqual({})
  })

  it('rolls back a direct dependency written before a nonzero add outcome', async () => {
    const profileDir = await createProfile()
    const calls: string[] = []
    const settings = memoryScope()
    const pnpm = recoverableRunner(profileDir, {
      runPlugin(args) {
        calls.push(args[0]!)
        const done = (async () => {
          if (args[0] === 'add') {
            await writeInstalledPlugin(profileDir)
            return { exitCode: 1, signal: null }
          }
          await removeInstalledPlugin(profileDir)
          return { exitCode: 0, signal: null }
        })()
        return { stdout: Readable.from([]), stderr: Readable.from([]), done, cancel: vi.fn() }
      },
    })
    const service = new MarketInstallService(
      settings.scope,
      () => ({ name: 'web', dir: profileDir }),
      pnpm,
      { verify: vi.fn(async () => verification) },
    )
    service.observeCatalog(snapshot())
    const preview = await service.previewInstall('source-1', 'example/dsh-plugin-safe', new AbortController().signal)
    await expect(service.executeInstall(preview.intent, new AbortController().signal)).rejects.toMatchObject({
      code: 'operation-failed',
      message: expect.stringContaining('partial installation was rolled back'),
    })
    expect(calls).toEqual(['add', 'remove'])
    expect(settings.receipts()).toEqual([])
    expect(JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8')).dependencies).toEqual({})
  })

  it('rolls back a direct dependency written before a rejected add completion', async () => {
    const profileDir = await createProfile()
    const calls: string[] = []
    const settings = memoryScope()
    const pnpm = recoverableRunner(profileDir, {
      runPlugin(args) {
        calls.push(args[0]!)
        const done = (async () => {
          if (args[0] === 'add') {
            await writeInstalledPlugin(profileDir)
            throw new Error('pnpm stream failed')
          }
          await removeInstalledPlugin(profileDir)
          return { exitCode: 0, signal: null }
        })()
        return { stdout: Readable.from([]), stderr: Readable.from([]), done, cancel: vi.fn() }
      },
    })
    const service = new MarketInstallService(
      settings.scope,
      () => ({ name: 'web', dir: profileDir }),
      pnpm,
      { verify: vi.fn(async () => verification) },
    )
    service.observeCatalog(snapshot())
    const preview = await service.previewInstall('source-1', 'example/dsh-plugin-safe', new AbortController().signal)
    await expect(service.executeInstall(preview.intent, new AbortController().signal)).rejects.toMatchObject({
      code: 'operation-failed',
    })
    expect(calls).toEqual(['add', 'remove'])
    expect(settings.receipts()).toEqual([])
  })

  it('uses an independent cleanup signal after caller cancellation follows a partial add', async () => {
    const profileDir = await createProfile()
    const controller = new AbortController()
    const calls: Array<{ readonly verb: string; readonly aborted: boolean }> = []
    const settings = memoryScope()
    const pnpm = recoverableRunner(profileDir, {
      runPlugin(args, _dir, signal) {
        calls.push({ verb: args[0]!, aborted: signal?.aborted ?? false })
        const done = (async () => {
          if (args[0] === 'add') {
            await writeInstalledPlugin(profileDir)
            controller.abort()
          } else {
            await removeInstalledPlugin(profileDir)
          }
          return { exitCode: 0, signal: null }
        })()
        return { stdout: Readable.from([]), stderr: Readable.from([]), done, cancel: vi.fn() }
      },
    })
    const service = new MarketInstallService(
      settings.scope,
      () => ({ name: 'web', dir: profileDir }),
      pnpm,
      { verify: vi.fn(async () => verification) },
    )
    service.observeCatalog(snapshot())
    const preview = await service.previewInstall('source-1', 'example/dsh-plugin-safe', controller.signal)
    await expect(service.executeInstall(preview.intent, controller.signal)).rejects.toMatchObject({
      code: 'operation-failed',
    })
    expect(calls).toEqual([
      { verb: 'add', aborted: false },
      { verb: 'remove', aborted: false },
    ])
    expect(settings.receipts()).toEqual([])
    expect(JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8')).dependencies).toEqual({})
  })

  it('uses an independent cleanup signal when disposal follows a partial add', async () => {
    const profileDir = await createProfile()
    const calls: Array<{ readonly verb: string; readonly aborted: boolean }> = []
    const settings = memoryScope()
    let service!: MarketInstallService
    const pnpm = recoverableRunner(profileDir, {
      runPlugin(args, _dir, signal) {
        calls.push({ verb: args[0]!, aborted: signal?.aborted ?? false })
        const done = (async () => {
          if (args[0] === 'add') {
            await writeInstalledPlugin(profileDir)
            service.dispose()
          } else {
            await removeInstalledPlugin(profileDir)
          }
          return { exitCode: 0, signal: null }
        })()
        return { stdout: Readable.from([]), stderr: Readable.from([]), done, cancel: vi.fn() }
      },
    })
    service = new MarketInstallService(
      settings.scope,
      () => ({ name: 'web', dir: profileDir }),
      pnpm,
      { verify: vi.fn(async () => verification) },
    )
    service.observeCatalog(snapshot())
    const preview = await service.previewInstall('source-1', 'example/dsh-plugin-safe', new AbortController().signal)
    await expect(service.executeInstall(preview.intent, new AbortController().signal)).rejects.toMatchObject({
      code: 'operation-failed',
    })
    expect(calls).toEqual([
      { verb: 'add', aborted: false },
      { verb: 'remove', aborted: false },
    ])
    expect(settings.receipts()).toEqual([])
    expect(JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8')).dependencies).toEqual({})
  })

  it('revokes candidates and their intents when a source becomes unavailable', async () => {
    const profileDir = await createProfile()
    const service = new MarketInstallService(
      memoryScope().scope,
      () => ({ name: 'web', dir: profileDir }),
      runner(profileDir, []),
      { verify: vi.fn(async () => verification) },
    )
    service.observeCatalog(snapshot())
    const preview = await service.previewInstall('source-1', 'example/dsh-plugin-safe', new AbortController().signal)
    service.invalidateSource('source-1')
    await expect(service.executeInstall(preview.intent, new AbortController().signal)).rejects.toMatchObject({
      code: 'intent-expired',
    })
  })

  it('does not issue an install intent when disposed during registry verification', async () => {
    const profileDir = await createProfile()
    let finishVerification!: (value: typeof verification) => void
    let verifierSignal: AbortSignal | undefined
    const service = new MarketInstallService(
      memoryScope().scope,
      () => ({ name: 'web', dir: profileDir }),
      runner(profileDir, []),
      {
        verify: vi.fn(async (_candidate, signal) => {
          verifierSignal = signal
          return await new Promise<typeof verification>(resolve => { finishVerification = resolve })
        }),
      },
    )
    service.observeCatalog(snapshot())
    const pending = service.previewInstall('source-1', 'example/dsh-plugin-safe', new AbortController().signal)
    await vi.waitFor(() => expect(verifierSignal).toBeInstanceOf(AbortSignal))
    service.dispose()
    expect(verifierSignal?.aborted).toBe(true)
    finishVerification(verification)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('rolls back an install whose resulting bundle does not match the verified artifact', async () => {
    const profileDir = await createProfile()
    const calls: readonly string[][] = []
    const pnpm = recoverableRunner(profileDir, {
      runPlugin(args) {
        ;(calls as string[][]).push([...args])
        const done = (async () => {
          if (args[0] === 'add') {
            await writeInstalledPlugin(profileDir)
            const packageManifestPath = join(profileDir, 'node_modules', packageName, 'package.json')
            const manifest = JSON.parse(await readFile(packageManifestPath, 'utf8')) as Record<string, unknown>
            await writeFile(packageManifestPath, JSON.stringify({ ...manifest, dsh: { bundle: { patch: './other.yml' } } }))
          } else {
            await removeInstalledPlugin(profileDir)
          }
          return { exitCode: 0, signal: null }
        })()
        return { stdout: Readable.from([]), stderr: Readable.from([]), done, cancel: vi.fn() }
      },
    })
    const settings = memoryScope()
    const service = new MarketInstallService(
      settings.scope,
      () => ({ name: 'web', dir: profileDir }),
      pnpm,
      { verify: vi.fn(async () => verification) },
    )
    service.observeCatalog(snapshot())
    const preview = await service.previewInstall('source-1', 'example/dsh-plugin-safe', new AbortController().signal)
    await expect(service.executeInstall(preview.intent, new AbortController().signal)).rejects.toMatchObject({
      code: 'operation-failed',
    })
    expect(calls.map(args => args[0])).toEqual(['add', 'remove'])
    expect(settings.receipts()).toEqual([])
    expect(JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8')).dependencies).toEqual({})
  })

  it('accepts lockfile v11 slash keys and peer-suffixed exact resolutions', async () => {
    const profileDir = await createProfile()
    const settings = memoryScope()
    const calls: string[] = []
    const pnpm = recoverableRunner(profileDir, {
      runPlugin(args) {
        calls.push(args[0]!)
        const done = (async () => {
          if (args[0] === 'add') {
            await writeInstalledPlugin(profileDir, {
              lockfileVersion: '11.0',
              importerVersion: `${version}(@deepseek-ai/cordis@4.0.1)`,
              slashPackageKey: true,
              slashSnapshotKey: true,
            })
          } else {
            await removeInstalledPlugin(profileDir)
          }
          return { exitCode: 0, signal: null }
        })()
        return { stdout: Readable.from([]), stderr: Readable.from([]), done, cancel: vi.fn() }
      },
    })
    const service = new MarketInstallService(
      settings.scope,
      () => ({ name: 'web', dir: profileDir }),
      pnpm,
      { verify: vi.fn(async () => verification) },
    )
    service.observeCatalog(snapshot())
    const preview = await service.previewInstall('source-1', 'example/dsh-plugin-safe', new AbortController().signal)
    await expect(service.executeInstall(preview.intent, new AbortController().signal)).resolves.toMatchObject({
      receipt: { packageName, version, integrity },
    })
    expect(calls).toEqual(['add'])
  })

  it('fails closed and rolls back when lockfile provenance does not match npm verification', async () => {
    const badIntegrity = `sha512-${Buffer.alloc(64, 1).toString('base64')}`
    const cases: readonly LockFixtureOptions[] = [
      { lockfileVersion: '8.0' },
      { specifier: `^${version}` },
      { importerVersion: '1.2.4' },
      { integrity: badIntegrity },
      { omitPackage: true },
      { omitSnapshot: true },
    ]
    for (const lockOptions of cases) {
      const profileDir = await createProfile()
      const settings = memoryScope()
      const calls: string[] = []
      const pnpm = recoverableRunner(profileDir, {
        runPlugin(args) {
          calls.push(args[0]!)
          const done = (async () => {
            if (args[0] === 'add') await writeInstalledPlugin(profileDir, lockOptions)
            else await removeInstalledPlugin(profileDir)
            return { exitCode: 0, signal: null }
          })()
          return { stdout: Readable.from([]), stderr: Readable.from([]), done, cancel: vi.fn() }
        },
      })
      const service = new MarketInstallService(
        settings.scope,
        () => ({ name: 'web', dir: profileDir }),
        pnpm,
        { verify: vi.fn(async () => verification) },
      )
      service.observeCatalog(snapshot())
      const preview = await service.previewInstall('source-1', 'example/dsh-plugin-safe', new AbortController().signal)
      await expect(service.executeInstall(preview.intent, new AbortController().signal)).rejects.toMatchObject({
        code: 'operation-failed',
      })
      expect(calls).toEqual(['add', 'remove'])
      expect(settings.receipts()).toEqual([])
    }
  })

  it('uses a service-owned cleanup signal when receipt persistence fails', async () => {
    const profileDir = await createProfile()
    let document: MarketSettingsDocument = { sources: [], installReceipts: [] }
    const scope = {
      get: () => document,
      watch: () => () => {},
      update: vi.fn(async () => { throw new Error('disk unavailable') }),
      replace: vi.fn(async section => { document = section as MarketSettingsDocument }),
    } as SettingsScope<MarketSettingsDocument>
    const calls: Array<{ readonly verb: string; readonly aborted: boolean }> = []
    const pnpm = recoverableRunner(profileDir, {
      runPlugin(args, _dir, signal) {
        const done = (async () => {
          calls.push({ verb: args[0]!, aborted: signal?.aborted ?? false })
          if (args[0] === 'add') {
            await writeInstalledPlugin(profileDir)
          } else {
            await removeInstalledPlugin(profileDir)
          }
          return { exitCode: 0, signal: null }
        })()
        return { stdout: Readable.from([]), stderr: Readable.from([]), done, cancel: vi.fn() }
      },
    })
    const service = new MarketInstallService(
      scope,
      () => ({ name: 'web', dir: profileDir }),
      pnpm,
      { verify: vi.fn(async () => verification) },
    )
    service.observeCatalog(snapshot())
    const preview = await service.previewInstall('source-1', 'example/dsh-plugin-safe', new AbortController().signal)
    await expect(service.executeInstall(preview.intent, new AbortController().signal)).rejects.toMatchObject({
      code: 'persistence-failed',
    })
    expect(calls).toEqual([
      { verb: 'add', aborted: false },
      { verb: 'remove', aborted: false },
    ])
  })
})

describe('market install Host routes', () => {
  it('registers the optional routes and accepts only exact local operation bodies', async () => {
    type Handler = (req: any, res: any) => Promise<void>
    const handlers = new Map<string, Handler>()
    const ctx = {
      logger: { error: vi.fn() },
      webServer: {
        port: 43_120,
        register: vi.fn((route: { path: string; handler: Handler }) => {
          handlers.set(route.path, route.handler)
          return vi.fn()
        }),
      },
    }
    const settings = memoryScope()
    const previewInstall = vi.fn(async () => ({
      intent: 'opaque-preview-id',
      action: 'install' as const,
      profileName: 'web',
      packageName,
      version,
      displayName: 'Safe Plugin',
      expiresAt: '2026-08-18T00:05:00.000Z',
    }))
    const listVerifiedReceipts = vi.fn(async (): Promise<readonly MarketInstallReceipt[]> => [])
    const install = {
      listReceipts: vi.fn(async () => []),
      listVerifiedReceipts,
      listInstallable: vi.fn(),
      previewInstall,
      previewUninstall: vi.fn(),
      executePreview: vi.fn(async () => ({ action: 'install', receipt: { receiptId: 'receipt' }, restartToken: 'restart-token' })),
      consumeRestartToken: vi.fn(),
      observeCatalog: vi.fn(),
      invalidateSource: vi.fn(),
    } as unknown as MarketInstallService
    const desktopEvents: string[] = []
    const actions = {
      openTerminal: vi.fn(),
      requestRestart: vi.fn(async () => { desktopEvents.push('restart') }),
    }
    let bundleStatus: 'active' | 'disabled' = 'active'
    const bundle = {
      bundleId: 'bundle_opaque_external',
      packageName: 'dsh-plugin-external',
      mutable: true,
    }
    const desktopPlugins = {
      list: vi.fn(() => [{ ...bundle, status: bundleStatus }]),
      isDisabled: vi.fn(() => bundleStatus === 'disabled'),
      disabledPackageNames: vi.fn(() => bundleStatus === 'disabled' ? [bundle.packageName] : []),
      previewDisable: vi.fn(() => ({
        previewId: 'disable_opaque_preview',
        profileName: 'web',
        packageName: bundle.packageName,
        expiresAt: '2099-08-18T00:05:00.000Z',
      })),
      executeDisable: vi.fn(async () => {
        bundleStatus = 'disabled'
        return { packageName: bundle.packageName }
      }),
      previewEnable: vi.fn(() => ({
        previewId: 'enable_opaque_preview',
        profileName: 'web',
        packageName: bundle.packageName,
        expiresAt: '2099-08-18T00:05:00.000Z',
      })),
      executeEnable: vi.fn(async () => {
        bundleStatus = 'active'
        return { packageName: bundle.packageName }
      }),
    }
    const dispose = registerMarketRoutes(
      ctx as never,
      settings.scope,
      { get: () => install },
      { get: () => actions },
      { get: () => desktopPlugins },
    )
    expect(handlers.has(marketRoutes.installations)).toBe(true)
    expect(handlers.has(marketRoutes.installable)).toBe(true)
    expect(handlers.has(marketRoutes.operationPreview)).toBe(true)
    expect(handlers.has(marketRoutes.operationExecute)).toBe(true)
    expect(handlers.has(marketRoutes.openTerminal)).toBe(true)
    expect(handlers.has(marketRoutes.requestRestart)).toBe(true)

    const request = async (path: string, method: string, body?: unknown) => {
      const req = Object.assign(new EventEmitter(), {
        method,
        url: path,
        headers: {
          host: '127.0.0.1:43120',
          origin: 'http://127.0.0.1:43120',
          'sec-fetch-site': 'same-origin',
        },
        socket: { remoteAddress: '127.0.0.1' },
        destroy: vi.fn(),
      })
      let responseBody = ''
      const res = Object.assign(new EventEmitter(), {
        destroyed: false,
        writableEnded: false,
        statusCode: 0,
        setHeader: vi.fn(),
        removeHeader: vi.fn(),
        end: vi.fn((value?: string) => {
          desktopEvents.push('response')
          responseBody = value ?? ''
          res.writableEnded = true
        }),
      })
      const pending = handlers.get(path)!(req, res)
      if (body !== undefined) {
        queueMicrotask(() => {
          req.emit('data', Buffer.from(JSON.stringify(body)))
          req.emit('end')
        })
      }
      await pending
      return { status: res.statusCode, body: JSON.parse(responseBody) as Record<string, unknown> }
    }

    const preview = await request(marketRoutes.operationPreview, 'POST', {
      action: 'install',
      sourceRecordId: 'source-1',
      itemId: 'example/dsh-plugin-safe',
    })
    expect(preview).toMatchObject({ status: 200, body: { previewId: 'opaque-preview-id', action: 'install' } })
    expect(preview.body).not.toHaveProperty('intent')
    expect(previewInstall).toHaveBeenCalledWith(
      'source-1',
      'example/dsh-plugin-safe',
      expect.any(AbortSignal),
    )

    const invalid = await request(marketRoutes.operationPreview, 'POST', {
      action: 'install',
      sourceRecordId: 'source-1',
      itemId: 'example/dsh-plugin-safe',
      command: 'must never be accepted',
    })
    expect(invalid).toMatchObject({ status: 400, body: { code: 'invalid-request' } })
    expect(previewInstall).toHaveBeenCalledTimes(1)

    const disablePreview = await request(marketRoutes.operationPreview, 'POST', {
      action: 'disable',
      bundleId: bundle.bundleId,
    })
    expect(disablePreview).toMatchObject({
      status: 200,
      body: {
        action: 'disable',
        packageName: bundle.packageName,
        previewId: 'disable_opaque_preview',
      },
    })
    expect(desktopPlugins.previewDisable).toHaveBeenCalledWith(bundle.bundleId)
    const invalidDisable = await request(marketRoutes.operationPreview, 'POST', {
      action: 'disable',
      bundleId: bundle.bundleId,
      packageName: bundle.packageName,
    })
    expect(invalidDisable).toMatchObject({ status: 400, body: { code: 'invalid-request' } })

    const receiptRace: MarketInstallReceipt = {
      receiptId: 'receipt-race-0001',
      profileName: 'web',
      packageName: bundle.packageName,
      version,
      integrity,
      bundlePatch: './cordis.patch.yml',
      sourceRecordId: 'source-1',
      providerId: 'provider-1',
      itemId: 'external-plugin',
      displayName: 'External Plugin',
      installedAt: '2026-08-18T00:00:00.000Z',
    }
    listVerifiedReceipts.mockResolvedValueOnce([receiptRace])
    const receiptOwned = await request(
      marketRoutes.operationExecute,
      'POST',
      { previewId: 'disable_opaque_preview' },
    )
    expect(receiptOwned).toMatchObject({ status: 409, body: { code: 'conflict' } })
    expect(desktopPlugins.executeDisable).not.toHaveBeenCalled()

    await expect(request(marketRoutes.operationPreview, 'POST', {
      action: 'disable',
      bundleId: bundle.bundleId,
    })).resolves.toMatchObject({ status: 200, body: { previewId: 'disable_opaque_preview' } })

    const executed = await request(marketRoutes.operationExecute, 'POST', { previewId: 'opaque-preview-id' })
    expect(executed.status).toBe(200)
    expect(install.executePreview).toHaveBeenCalledWith('opaque-preview-id', expect.any(AbortSignal))

    const disabled = await request(marketRoutes.operationExecute, 'POST', { previewId: 'disable_opaque_preview' })
    expect(disabled).toMatchObject({
      status: 200,
      body: { action: 'disable', packageName: bundle.packageName },
    })
    expect(desktopPlugins.executeDisable).toHaveBeenCalledWith('disable_opaque_preview')

    await expect(request(marketRoutes.openTerminal, 'POST', {})).resolves.toEqual({ status: 200, body: { ok: true } })
    expect(actions.openTerminal).toHaveBeenCalledWith()
    const invalidTerminal = await request(marketRoutes.openTerminal, 'POST', { command: 'must not run' })
    expect(invalidTerminal).toMatchObject({ status: 400, body: { code: 'invalid-request' } })
    expect(actions.openTerminal).toHaveBeenCalledOnce()

    desktopEvents.length = 0
    await expect(request(marketRoutes.requestRestart, 'POST', { restartToken: 'restart-token' }))
      .resolves.toEqual({ status: 200, body: { ok: true } })
    expect(install.consumeRestartToken).toHaveBeenCalledWith('restart-token')
    expect(actions.requestRestart).toHaveBeenCalledWith()
    expect(desktopEvents).toEqual(['response', 'restart'])

    const disableRestartToken = disabled.body.restartToken as string
    desktopEvents.length = 0
    await expect(request(marketRoutes.requestRestart, 'POST', { restartToken: disableRestartToken }))
      .resolves.toEqual({ status: 200, body: { ok: true } })
    expect(install.consumeRestartToken).toHaveBeenCalledTimes(1)
    expect(actions.requestRestart).toHaveBeenCalledTimes(2)
    expect(desktopEvents).toEqual(['response', 'restart'])

    const installations = await request(marketRoutes.installations, 'GET')
    expect(installations).toEqual({
      status: 200,
      body: {
        installations: [{
          kind: 'external',
          status: 'disabled',
          action: 'enable',
          bundleId: bundle.bundleId,
          packageName: bundle.packageName,
        }],
      },
    })

    const enablePreview = await request(marketRoutes.operationPreview, 'POST', {
      action: 'enable',
      bundleId: bundle.bundleId,
    })
    expect(enablePreview).toMatchObject({
      status: 200,
      body: {
        action: 'enable',
        packageName: bundle.packageName,
        previewId: 'enable_opaque_preview',
      },
    })
    expect(desktopPlugins.previewEnable).toHaveBeenCalledWith(bundle.bundleId)
    await expect(request(marketRoutes.operationPreview, 'POST', {
      action: 'enable',
      bundleId: bundle.bundleId,
      packageName: bundle.packageName,
    })).resolves.toMatchObject({ status: 400, body: { code: 'invalid-request' } })

    const enabled = await request(marketRoutes.operationExecute, 'POST', { previewId: 'enable_opaque_preview' })
    expect(enabled).toMatchObject({
      status: 200,
      body: { action: 'enable', packageName: bundle.packageName },
    })
    expect(desktopPlugins.executeEnable).toHaveBeenCalledWith('enable_opaque_preview')
    const enableRestartToken = enabled.body.restartToken as string
    await expect(request(marketRoutes.requestRestart, 'POST', { restartToken: enableRestartToken }))
      .resolves.toEqual({ status: 200, body: { ok: true } })
    expect(install.consumeRestartToken).toHaveBeenCalledTimes(1)

    await expect(request(marketRoutes.installations, 'GET')).resolves.toMatchObject({
      status: 200,
      body: {
        installations: [{
          kind: 'external',
          status: 'active',
          action: 'disable',
          bundleId: bundle.bundleId,
          packageName: bundle.packageName,
        }],
      },
    })

    bundleStatus = 'disabled'
    listVerifiedReceipts.mockResolvedValue([receiptRace])
    await expect(request(marketRoutes.installations, 'GET')).resolves.toMatchObject({
      status: 200,
      body: {
        installations: [{
          kind: 'managed',
          status: 'disabled',
          action: 'uninstall',
          enableBundleId: bundle.bundleId,
          receipt: { receiptId: receiptRace.receiptId },
        }],
      },
    })
    await expect(request(marketRoutes.operationPreview, 'POST', {
      action: 'enable',
      bundleId: bundle.bundleId,
    })).resolves.toMatchObject({ status: 200, body: { action: 'enable' } })
    listVerifiedReceipts.mockResolvedValue([])
    await expect(request(marketRoutes.operationExecute, 'POST', { previewId: 'enable_opaque_preview' }))
      .resolves.toMatchObject({ status: 409, body: { code: 'conflict' } })

    listVerifiedReceipts.mockResolvedValue([receiptRace])
    await expect(request(marketRoutes.operationPreview, 'POST', {
      action: 'enable',
      bundleId: bundle.bundleId,
    })).resolves.toMatchObject({ status: 200, body: { action: 'enable' } })
    await expect(request(marketRoutes.operationExecute, 'POST', { previewId: 'enable_opaque_preview' }))
      .resolves.toMatchObject({ status: 200, body: { action: 'enable' } })

    await expect(request(marketRoutes.installations, 'GET')).resolves.toMatchObject({
      status: 200,
      body: {
        installations: [{
          kind: 'managed',
          status: 'active',
          action: 'uninstall',
          disableBundleId: bundle.bundleId,
          receipt: { receiptId: receiptRace.receiptId },
        }],
      },
    })

    await expect(request(marketRoutes.operationPreview, 'POST', {
      action: 'disable',
      bundleId: bundle.bundleId,
    })).resolves.toMatchObject({ status: 200, body: { action: 'disable' } })
    listVerifiedReceipts.mockResolvedValue([{ ...receiptRace, receiptId: 'receipt-race-0002' }])
    await expect(request(marketRoutes.operationExecute, 'POST', { previewId: 'disable_opaque_preview' }))
      .resolves.toMatchObject({ status: 409, body: { code: 'conflict' } })

    listVerifiedReceipts.mockResolvedValue([receiptRace])
    await expect(request(marketRoutes.operationPreview, 'POST', {
      action: 'disable',
      bundleId: bundle.bundleId,
    })).resolves.toMatchObject({ status: 200, body: { action: 'disable' } })
    await expect(request(marketRoutes.operationExecute, 'POST', { previewId: 'disable_opaque_preview' }))
      .resolves.toMatchObject({ status: 200, body: { action: 'disable' } })
    expect(install.listInstallable).not.toHaveBeenCalled()
    dispose()
  })

  it('reconciles verified receipts with direct bundles without starting catalog verification', async () => {
    type Handler = (req: any, res: any) => Promise<void>
    const handlers = new Map<string, Handler>()
    const ctx = {
      webServer: {
        port: 43_120,
        register: vi.fn((route: { path: string; handler: Handler }) => {
          handlers.set(route.path, route.handler)
          return vi.fn()
        }),
      },
    }
    const listInstallable = vi.fn()
    const install = {
      listReceipts: vi.fn(async () => []),
      listVerifiedReceipts: vi.fn(async () => []),
      listInstallable,
      previewInstall: vi.fn(),
      previewUninstall: vi.fn(),
      executePreview: vi.fn(),
      observeCatalog: vi.fn(),
      invalidateSource: vi.fn(),
    } as unknown as MarketInstallService
    const desktopPlugins = {
      list: vi.fn(() => []),
      isDisabled: vi.fn(() => false),
      disabledPackageNames: vi.fn(() => []),
      previewDisable: vi.fn(),
      executeDisable: vi.fn(),
      previewEnable: vi.fn(),
      executeEnable: vi.fn(),
    }
    const dispose = registerMarketRoutes(
      ctx as never,
      memoryScope().scope,
      { get: () => install },
      undefined,
      { get: () => desktopPlugins },
    )
    const req = Object.assign(new EventEmitter(), {
      method: 'GET',
      url: marketRoutes.installations,
      headers: {
        host: '127.0.0.1:43120',
        origin: 'http://127.0.0.1:43120',
        'sec-fetch-site': 'same-origin',
      },
      socket: { remoteAddress: '127.0.0.1' },
      destroy: vi.fn(),
    })
    const res = Object.assign(new EventEmitter(), {
      destroyed: false,
      writableEnded: false,
      statusCode: 0,
      setHeader: vi.fn(),
      removeHeader: vi.fn(),
      end: vi.fn(),
    })
    await handlers.get(marketRoutes.installations)!(req, res)
    expect(listInstallable).not.toHaveBeenCalled()
    expect(install.listVerifiedReceipts).toHaveBeenCalledOnce()
    expect(desktopPlugins.list).toHaveBeenCalledOnce()
    expect(res.end).toHaveBeenCalledOnce()
    dispose()
  })

  it('keeps a confirmed Host operation alive after the Renderer connection closes', async () => {
    type Handler = (req: any, res: any) => Promise<void>
    const handlers = new Map<string, Handler>()
    const ctx = {
      webServer: {
        port: 43_120,
        register: vi.fn((route: { path: string; handler: Handler }) => {
          handlers.set(route.path, route.handler)
          return vi.fn()
        }),
      },
    }
    let finishOperation!: () => void
    let operationSignal: AbortSignal | undefined
    const executePreview = vi.fn(async (_previewId: string, signal: AbortSignal) => {
      operationSignal = signal
      await new Promise<void>(resolve => { finishOperation = resolve })
      return { action: 'install' as const, receipt: { receiptId: 'receipt' } }
    })
    const install = {
      listReceipts: vi.fn(async () => []),
      previewInstall: vi.fn(),
      previewUninstall: vi.fn(),
      executePreview,
      observeCatalog: vi.fn(),
      invalidateSource: vi.fn(),
    } as unknown as MarketInstallService
    const dispose = registerMarketRoutes(ctx as never, memoryScope().scope, { get: () => install })
    const req = Object.assign(new EventEmitter(), {
      method: 'POST',
      url: marketRoutes.operationExecute,
      headers: {
        host: '127.0.0.1:43120',
        origin: 'http://127.0.0.1:43120',
        'sec-fetch-site': 'same-origin',
      },
      socket: { remoteAddress: '127.0.0.1' },
      destroy: vi.fn(),
    })
    const res = Object.assign(new EventEmitter(), {
      destroyed: false,
      writableEnded: false,
      statusCode: 0,
      setHeader: vi.fn(),
      removeHeader: vi.fn(),
      end: vi.fn(),
    })

    const pending = handlers.get(marketRoutes.operationExecute)!(req, res)
    req.emit('data', Buffer.from(JSON.stringify({ previewId: 'opaque-preview-id' })))
    req.emit('end')
    await vi.waitFor(() => expect(executePreview).toHaveBeenCalledOnce())

    res.emit('close')
    expect(operationSignal?.aborted).toBe(false)
    finishOperation()
    await pending
    expect(res.end).not.toHaveBeenCalled()
    dispose()
  })
})
