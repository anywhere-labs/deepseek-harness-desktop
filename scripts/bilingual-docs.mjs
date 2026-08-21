import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'

const HASH_PATTERN = /^[0-9a-f]{40}$/u
const DOCUMENT_PATTERN = /\.mdx?$/u

function normalizePath(path) {
  return path.replaceAll('\\', '/')
}

function runGit(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

export function parseBilingualRecord(recordPath, content) {
  const entries = []
  for (const [index, line] of content.split(/\r?\n/u).entries()) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue
    const match = /^([^:]+):\s*([0-9a-f]{40})$/u.exec(trimmed)
    if (match === null) {
      throw new Error(`${recordPath}:${String(index + 1)} is not a filename and Git blob hash`)
    }
    const filename = match[1]?.trim() ?? ''
    const hash = match[2] ?? ''
    if (filename !== basename(filename) || isAbsolute(filename) || !DOCUMENT_PATTERN.test(filename)) {
      throw new Error(`${recordPath}:${String(index + 1)} must name one Markdown file beside the record`)
    }
    if (!HASH_PATTERN.test(hash)) {
      throw new Error(`${recordPath}:${String(index + 1)} has an invalid Git blob hash`)
    }
    entries.push({ filename, hash })
  }
  if (entries.length !== 2) {
    throw new Error(`${recordPath} must contain exactly two bilingual document records`)
  }
  if (entries[0]?.filename === entries[1]?.filename) {
    throw new Error(`${recordPath} must reference two distinct bilingual documents`)
  }
  return entries
}

export function verifyBilingualRecords({ root, recordPaths, readText, hashDocument }) {
  let documentCount = 0
  const violations = []
  for (const recordPath of recordPaths) {
    const normalizedRecord = normalizePath(recordPath)
    const recordDirectory = dirname(resolve(root, normalizedRecord))
    let entries
    try {
      entries = parseBilingualRecord(normalizedRecord, readText(resolve(root, normalizedRecord)))
    } catch (cause) {
      violations.push(cause instanceof Error ? cause.message : String(cause))
      continue
    }
    for (const entry of entries) {
      const documentPath = resolve(recordDirectory, entry.filename)
      const relativeDocument = normalizePath(relative(root, documentPath))
      if (relativeDocument.startsWith('../') || isAbsolute(relativeDocument)) {
        violations.push(`${normalizedRecord} references a document outside the repository`)
        continue
      }
      try {
        readText(documentPath)
        const actual = hashDocument(relativeDocument)
        if (actual !== entry.hash) {
          violations.push(`${normalizedRecord} is stale for ${relativeDocument}: expected ${actual}, recorded ${entry.hash}`)
        }
      } catch (cause) {
        violations.push(`${normalizedRecord} cannot verify ${relativeDocument}: ${cause instanceof Error ? cause.message : String(cause)}`)
      }
      documentCount += 1
    }
  }
  if (violations.length > 0) {
    throw new Error(`bilingual documentation gate failed:\n- ${violations.join('\n- ')}`)
  }
  return { recordCount: recordPaths.length, documentCount }
}

export function verifyTrackedBilingualRecords(root) {
  const recordPaths = runGit(root, ['ls-files', '-z', '--', '*.i18n.yaml'])
    .split('\0')
    .filter(Boolean)
    .map(normalizePath)
  return verifyBilingualRecords({
    root,
    recordPaths,
    readText: path => readFileSync(path, 'utf8'),
    hashDocument: relativePath => runGit(root, [
      'hash-object',
      `--path=${relativePath}`,
      '--',
      relativePath,
    ]).trim(),
  })
}
