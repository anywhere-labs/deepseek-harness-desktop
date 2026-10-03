import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { exportPlanCommentsPatches, runtimePatch, sourcePatch } from './export-plan-comments-patches.mjs'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-plan-comments-export-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const write = (path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text) }
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  return { root, write, git }
}

test('runtime patch applies exact browser/declaration changes and excludes Host/shell files', t => {
  const { root, write } = fixture(t)
  write('baseline/lib/client.js', 'old browser\n')
  write('baseline/lib/types/client/index.d.ts', 'old types\n')
  write('baseline/lib/types/client/removed.d.ts', 'removed\n')
  write('baseline/lib/index.js', 'official Host\n')
  write('baseline/README.md', 'official docs\n')
  write('built/lib/client.js', 'new browser 中文\n')
  write('built/lib/types/client/index.d.ts', 'new types\n')
  write('built/lib/types/client/plan-comments.d.ts', 'new comment type\n')
  write('built/lib/index.js', 'changed Host must not ship\n')
  write('built/lib/client.js.map', 'development map\n')
  const patch = runtimePatch(join(root, 'baseline'), join(root, 'built'))
  assert.match(patch, /new file mode/)
  assert.match(patch, /deleted file mode/)
  assert.doesNotMatch(patch, /(?:before|after)\/|lib\/index\.js|README|\.map/)
  write('runtime.patch', patch)
  execFileSync('git', ['apply', '--check', join(root, 'runtime.patch')], { cwd: join(root, 'baseline') })
  execFileSync('git', ['apply', join(root, 'runtime.patch')], { cwd: join(root, 'baseline') })
  assert.equal(readFileSync(join(root, 'baseline/lib/client.js'), 'utf8'), 'new browser 中文\n')
  assert.equal(readFileSync(join(root, 'baseline/lib/types/client/plan-comments.d.ts'), 'utf8'), 'new comment type\n')
  assert.equal(readFileSync(join(root, 'baseline/lib/index.js'), 'utf8'), 'official Host\n')
})

test('source patch captures tracked/new source and plan tests without staging unrelated work', t => {
  const { root, write, git } = fixture(t)
  git('init', '-q')
  write('packages/client/ui-plan/src/client/PlanPreview.tsx', 'original\n')
  write('outside.ts', 'unrelated\n')
  git('add', '.')
  git('-c', 'user.name=Patch Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'official baseline')
  const base = git('rev-parse', 'HEAD')
  write('packages/client/ui-plan/src/client/PlanPreview.tsx', 'selection comments\n')
  write('packages/client/ui-plan/src/client/plan-comments.ts', 'new store\n')
  write('apps/web/tests/plan-comments.e2e.ts', 'new interaction test\n')
  write('outside.ts', 'unrelated edit\n')
  const staged = git('diff', '--cached')
  const patch = sourcePatch(root, base)
  assert.match(patch, /PlanPreview\.tsx/)
  assert.match(patch, /plan-comments\.ts/)
  assert.match(patch, /plan-comments\.e2e\.ts/)
  assert.doesNotMatch(patch, /outside\.ts/)
  assert.equal(git('diff', '--cached'), staged)
  git('checkout', '--', 'packages/client/ui-plan/src/client/PlanPreview.tsx')
  rmSync(join(root, 'packages/client/ui-plan/src/client/plan-comments.ts'))
  rmSync(join(root, 'apps/web/tests/plan-comments.e2e.ts'))
  write('source.patch', patch)
  git('apply', '--check', join(root, 'source.patch'))
  git('apply', join(root, 'source.patch'))
  assert.equal(readFileSync(join(root, 'packages/client/ui-plan/src/client/plan-comments.ts'), 'utf8'), 'new store\n')
  assert.equal(readFileSync(join(root, 'outside.ts'), 'utf8'), 'unrelated edit\n')
})

test('export refuses missing compiled output and empty source changes', t => {
  const { root, write, git } = fixture(t)
  assert.throws(() => runtimePatch(root, root), /missing built client artifact/)
  write('lib/client.js', 'browser\n')
  assert.throws(() => runtimePatch(root, root), /missing built declarations/)
  git('init', '-q')
  git('-c', 'user.name=Patch Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'official baseline')
  assert.throws(() => sourcePatch(root, git('rev-parse', 'HEAD')), /no plan comment source changes/)
})

test('full export verifies official baselines and supports isolated source without changing provenance', t => {
  const { root, write } = fixture(t)
  const upstream = join(root, 'deepseek-harness')
  mkdirSync(upstream)
  const git = (...args) => execFileSync('git', args, { cwd: upstream, encoding: 'utf8' }).trim()
  git('init', '-q')
  write('deepseek-harness/.gitignore', '**/lib/\n')
  write('deepseek-harness/packages/client/ui-plan/src/client/PlanPreview.tsx', 'official preview\n')
  git('add', '.')
  git('-c', 'user.name=Patch Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'official baseline')
  const commit = git('rev-parse', 'HEAD')
  const version = '1.0.0'
  const channel = { commit, sourceVersion: version }
  write('upstream.json', JSON.stringify({ activeChannel: 'beta', channels: { stable: channel, beta: channel } }))
  write('package.json', '{"resolutions":{}}\n')
  write('yarn.lock', 'original lock\n')
  write('deepseek-harness/packages/client/ui-plan/src/client/PlanPreview.tsx', 'selection comments\n')
  const packages = ['ui-plan', 'ui-user-questions'].map(name => {
    const packing = `packing/${name}/package`
    write(`${packing}/lib/client.js`, 'official browser\n')
    write(`${packing}/lib/types/client/index.d.ts`, 'official declaration\n')
    write(`deepseek-harness/packages/client/${name}/lib/client.js`, 'conversation.plan-review.surface data-plan-review-variant\n')
    write(`deepseek-harness/packages/client/${name}/lib/types/client/index.d.ts`, 'comment declaration\n')
    const filename = `deepseek-ai-dsh-client-${name}-${version}.tgz`
    mkdirSync(join(root, `vendor/dsh-runtime/${version}`), { recursive: true })
    const artifact = join(root, `vendor/dsh-runtime/${version}/${filename}`)
    execFileSync('tar', ['-czf', artifact, '-C', join(root, `packing/${name}`), 'package'])
    const bytes = readFileSync(artifact)
    return { name: `@deepseek-ai/dsh-client-${name}`, version, filename, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  })
  const manifest = `vendor/dsh-runtime/${version}/manifest.json`
  write(manifest, JSON.stringify({ commit, version, buildProfile: 'official', packages }))
  const preservedPaths = ['upstream.json', 'package.json', 'yarn.lock', manifest, ...packages.map(entry => `vendor/dsh-runtime/${version}/${entry.filename}`)]
  const originals = preservedPaths.map(path => readFileSync(join(root, path)))
  assert.deepEqual(exportPlanCommentsPatches(root), ['patches/dsh-plan-comments.source.patch', `patches/dsh-client-ui-plan@${version}.patch`, `patches/dsh-client-ui-user-questions@${version}.patch`])
  assert.deepEqual(preservedPaths.map(path => readFileSync(join(root, path))), originals)
  const exported = readFileSync(join(root, `patches/dsh-client-ui-plan@${version}.patch`))
  const source = readFileSync(join(root, 'patches/dsh-plan-comments.source.patch'))
  const isolated = join(root, 'isolated-source')
  execFileSync('git', ['clone', '--shared', '--no-hardlinks', upstream, isolated], { stdio: 'ignore' })
  execFileSync('git', ['apply', join(root, 'patches/dsh-plan-comments.source.patch')], { cwd: isolated })
  for (const name of ['ui-plan', 'ui-user-questions']) {
    cpSync(join(upstream, 'packages/client', name, 'lib'), join(isolated, 'packages/client', name, 'lib'), { recursive: true })
  }
  git('checkout', '--', 'packages/client/ui-plan/src/client/PlanPreview.tsx')
  assert.equal(git('status', '--porcelain'), '')
  exportPlanCommentsPatches(root, { sourceRoot: isolated })
  assert.deepEqual(readFileSync(join(root, `patches/dsh-client-ui-plan@${version}.patch`)), exported)
  assert.deepEqual(readFileSync(join(root, 'patches/dsh-plan-comments.source.patch')), source)
  assert.equal(git('status', '--porcelain'), '')
  assert.deepEqual(preservedPaths.map(path => readFileSync(join(root, path))), originals)
  write(`vendor/dsh-runtime/${version}/${packages[0].filename}`, 'corrupted\n')
  assert.throws(() => exportPlanCommentsPatches(root, { sourceRoot: isolated }), /official baseline checksum differs/)
  assert.deepEqual(readFileSync(join(root, `patches/dsh-client-ui-plan@${version}.patch`)), exported)
})
