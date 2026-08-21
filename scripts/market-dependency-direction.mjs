import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s*)['"]([^'"]+)['"]/gu
const DESKTOP_MODULE = /(?:^|\/)dsh-plugin-desktop(?:\/|$)/u

function normalizePath(path) {
  return path.replaceAll('\\', '/')
}

export function verifyMarketDependencyDirection(files) {
  const violations = []
  for (const [path, source] of files) {
    for (const match of source.matchAll(IMPORT_SPECIFIER)) {
      const specifier = match[1] ?? ''
      if (DESKTOP_MODULE.test(normalizePath(specifier))) {
        violations.push(normalizePath(path))
        break
      }
    }
  }
  if (violations.length > 0) {
    throw new Error(`Market source must not import Desktop implementation: ${violations.join(', ')}`)
  }
  return { fileCount: files.length }
}

export function verifyTrackedMarketDependencyDirection(root) {
  const paths = execFileSync('git', ['ls-files', '-z', '--', 'dsh-community-market/src'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .split('\0')
    .filter(path => /\.[cm]?[jt]sx?$/u.test(path))
    .map(normalizePath)
  return verifyMarketDependencyDirection(
    paths.map(path => [path, readFileSync(resolve(root, path), 'utf8')]),
  )
}
