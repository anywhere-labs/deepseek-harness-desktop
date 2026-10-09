/** Recovery must not depend on a running Host to recover the UI language. */
import { join } from 'node:path'
import { parseDocument } from 'yaml'
import { atomicJson, readPrivateFile } from './private-files.ts'
import { desktopLocaleFromLanguageTag, preferredDesktopLocale, type DesktopLocale } from './menu-locale.ts'

type Locale = DesktopLocale
function supported(value: unknown): Locale | undefined {
  if (typeof value !== 'string' || !/^(zh|en)(?:[-_][a-zA-Z0-9]+)*$/iu.test(value)) return undefined
  return desktopLocaleFromLanguageTag(value)
}

export class NativeLocaleStore {
  constructor(private readonly home: string) {}
  private get file(): string { return join(this.home, 'desktop-locale.json') }
  private read(): Record<string, Locale> {
    try {
      const value: unknown = JSON.parse(readPrivateFile(this.file, 64 * 1024) ?? '{}')
      if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
      return Object.fromEntries(Object.entries(value).filter(([, locale]) => supported(locale) !== undefined))
    } catch { return {} }
  }
  resolve(profile: string, fallback: string): Locale {
    // Only read literal locale overrides; never load a bundle or evaluate !!js.
    try {
      const text = readPrivateFile(join(this.home, 'profiles', profile, 'cordis.patch.yml'))
      const document = parseDocument(text ?? '[]', { logLevel: 'silent' })
      if (document.errors.length === 0) {
        const rows: unknown = document.toJS({ maxAliasCount: 100 })
        if (Array.isArray(rows)) {
          let preference: Locale | undefined
          for (const row of rows) {
            if (row?.id === 'locale' && row.disabled !== true && row.config && Object.hasOwn(row.config, 'preference')) {
              preference = supported(row.config.preference)
            }
          }
          if (preference) return preference
        }
      }
    } catch { /* Broken configuration must not prevent recovery from opening. */ }
    return supported(this.read()[profile]) ?? preferredDesktopLocale([fallback])
  }
  remember(profile: string, language: string): void {
    const locale = supported(language)
    if (!locale) return
    const saved = this.read()
    if (saved[profile] === locale) return
    atomicJson(this.file, { ...saved, [profile]: locale })
  }
}
