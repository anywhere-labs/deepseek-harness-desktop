import { CatalogContractError, semanticIssue } from './errors.js'
import type { CatalogProviderPage } from './generated/catalog-provider-page.js'
import type {
  CatalogIdentityChoice,
  NormalizedPackageIdentity,
  NormalizedRepositoryIdentity,
} from './types.js'

type CatalogItem = CatalogProviderPage['items'][number]
type RepositoryIdentity = NonNullable<CatalogItem['repository']>
type PackageIdentity = NonNullable<CatalogItem['package']>

function normalizeSubdirectory(value: string): string {
  if (value.startsWith('/') || value.endsWith('/') || value.includes('\\')) {
    throw new CatalogContractError('identity', [
      semanticIssue('/repository/subdirectory', 'must be a relative POSIX path'),
    ])
  }

  const segments = value.split('/')
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw new CatalogContractError('identity', [
      semanticIssue('/repository/subdirectory', 'must not contain empty, dot, or parent segments'),
    ])
  }
  for (const segment of segments) {
    let decoded: string
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      throw new CatalogContractError('identity', [
        semanticIssue('/repository/subdirectory', 'contains invalid percent encoding'),
      ])
    }
    if (decoded.includes('/') || decoded.includes('\\') || decoded === '.' || decoded === '..') {
      throw new CatalogContractError('identity', [
        semanticIssue('/repository/subdirectory', 'contains an encoded path separator or dot segment'),
      ])
    }
  }

  return segments.join('/')
}

export function normalizeRepositoryIdentity(repository: RepositoryIdentity): NormalizedRepositoryIdentity {
  let url: URL
  try {
    url = new URL(repository.url)
  } catch {
    throw new CatalogContractError('identity', [semanticIssue('/repository/url', 'must be an absolute URL')])
  }

  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new CatalogContractError('identity', [
      semanticIssue('/repository/url', 'must be credential-free HTTPS without query or fragment'),
    ])
  }

  const pathSegments = url.pathname.split('/').filter(Boolean)
  if (pathSegments.length === 0) {
    throw new CatalogContractError('identity', [
      semanticIssue('/repository/url', 'must identify a repository path'),
    ])
  }

  let path = `/${pathSegments.join('/')}`.replace(/\.git$/iu, '')
  if (url.hostname === 'github.com') {
    if (pathSegments.length !== 2) {
      throw new CatalogContractError('identity', [
        semanticIssue('/repository/url', 'GitHub repository URLs must contain exactly owner and repository'),
      ])
    }
    path = `/${pathSegments.map(segment => segment.toLowerCase()).join('/')}`.replace(/\.git$/u, '')
  }

  url.pathname = path
  const normalized: NormalizedRepositoryIdentity = { url: url.toString().replace(/\/$/u, '') }
  if (repository.subdirectory !== undefined) {
    return { ...normalized, subdirectory: normalizeSubdirectory(repository.subdirectory) }
  }
  return normalized
}

export function normalizePackageIdentity(packageIdentity: PackageIdentity): NormalizedPackageIdentity {
  return { registry: 'npm', name: packageIdentity.name }
}

export function catalogIdentityChoices(item: CatalogItem): readonly CatalogIdentityChoice[] {
  const choices: CatalogIdentityChoice[] = []
  if (item.package) {
    choices.push({ kind: 'package', package: normalizePackageIdentity(item.package) })
  }
  if (item.repository) {
    choices.push({ kind: 'repository', repository: normalizeRepositoryIdentity(item.repository) })
  }
  return choices
}
