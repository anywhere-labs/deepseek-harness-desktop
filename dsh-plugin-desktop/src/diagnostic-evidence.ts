const CONFIG_FILENAME = /^[A-Za-z0-9._-]+\.(?:json|ya?ml)$/u

export interface DiagnosticEvidenceSource {
  readonly errorStack?: { readonly text: string }
  readonly pluginManifest?: { readonly text: string }
  readonly versions?: { readonly text: string }
  readonly profileBundles?: { readonly text: string }
  readonly profileConfig?: { readonly filename: string; readonly text: string }
  readonly envSnapshot?: { readonly text: string }
}

export interface DiagnosticEvidenceEntry {
  readonly name: string
  readonly content: string
}

export function buildDiagnosticEvidenceEntries(
  source: DiagnosticEvidenceSource,
): readonly DiagnosticEvidenceEntry[] {
  const entries: DiagnosticEvidenceEntry[] = []
  if (source.errorStack !== undefined) {
    entries.push({ name: 'error-stack.txt', content: source.errorStack.text })
  }
  if (source.pluginManifest !== undefined) {
    entries.push({ name: 'plugin-manifest.json', content: source.pluginManifest.text })
  }
  if (source.versions !== undefined) {
    entries.push({ name: 'versions.json', content: source.versions.text })
  }
  if (source.profileBundles !== undefined) {
    entries.push({ name: 'profile-bundles.json', content: source.profileBundles.text })
  }
  if (source.profileConfig !== undefined) {
    if (!CONFIG_FILENAME.test(source.profileConfig.filename)) {
      throw new Error(`invalid config filename: ${source.profileConfig.filename}`)
    }
    entries.push({ name: `config/${source.profileConfig.filename}`, content: source.profileConfig.text })
  }
  if (source.envSnapshot !== undefined) {
    entries.push({ name: 'env-snapshot.txt', content: source.envSnapshot.text })
  }
  return entries
}
