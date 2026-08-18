import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { FileSettingsProvider } from '@deepseek-ai/dsh-settings-file'
import z from '@deepseek-ai/schemastery'
import { afterEach, describe, expect, it } from 'vitest'
import type { MarketInstallReceipt } from '../src/api-types.js'
import { DSH_1024STORE_ADAPTER_ID, DSH_1024STORE_PROVIDER_ID } from '../src/adapters/dsh-1024store.js'
import { SettingsCatalogSourceStore, type MarketSettingsDocument } from '../src/catalog/source-store.js'
import type { LocalSourceRecord } from '../src/contracts/index.js'
import { registerMarketSettings } from '../src/host/routes.js'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function temporarySettingsFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-market-settings-'))
  cleanups.push(async () => { await rm(dir, { recursive: true, force: true }) })
  return join(dir, 'settings.yaml')
}

async function bootMarketSettings(path: string) {
  const ctx = new Context()
  await ctx.plugin(FileSettingsProvider, { path, watch: false })
  let disposed = false
  const dispose = async () => {
    if (disposed) return
    disposed = true
    await ctx.fiber.dispose()
  }
  cleanups.push(dispose)
  return { ctx, scope: registerMarketSettings(ctx), dispose }
}

const source: LocalSourceRecord = {
  sourceRecordId: '018f1f77-a5c4-7b73-a9ae-0242ac120002',
  registrationKind: 'built-in',
  adapterId: DSH_1024STORE_ADAPTER_ID,
  providerId: DSH_1024STORE_PROVIDER_ID,
  builtInProviderKey: 'dsh-1024store',
  enabled: true,
  order: 0,
}

const receipt: MarketInstallReceipt = {
  receiptId: '018f1f77-a5c4-7b73-a9ae-0242ac120099',
  profileName: 'web',
  packageName: 'dsh-plugin-persistent',
  version: '1.2.3',
  integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
  bundlePatch: './cordis.patch.yml',
  sourceRecordId: source.sourceRecordId,
  providerId: source.providerId,
  itemId: 'example/dsh-plugin-persistent',
  displayName: 'Persistent Plugin',
  installedAt: '2026-08-18T00:00:00.000Z',
}

const SiblingSchema = z.object({ label: z.string().default('default') })
const SIBLING_NAMESPACE = settingsNamespace('market-persistence-fixture')

describe('community market file-backed settings', () => {
  it('restores sources and install receipts in a new Host context', async () => {
    const path = await temporarySettingsFile()
    const first = await bootMarketSettings(path)

    await first.scope.replace({ sources: [source], installReceipts: [receipt] })
    await first.dispose()

    const second = await bootMarketSettings(path)
    expect(second.scope.get()).toEqual({ sources: [source], installReceipts: [receipt] } satisfies MarketSettingsDocument)
  })

  it('preserves install receipts when the source store persists a change', async () => {
    const path = await temporarySettingsFile()
    const first = await bootMarketSettings(path)
    await first.scope.replace({ sources: [], installReceipts: [receipt] })

    await new SettingsCatalogSourceStore(first.scope).save([source])
    await first.dispose()

    const second = await bootMarketSettings(path)
    expect(second.scope.get()).toEqual({ sources: [source], installReceipts: [receipt] } satisfies MarketSettingsDocument)
  })

  it('preserves another plugin namespace while persisting market settings', async () => {
    const path = await temporarySettingsFile()
    const first = await bootMarketSettings(path)
    const firstSibling = first.ctx.settings.register(SIBLING_NAMESPACE, SiblingSchema)
    await firstSibling.update({ label: 'retained across restart' })

    await first.scope.replace({ sources: [source], installReceipts: [receipt] })
    await first.dispose()

    const second = await bootMarketSettings(path)
    const secondSibling = second.ctx.settings.register(SIBLING_NAMESPACE, SiblingSchema)
    expect(secondSibling.get()).toEqual({ label: 'retained across restart' })
    expect(second.scope.get()).toEqual({ sources: [source], installReceipts: [receipt] } satisfies MarketSettingsDocument)
  })
})
