import type { Context } from '@deepseek-ai/cordis'
import { beforeEach, expect, it, vi } from 'vitest'
import { readPluginInventory } from '@deepseek-ai/dsh-host-plugin-inventory'
import { recordOfficialInspector, recordOfficialPluginInventory } from '../src/host/official-diagnostics.ts'

vi.mock('@deepseek-ai/dsh-host-plugin-inventory', () => ({ readPluginInventory: vi.fn() }))
beforeEach(() => vi.resetAllMocks())
function environment(inspector?: object) {
  const record = vi.fn()
  const ctx = {
    fiber: { state: 2 },
    get: (key: string) => key === 'inspector' ? inspector : key === 'loader' ? {} : undefined,
    loader: { entries: () => { throw new Error('Desktop must not reconstruct official inventory') } },
  } as unknown as Context
  return { ctx, record }
}
it('uses the official inventory projection for effective enablement and named lifecycle phases', async () => {
  const { ctx, record } = environment()
  vi.mocked(readPluginInventory).mockResolvedValue({ entries: [{ entryId: 'plugin-a', moduleName: 'example', enabled: false, fiberPhase: 'active' }] } as never)
  await recordOfficialPluginInventory(ctx, record)
  expect(readPluginInventory).toHaveBeenCalledExactlyOnceWith(ctx)
  expect(record).toHaveBeenCalledWith(expect.objectContaining({ event: 'plugin.snapshot', fields: {
    api: 'readPluginInventory', pluginId: 'plugin-a', module: 'example', enabled: false, fiberPhase: 'active',
  } }))
})
it('reads public Inspector topology metadata without starting capture or exporting content', async () => {
  const getTree = vi.fn(async () => ({ schemaVersion: 0, host: {
    source: { sourceId: 'host-a', kind: 'host' }, connection: { state: 'connected' }, revision: 4, truncated: true,
    root: { privateData: 'not exported' },
  }, clients: [] }))
  const publish = vi.fn()
  const { ctx, record } = environment({ cordis: { getTree }, publish })
  await recordOfficialInspector(ctx, record)
  expect(getTree).toHaveBeenCalledOnce()
  expect(publish).not.toHaveBeenCalled()
  expect(record.mock.calls[0]?.[0]).toMatchObject({ event: 'inspector.snapshot', fields: {
    api: 'ctx.inspector.cordis.getTree', schemaVersion: 0, hostPresent: true, clientCount: 0,
  } })
  expect(record.mock.calls[1]?.[0]).toMatchObject({ event: 'realm.snapshot', fields: {
    sourceId: 'host-a', kind: 'host', revision: 4, connection: 'connected', truncated: true,
  } })
  expect(JSON.stringify(record.mock.calls)).not.toContain('not exported')
})
it('reports an unavailable optional Inspector without falling back to private internals', async () => {
  const { ctx, record } = environment()
  await recordOfficialInspector(ctx, record)
  expect(record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ event: 'inspector.unavailable' }))
  expect(readPluginInventory).not.toHaveBeenCalled()
})
it('isolates official query failures and suppresses late snapshots after disposal', async () => {
  const failure = new Error('official query timed out')
  const getTree = vi.fn(async (): Promise<unknown> => { throw failure })
  const { ctx, record } = environment({ cordis: { getTree } })
  await expect(recordOfficialInspector(ctx, record)).resolves.toBeUndefined()
  expect(record).toHaveBeenCalledWith(expect.objectContaining({ event: 'inspector.query-failed', error: failure }))
  record.mockClear()
  const later = Promise.withResolvers<unknown>()
  getTree.mockImplementation(() => later.promise)
  const query = recordOfficialInspector(ctx, record)
  ;(ctx.fiber as unknown as { state: number }).state = 4
  later.resolve({ schemaVersion: 0, host: null, clients: [] })
  await query
  expect(record).not.toHaveBeenCalled()
})
