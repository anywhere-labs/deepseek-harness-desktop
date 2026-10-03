import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const PACKAGES = ['ui-plan', 'ui-user-questions']
const SOURCE_PATHS = ['packages/client/ui-plan', 'packages/client/ui-user-questions', 'apps/web/tests/plan-*.e2e.ts']
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const fail = message => { throw new Error(`export-plan-comments-patches: ${message}`) }

function run(command, args, cwd, accepted = [0]) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  if (result.error) throw result.error
  if (!accepted.includes(result.status)) fail(`${command} ${args.join(' ')} failed: ${result.stderr.trim()}`)
  return result.stdout
}

function files(directory, base = directory) {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return files(path, base)
    if (!entry.isFile()) fail(`unexpected non-file artifact ${path}`)
    return [relative(base, path).split(sep).join('/')]
  }).sort()
}

/** Compare the exact browser artifact and public declarations, excluding the Host and shell. */
export function runtimePatch(baseline, built) {
  if (!existsSync(join(built, 'lib/client.js'))) fail(`missing built client artifact in ${built}`)
  const declarations = files(join(built, 'lib/types')).filter(path => path.endsWith('.d.ts'))
  if (declarations.length === 0) fail(`missing built declarations in ${built}`)
  const temporary = mkdtempSync(join(tmpdir(), 'dsh-plan-comments-diff-'))
  try {
    for (const [name, source] of [['before', baseline], ['after', built]]) {
      const paths = ['lib/client.js', ...files(join(source, 'lib/types')).filter(path => path.endsWith('.d.ts')).map(path => `lib/types/${path}`)]
      for (const path of paths) {
        const target = join(temporary, name, path)
        mkdirSync(dirname(target), { recursive: true })
        copyFileSync(join(source, path), target)
      }
    }
    return run('git', ['diff', '--no-index', '--binary', '--no-renames', '--', 'before', 'after'], temporary, [0, 1])
      .replace(/^(diff --git a\/)before\//gm, '$1')
      .replace(/^(diff --git a\/)after\//gm, '$1')
      .replace(/^(diff --git .+) b\/(?:before|after)\//gm, '$1 b/')
      .replace(/^(--- a\/|\+\+\+ b\/)(?:before|after)\//gm, '$1')
  } finally { rmSync(temporary, { recursive: true, force: true }) }
}

/** Include new source/test files without staging anything in the upstream checkout. */
export function sourcePatch(upstream, baseCommit) {
  let patch = run('git', ['diff', '--binary', '--no-renames', baseCommit, '--', ...SOURCE_PATHS], upstream)
  const added = run('git', ['ls-files', '--others', '--exclude-standard', '-z', '--', ...SOURCE_PATHS], upstream).split('\0').filter(Boolean)
  for (const path of added.sort()) patch += run('git', ['diff', '--no-index', '--binary', '--', '/dev/null', path], upstream, [0, 1])
  if (patch.length === 0) fail('no plan comment source changes to export')
  return patch
}

/** Export Desktop-owned patches while preserving the recorded official runtime provenance. */
export function exportPlanCommentsPatches(root, { sourceOnly = false, sourceRoot } = {}) {
  const metadata = readJson(join(root, 'upstream.json'))
  const channel = metadata.channels?.[metadata.activeChannel]
  if (!channel || !/^[a-f0-9]{40}$/.test(channel.commit)) fail('missing recorded official upstream commit')
  const version = channel.sourceVersion
  if (!/^[0-9A-Za-z][0-9A-Za-z.-]*$/.test(version)) fail('unsafe runtime version')
  if (metadata.channels.stable?.sourceVersion !== version || metadata.channels.beta?.sourceVersion !== version) fail('both Desktop channels must use the same runtime family')
  const upstream = resolve(sourceRoot ?? join(root, 'deepseek-harness'))
  const outputs = new Map([['dsh-plan-comments.source.patch', sourcePatch(upstream, channel.commit)]])
  if (!sourceOnly) {
    const vendor = join(root, 'vendor/dsh-runtime', version)
    const manifest = readJson(join(vendor, 'manifest.json'))
    if (manifest.commit !== channel.commit || manifest.version !== version || manifest.buildProfile !== 'official') fail('runtime baseline does not match the recorded official source')
    for (const name of PACKAGES) {
      const fullName = `@deepseek-ai/dsh-client-${name}`
      const entry = manifest.packages.find(candidate => candidate.name === fullName)
      if (!entry || entry.version !== version || entry.filename !== `deepseek-ai-dsh-client-${name}-${version}.tgz`) fail(`missing official baseline for ${fullName}`)
      const artifact = join(vendor, entry.filename)
      const bytes = readFileSync(artifact)
      if (bytes.length !== entry.size || sha256(bytes) !== entry.sha256) fail(`official baseline checksum differs for ${fullName}`)
      const built = join(upstream, 'packages/client', name)
      const browser = readFileSync(join(built, 'lib/client.js'), 'utf8')
      if (!browser.includes('conversation.plan-review.surface') || (name === 'ui-plan' && !browser.includes('data-plan-review-variant'))) fail(`built ${fullName} does not contain the completed plan comment surface`)
      const baseline = mkdtempSync(join(tmpdir(), 'dsh-plan-comments-baseline-'))
      try {
        const entries = run('tar', ['-tzf', artifact], root).trim().split('\n')
        if (entries.some(path => !path.startsWith('package/') || path.split('/').includes('..'))) fail(`unsafe baseline archive for ${fullName}`)
        run('tar', ['-xzf', artifact, '--strip-components=1', '-C', baseline], root)
        const patch = runtimePatch(baseline, built)
        if (patch.length === 0) fail(`built ${fullName} is unchanged`)
        outputs.set(`dsh-client-${name}@${version}.patch`, patch)
      } finally { rmSync(baseline, { recursive: true, force: true }) }
    }
  }
  const destination = join(root, 'patches')
  mkdirSync(destination, { recursive: true })
  for (const [filename, patch] of outputs) {
    const path = join(destination, filename)
    writeFileSync(`${path}.tmp`, patch)
    renameSync(`${path}.tmp`, path)
  }
  return [...outputs.keys()].map(filename => `patches/${filename}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { 'source-only': { type: 'boolean' }, 'source-root': { type: 'string' } }, allowPositionals: false })
  const paths = exportPlanCommentsPatches(resolve(import.meta.dirname, '..'), { sourceOnly: values['source-only'] === true, sourceRoot: values['source-root'] })
  for (const path of paths) process.stdout.write(`exported ${path}\n`)
}
