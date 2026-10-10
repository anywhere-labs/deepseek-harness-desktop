/** Retire Scheduled Tasks choices written for the upstream optional bundle. */
import { isMap, isSeq, parseDocument } from 'yaml'

/**
 * Optional bundle 0.2.0-rc.2 offered for Scheduled Tasks. Upstream removed it and
 * the Web composition now mounts `schedule` and `ui-schedule` itself.
 */
export const RETIRED_SCHEDULE_BUNDLE = '@deepseek-ai/dsh-experimental-schedule-bundle'
const CLOCK_ROW = 'time-context'
const CLOCK_MODULE = '@deepseek-ai/dsh-time-context'

/**
 * Drop top-level overrides on the `time-context` row: the clock now belongs to
 * the agent presets, so such an entry matches no row. Overrides on `schedule`
 * and `ui-schedule` stay because the Web composition carries both rows.
 * Returns undefined when the patch has no such override.
 */
export function retiredSchedulePatch(text: string): string | undefined {
  // Same comment-preserving dialect as the official manager; !!js is never evaluated here.
  const document = parseDocument(text, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] })
  if (document.errors[0]) throw document.errors[0]
  if (!isSeq(document.contents)) throw new Error('Profile patch must be a YAML sequence')
  const items = document.contents.items
  const stale: number[] = []
  items.forEach((item, index) => {
    // A user insert of the module is a new row, not an override; leave it alone.
    if (!isMap(item) || item.has('insert')) return
    if (document.getIn([index, 'id']) !== CLOCK_ROW) return
    const name = document.getIn([index, 'name'])
    if (name && name !== CLOCK_MODULE) return
    stale.push(index)
  })
  if (!stale.length) return undefined
  for (const index of stale.reverse()) items.splice(index, 1)
  return String(document)
}
