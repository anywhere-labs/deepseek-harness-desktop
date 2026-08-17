import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const fail = message => { throw new Error(`verify-fabric-docs: ${message}`) }
const read = path => readFileSync(resolve(packageRoot, path), 'utf8')
const manifest = JSON.parse(read('package.json'))

if (manifest.name !== 'dsh-community-fabric') fail('package name must remain dsh-community-fabric')
if (manifest.private !== true) fail('the Draft scaffold must stay private until a reviewed runtime exists')
for (const field of ['main', 'module', 'types', 'exports', 'bin', 'dsh', 'dependencies', 'optionalDependencies']) {
  if (manifest[field] !== undefined) fail(`documentation scaffold must not declare ${field}`)
}

const publicFiles = [
  'LICENSE',
  'README.i18n.yaml',
  'README.md',
  'README.zh.md',
  'docs/architecture/compatibility-layer.i18n.yaml',
  'docs/architecture/compatibility-layer.md',
  'docs/architecture/compatibility-layer.zh.md',
  'docs/research/dsh-plugin-needs.i18n.yaml',
  'docs/research/dsh-plugin-needs.md',
  'docs/research/dsh-plugin-needs.zh.md',
  'docs/research/community-issue-23-review.i18n.yaml',
  'docs/research/community-issue-23-review.md',
  'docs/research/community-issue-23-review.zh.md',
  'docs/research/mature-plugin-frameworks.i18n.yaml',
  'docs/research/mature-plugin-frameworks.md',
  'docs/research/mature-plugin-frameworks.zh.md',
  'docs/research/vscode-extension-model.i18n.yaml',
  'docs/research/vscode-extension-model.md',
  'docs/research/vscode-extension-model.zh.md',
  'docs/rfcs/0001-plugin-manifest-capabilities-events.i18n.yaml',
  'docs/rfcs/0001-plugin-manifest-capabilities-events.md',
  'docs/rfcs/0001-plugin-manifest-capabilities-events.zh.md',
  'docs/rfcs/0002-runtime-presentation-invocation-transport.i18n.yaml',
  'docs/rfcs/0002-runtime-presentation-invocation-transport.md',
  'docs/rfcs/0002-runtime-presentation-invocation-transport.zh.md',
  'docs/rfcs/0003-service-providers-and-composition.i18n.yaml',
  'docs/rfcs/0003-service-providers-and-composition.md',
  'docs/rfcs/0003-service-providers-and-composition.zh.md',
  'docs/rfcs/0004-provenance-validation-and-diagnostics.i18n.yaml',
  'docs/rfcs/0004-provenance-validation-and-diagnostics.md',
  'docs/rfcs/0004-provenance-validation-and-diagnostics.zh.md',
]
for (const path of [...publicFiles, 'scripts/verify-docs.mjs']) {
  if (!existsSync(resolve(packageRoot, path))) fail(`${path} is missing`)
}

const discoverDocs = (directory, prefix) => {
  const paths = []
  for (const entry of readdirSync(resolve(packageRoot, directory), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) paths.push(...discoverDocs(path, path))
    else if (path.endsWith('.md') || path.endsWith('.i18n.yaml')) paths.push(path)
  }
  return paths
}
const discoveredDocs = [
  ...readdirSync(packageRoot, { withFileTypes: true })
    .filter(entry => entry.isFile() && (entry.name.endsWith('.md') || entry.name.endsWith('.i18n.yaml')))
    .map(entry => entry.name),
  ...discoverDocs('docs', 'docs'),
].sort()
const declaredDocs = publicFiles.filter(path => path.endsWith('.md') || path.endsWith('.i18n.yaml')).sort()
if (JSON.stringify(discoveredDocs) !== JSON.stringify(declaredDocs)) {
  fail(`documentation inventory differs: declared=${declaredDocs.join(',')} discovered=${discoveredDocs.join(',')}`)
}

const expectedFiles = ['docs/**', 'LICENSE', 'README.md', 'README.zh.md', 'README.i18n.yaml']
if (JSON.stringify(manifest.files) !== JSON.stringify(expectedFiles)) {
  fail('package files must contain only the reviewed documentation surface')
}

const pairs = [
  ['README.i18n.yaml', ['README.md', 'README.zh.md']],
  [
    'docs/architecture/compatibility-layer.i18n.yaml',
    ['docs/architecture/compatibility-layer.md', 'docs/architecture/compatibility-layer.zh.md'],
  ],
  [
    'docs/research/dsh-plugin-needs.i18n.yaml',
    ['docs/research/dsh-plugin-needs.md', 'docs/research/dsh-plugin-needs.zh.md'],
  ],
  [
    'docs/research/community-issue-23-review.i18n.yaml',
    ['docs/research/community-issue-23-review.md', 'docs/research/community-issue-23-review.zh.md'],
  ],
  [
    'docs/research/mature-plugin-frameworks.i18n.yaml',
    ['docs/research/mature-plugin-frameworks.md', 'docs/research/mature-plugin-frameworks.zh.md'],
  ],
  [
    'docs/research/vscode-extension-model.i18n.yaml',
    ['docs/research/vscode-extension-model.md', 'docs/research/vscode-extension-model.zh.md'],
  ],
  [
    'docs/rfcs/0001-plugin-manifest-capabilities-events.i18n.yaml',
    [
      'docs/rfcs/0001-plugin-manifest-capabilities-events.md',
      'docs/rfcs/0001-plugin-manifest-capabilities-events.zh.md',
    ],
  ],
  [
    'docs/rfcs/0002-runtime-presentation-invocation-transport.i18n.yaml',
    [
      'docs/rfcs/0002-runtime-presentation-invocation-transport.md',
      'docs/rfcs/0002-runtime-presentation-invocation-transport.zh.md',
    ],
  ],
  [
    'docs/rfcs/0003-service-providers-and-composition.i18n.yaml',
    [
      'docs/rfcs/0003-service-providers-and-composition.md',
      'docs/rfcs/0003-service-providers-and-composition.zh.md',
    ],
  ],
  [
    'docs/rfcs/0004-provenance-validation-and-diagnostics.i18n.yaml',
    [
      'docs/rfcs/0004-provenance-validation-and-diagnostics.md',
      'docs/rfcs/0004-provenance-validation-and-diagnostics.zh.md',
    ],
  ],
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

process.stdout.write(`verify-fabric-docs: ${markdownFiles.length} Markdown files and ${pairs.length} bilingual pairs are consistent\n`)
