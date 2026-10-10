/** Desktop records metadata from public official readers; it owns no inspection model. */
import type { Context } from '@deepseek-ai/cordis'
import { readPluginInventory } from '@deepseek-ai/dsh-host-plugin-inventory'
import type {} from '@deepseek-ai/dsh-experimental-inspector'
import type { LogInput } from '../log-record.ts'

type RecordDiagnostic = (input: LogInput) => void
const active = (ctx: Context): boolean => ctx.fiber?.state !== 4 && ctx.fiber?.state !== 5

/** Keep the official inventory's enablement and named phases, including ancestor enablement. */
export async function recordOfficialPluginInventory(ctx: Context, record: RecordDiagnostic, entryId?: string): Promise<void> {
  if (!ctx.get('loader')) return
  try {
    const inventory = await readPluginInventory(ctx)
    if (!active(ctx)) return
    for (const entry of inventory.entries) {
      if (entryId !== undefined && entry.entryId !== entryId) continue
      record({ source: 'host.plugins', event: entryId === undefined ? 'plugin.snapshot' : 'plugin.state', developer: true,
        fields: { api: 'readPluginInventory', pluginId: entry.entryId, module: entry.moduleName,
          enabled: entry.enabled, fiberPhase: entry.fiberPhase } })
    }
  } catch (error) {
    if (active(ctx)) record({ source: 'host.plugins', event: 'inventory.failed', level: 'warn', developer: true, error })
  }
}

/** Read only the official topology's coordinates, never activate Inspector or copy raw capture data. */
export async function recordOfficialInspector(ctx: Context, record: RecordDiagnostic): Promise<void> {
  const inspector = ctx.get('inspector')
  if (!inspector) {
    record({ source: 'host.inspector', event: 'inspector.unavailable', developer: true,
      fields: { state: 'disabled-or-not-installed' } })
    return
  }
  try {
    const tree = await inspector.cordis.getTree()
    if (!active(ctx)) return
    record({ source: 'host.inspector', event: 'inspector.snapshot', developer: true,
      fields: { api: 'ctx.inspector.cordis.getTree', schemaVersion: tree.schemaVersion,
        hostPresent: tree.host !== null, clientCount: tree.clients.length } })
    for (const realm of [...(tree.host ? [tree.host] : []), ...tree.clients]) {
      record({ source: 'host.inspector', event: 'realm.snapshot', developer: true,
        fields: { sourceId: realm.source.sourceId, kind: realm.source.kind, revision: realm.revision,
          connection: realm.connection.state, truncated: realm.truncated } })
    }
  } catch (error) {
    if (active(ctx)) record({ source: 'host.inspector', event: 'inspector.query-failed', level: 'warn', developer: true, error })
  }
}
