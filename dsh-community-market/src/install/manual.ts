import type { MarketManualInstallHint } from '../api-types.js'
import type { CatalogSnapshot } from '../contracts/index.js'

type CatalogItem = CatalogSnapshot['items'][number]

const NPM_PACKAGE_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u
const STABLE_VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u
function identity(item: CatalogItem): Pick<MarketManualInstallHint, 'sourceRecordId' | 'providerId' | 'itemId'> {
  return {
    sourceRecordId: item.provenance.sourceRecordId,
    providerId: item.provenance.providerId,
    itemId: item.id,
  }
}

/**
 * Reconstruct a display-only command from Host-normalized identity.
 * Provider-supplied command strings never enter this function or its result.
 */
export function manualInstallHint(item: CatalogItem): MarketManualInstallHint | undefined {
  if (
    item.package?.registry === 'npm'
    && NPM_PACKAGE_PATTERN.test(item.package.name)
    && typeof item.latestVersion === 'string'
    && STABLE_VERSION_PATTERN.test(item.latestVersion)
  ) {
    return {
      ...identity(item),
      kind: 'npm',
      mutable: false,
      desktopVerification: 'not-verified',
      displayCommand: `dsh plugin add --save-exact ${item.package.name}@${item.latestVersion}`,
    }
  }

  // A repository identity alone does not prove that the repository contains a
  // DSH plugin entry. GitHub instructions require an adapter-owned,
  // structured install-method sidecar and are deliberately omitted until that
  // evidence crosses the Host boundary.
  return undefined
}

export function manualInstallHints(items: readonly CatalogItem[]): readonly MarketManualInstallHint[] {
  return items.flatMap(item => {
    const hint = manualInstallHint(item)
    return hint === undefined ? [] : [hint]
  })
}
