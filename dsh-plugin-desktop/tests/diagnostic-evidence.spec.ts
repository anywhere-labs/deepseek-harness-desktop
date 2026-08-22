import { describe, expect, it } from 'vitest'
import {
  buildDiagnosticEvidenceEntries,
  type DiagnosticEvidenceSource,
} from '../src/diagnostic-evidence.ts'

describe('diagnostic evidence entries', () => {
  it('encodes each present source under the archive layout name and skips absent ones', () => {
    const source: DiagnosticEvidenceSource = {
      errorStack: { text: 'Error: Cannot find module \'plugin-x\'\n  at boot (main.ts:831)' },
      pluginManifest: { text: '[]' },
      versions: { text: 'upstream: a1b2c3\nnode: 22' },
      profileBundles: { text: '{"bundles":[]}' },
      profileConfig: { filename: 'package.json', text: '{}' },
      envSnapshot: { text: 'DSH_TELEMETRY_DISABLED=1' },
    }
    expect(buildDiagnosticEvidenceEntries(source)).toEqual([
      { name: 'error-stack.txt', content: source.errorStack!.text },
      { name: 'plugin-manifest.json', content: source.pluginManifest!.text },
      { name: 'versions.json', content: source.versions!.text },
      { name: 'profile-bundles.json', content: source.profileBundles!.text },
      { name: 'config/package.json', content: source.profileConfig!.text },
      { name: 'env-snapshot.txt', content: source.envSnapshot!.text },
    ])
  })

  it('returns an empty array for an empty source', () => {
    expect(buildDiagnosticEvidenceEntries({})).toEqual([])
  })

  it('rejects a config filename that is not a bare basename', () => {
    expect(() => buildDiagnosticEvidenceEntries({
      profileConfig: { filename: '../escape.txt', text: 'x' },
    })).toThrow(/invalid config filename/u)
  })
})
