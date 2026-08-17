import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const fail = message => { throw new Error(`verify-market-docs: ${message}`) }
const read = path => readFileSync(resolve(packageRoot, path), 'utf8')
const manifest = JSON.parse(read('package.json'))

if (manifest.name !== 'dsh-community-market') fail('package name must remain dsh-community-market')
if (manifest.private !== true) fail('the documentation scaffold must stay private until a runtime exists')
for (const field of ['main', 'module', 'types', 'exports', 'bin', 'dsh', 'dependencies', 'optionalDependencies']) {
  if (manifest[field] !== undefined) fail(`documentation scaffold must not declare ${field}`)
}

const publicFiles = [
  'LICENSE',
  'README.i18n.yaml',
  'README.md',
  'README.zh.md',
  'SECURITY.i18n.yaml',
  'SECURITY.md',
  'SECURITY.zh.md',
  'docs/market-shell.i18n.yaml',
  'docs/market-shell.md',
  'docs/market-shell.zh.md',
]
for (const path of [...publicFiles, 'scripts/verify-docs.mjs']) {
  if (!existsSync(resolve(packageRoot, path))) fail(`${path} is missing`)
}

const expectedFiles = [
  'docs/**',
  'LICENSE',
  'README.md',
  'README.zh.md',
  'README.i18n.yaml',
  'SECURITY.md',
  'SECURITY.zh.md',
  'SECURITY.i18n.yaml',
]
if (JSON.stringify(manifest.files) !== JSON.stringify(expectedFiles)) {
  fail('package files must contain only the reviewed documentation surface')
}

const pairs = [
  ['README.i18n.yaml', ['README.md', 'README.zh.md']],
  ['SECURITY.i18n.yaml', ['SECURITY.md', 'SECURITY.zh.md']],
  ['docs/market-shell.i18n.yaml', ['docs/market-shell.md', 'docs/market-shell.zh.md']],
]
for (const [recordPath, paths] of pairs) {
  const lines = read(recordPath).split(/\r?\n/u)
  for (const path of paths) {
    const hash = execFileSync('git', ['hash-object', `--path=${path}`, path], {
      cwd: packageRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    const name = path.split('/').at(-1)
    if (!lines.includes(`${name}: ${hash}`)) fail(`${recordPath} is stale for ${path}`)
  }
}

const markdownFiles = publicFiles.filter(path => path.endsWith('.md'))
for (const path of markdownFiles) {
  const source = read(path)
  for (const match of source.matchAll(/\]\(([^)]+)\)/gu)) {
    const target = match[1].trim().replace(/^<|>$/gu, '')
    if (/^(?:https?:|mailto:|#)/u.test(target)) continue
    const localPath = decodeURIComponent(target.split('#', 1)[0])
    if (!localPath) continue
    if (!existsSync(resolve(packageRoot, dirname(path), localPath))) {
      fail(`${path} links to missing ${localPath}`)
    }
  }
}

process.stdout.write(`verify-market-docs: ${markdownFiles.length} Markdown files and 3 bilingual pairs are consistent\n`)
