/** Preview and merge DSH homes. Nothing moves until the user confirms a preview token. */

import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'
import { parseDocument, stringify } from 'yaml'

/** Well-known home children the plugin can preview and merge. */
export const HOME_MIGRATION_DOMAINS = ['settings', 'sessions', 'plugins', 'storages'] as const

export type HomeMigrationDomain = (typeof HOME_MIGRATION_DOMAINS)[number]

/** One domain compared between source and current home. */
export interface HomeMigrationDomainPreview {
  readonly domain: HomeMigrationDomain
  readonly sourcePresent: boolean
  readonly targetPresent: boolean
  readonly sourceEntries: number
  readonly targetEntries: number
  readonly conflicts: readonly string[]
  /** Settings namespace names only. Values are never included. */
  readonly sourceNamespaces?: readonly string[]
}

/** User-facing preview. Paths are absolute; secrets are not. */
export interface HomeMigrationPreview {
  readonly source: string
  readonly target: string
  readonly token: string
  readonly domains: readonly HomeMigrationDomainPreview[]
}

/** Result of an explicit merge into the current home. */
export interface HomeMigrationApplyResult {
  readonly source: string
  readonly target: string
  readonly copied: readonly string[]
  readonly preserved: readonly string[]
  readonly skipped: readonly string[]
}

const SETTINGS_FILES = ['settings.yaml', 'settings.yml', 'settings.json'] as const
const DOMAIN_DIRECTORIES: Record<Exclude<HomeMigrationDomain, 'settings'>, string> = {
  sessions: 'sessions',
  plugins: 'profiles',
  storages: 'storages',
}

function assertAbsoluteDirectory(path: string, label: string): string {
  if (path.trim().length === 0) throw new Error(`${label} must be a non-empty path`)
  const resolved = resolve(path)
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new Error(`${label} must be an existing directory`)
  }
  return resolved
}

function listNames(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return []
  return readdirSync(dir).filter(name => name !== '.' && name !== '..').sort()
}

function settingsPath(home: string): string | undefined {
  for (const name of SETTINGS_FILES) {
    const path = join(home, name)
    if (existsSync(path) && statSync(path).isFile()) return path
  }
  return undefined
}

function settingsNamespaces(home: string): string[] {
  const path = settingsPath(home)
  if (path === undefined) return []
  const text = readFileSync(path, 'utf8')
  let document: unknown
  if (path.endsWith('.json')) {
    document = text.trim().length === 0 ? {} : JSON.parse(text)
  } else {
    const parsed = parseDocument(text, { prettyErrors: true })
    if (parsed.errors.length > 0) return []
    document = parsed.toJS() ?? {}
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) return []
  return Object.keys(document as Record<string, unknown>).sort()
}

function domainDirectory(home: string, domain: Exclude<HomeMigrationDomain, 'settings'>): string {
  return join(home, DOMAIN_DIRECTORIES[domain])
}

function previewToken(source: string, target: string, domains: readonly HomeMigrationDomainPreview[]): string {
  return createHash('sha256')
    .update(JSON.stringify({ source, target, domains }))
    .digest('hex')
    .slice(0, 32)
}

function previewDomain(
  source: string,
  target: string,
  domain: HomeMigrationDomain,
): HomeMigrationDomainPreview {
  if (domain === 'settings') {
    const sourcePath = settingsPath(source)
    const targetPath = settingsPath(target)
    const sourceNamespaces = settingsNamespaces(source)
    const targetNamespaces = settingsNamespaces(target)
    const conflicts = sourceNamespaces.filter(name => targetNamespaces.includes(name))
    return {
      domain,
      sourcePresent: sourcePath !== undefined,
      targetPresent: targetPath !== undefined,
      sourceEntries: sourceNamespaces.length,
      targetEntries: targetNamespaces.length,
      conflicts,
      sourceNamespaces,
    }
  }
  const sourceDir = domainDirectory(source, domain)
  const targetDir = domainDirectory(target, domain)
  const sourceNames = listNames(sourceDir)
  const targetNames = new Set(listNames(targetDir))
  return {
    domain,
    sourcePresent: existsSync(sourceDir),
    targetPresent: existsSync(targetDir),
    sourceEntries: sourceNames.length,
    targetEntries: targetNames.size,
    conflicts: sourceNames.filter(name => targetNames.has(name)),
  }
}

/** Compare source and current homes without reading secret values. */
export function previewHomeMigration(source: string, target: string): HomeMigrationPreview {
  const resolvedSource = assertAbsoluteDirectory(source, 'source home')
  const resolvedTarget = assertAbsoluteDirectory(target, 'current home')
  if (resolvedSource === resolvedTarget) throw new Error('source home and current home must be different')
  const domains = HOME_MIGRATION_DOMAINS.map(domain => previewDomain(resolvedSource, resolvedTarget, domain))
  return {
    source: resolvedSource,
    target: resolvedTarget,
    token: previewToken(resolvedSource, resolvedTarget, domains),
    domains,
  }
}

function copyMissingTree(
  sourceDir: string,
  targetDir: string,
  stamp: string,
  copied: string[],
  preserved: string[],
): void {
  if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) return
  mkdirSync(targetDir, { recursive: true })
  for (const name of listNames(sourceDir)) {
    const from = join(sourceDir, name)
    const to = join(targetDir, name)
    const fromStat = statSync(from)
    if (fromStat.isDirectory()) {
      copyMissingTree(from, to, stamp, copied, preserved)
      continue
    }
    if (!fromStat.isFile()) continue
    if (!existsSync(to)) {
      copyFileSync(from, to)
      copied.push(relative(targetDir, to).split(sep).join('/'))
      continue
    }
    const sibling = join(targetDir, `${basename(to)}.imported-${stamp}`)
    copyFileSync(from, sibling)
    preserved.push(relative(targetDir, sibling).split(sep).join('/'))
  }
}

function mergeSettingsDocument(sourceHome: string, targetHome: string, stamp: string): {
  copied: string[]
  preserved: string[]
} {
  const sourcePath = settingsPath(sourceHome)
  if (sourcePath === undefined) return { copied: [], preserved: [] }
  const targetName = SETTINGS_FILES.find(name => existsSync(join(targetHome, name))) ?? 'settings.yaml'
  const targetPath = join(targetHome, targetName)
  if (!existsSync(targetPath)) {
    copyFileSync(sourcePath, targetPath)
    return { copied: [targetName], preserved: [] }
  }
  const sourceText = readFileSync(sourcePath, 'utf8')
  const targetText = readFileSync(targetPath, 'utf8')
  const sourceDoc = sourcePath.endsWith('.json')
    ? (sourceText.trim().length === 0 ? {} : JSON.parse(sourceText))
    : (parseDocument(sourceText, { prettyErrors: true }).toJS() ?? {})
  const targetDoc = targetPath.endsWith('.json')
    ? (targetText.trim().length === 0 ? {} : JSON.parse(targetText))
    : (parseDocument(targetText, { prettyErrors: true }).toJS() ?? {})
  if (typeof sourceDoc !== 'object' || sourceDoc === null || Array.isArray(sourceDoc)) {
    return { copied: [], preserved: [] }
  }
  if (typeof targetDoc !== 'object' || targetDoc === null || Array.isArray(targetDoc)) {
    return { copied: [], preserved: [] }
  }
  const sourceMap = sourceDoc as Record<string, unknown>
  const targetMap = targetDoc as Record<string, unknown>
  const added: string[] = []
  const conflicts: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(sourceMap)) {
    if (!(key in targetMap)) {
      targetMap[key] = value
      added.push(key)
      continue
    }
    conflicts[key] = value
  }
  if (added.length > 0) {
    if (targetPath.endsWith('.json')) {
      writeFileSync(targetPath, `${JSON.stringify(targetMap, null, 2)}\n`)
    } else {
      writeFileSync(targetPath, `${stringify(targetMap)}\n`)
    }
  }
  const preserved: string[] = []
  if (Object.keys(conflicts).length > 0) {
    const sidecar = join(targetHome, `settings.import-conflicts-${stamp}.yaml`)
    writeFileSync(sidecar, `${stringify({
      note: 'Conflicting namespaces were left in the current home. This file lists names only.',
      namespaces: Object.keys(conflicts),
    })}\n`)
    preserved.push(basename(sidecar))
  }
  return { copied: added.map(key => `${targetName}:${key}`), preserved }
}

/**
 * Merge source into the current home after the caller repeats a fresh preview token.
 * Conflicting files are preserved beside the destination instead of overwritten.
 */
export function applyHomeMigration(
  source: string,
  target: string,
  token: string,
): HomeMigrationApplyResult {
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('home migration requires the preview token')
  }
  const preview = previewHomeMigration(source, target)
  if (preview.token !== token) throw new Error('home migration preview is stale; preview again')
  const stamp = new Date().toISOString().replaceAll(':', '').replaceAll('.', '')
  const copied: string[] = []
  const preserved: string[] = []
  const settings = mergeSettingsDocument(preview.source, preview.target, stamp)
  copied.push(...settings.copied)
  preserved.push(...settings.preserved)
  for (const domain of ['sessions', 'plugins', 'storages'] as const) {
    copyMissingTree(
      domainDirectory(preview.source, domain),
      domainDirectory(preview.target, domain),
      stamp,
      copied,
      preserved,
    )
  }
  return {
    source: preview.source,
    target: preview.target,
    copied,
    preserved,
    skipped: [],
  }
}
