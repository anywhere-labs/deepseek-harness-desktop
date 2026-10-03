/** Carry 0.1.7-rc.2 Scheduled Tasks choices onto the upstream optional bundle. */
import { isMap, isScalar, isSeq, parseDocument } from 'yaml'

/** Upstream bundle that now inserts the three rows the Web bundle used to carry disabled. */
export const SCHEDULE_BUNDLE = '@deepseek-ai/dsh-experimental-schedule-bundle'
const ROWS: Readonly<Record<string, string>> = {
  'time-context': '@deepseek-ai/dsh-time-context',
  schedule: '@deepseek-ai/dsh-schedule',
  'ui-schedule': '@deepseek-ai/dsh-client-ui-schedule',
}

/**
 * Rewrite a Profile patch written against the rc.2 Web rows. Returns undefined
 * when it carries no such row. `select` is true when any row was effectively
 * enabled; the rows the user had left off are kept off explicitly because the
 * bundle inserts them enabled.
 */
export function legacySchedulePatch(text: string): { select: boolean; text: string } | undefined {
  // Same comment-preserving dialect as the official manager; !!js is never evaluated here.
  const document = parseDocument(text, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] })
  if (document.errors[0]) throw document.errors[0]
  if (!isSeq(document.contents)) throw new Error('Profile patch must be a YAML sequence')
  const items = document.contents.items
  const legacy: number[] = []
  const enabled = new Set<string>()
  items.forEach((item, index) => {
    if (!isMap(item) || item.has('insert')) return
    const id = document.getIn([index, 'id'])
    if (typeof id !== 'string' || !Object.hasOwn(ROWS, id)) return
    const name = document.getIn([index, 'name'])
    if (name && name !== ROWS[id]) return
    legacy.push(index)
    // Later entries override earlier ones; anything but a literal `false` leaves the row off.
    if (item.has('disabled')) {
      if (document.getIn([index, 'disabled']) === false) enabled.add(id)
      else enabled.delete(id)
    }
  })
  if (!legacy.length) return undefined
  for (const index of legacy.reverse()) {
    const item = items[index]
    if (!isMap(item)) continue
    item.delete('disabled')
    // Keep user configuration for the same row; drop entries that only toggled it.
    if (item.items.every(pair => ['id', 'name'].includes(String(isScalar(pair.key) ? pair.key.value : pair.key)))) items.splice(index, 1)
  }
  const select = enabled.size > 0
  if (select) for (const id of Object.keys(ROWS)) if (!enabled.has(id)) document.add({ id, disabled: true })
  return { select, text: String(document) }
}
