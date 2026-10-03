import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { accessSync, chmodSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { AA_PACKAGE, AA_PEERS, AA_REPOSITORY, AA_WORKSPACES, aaConnectorResolution, assertPreparedAaRelease } from './agents-anywhere-release-policy.mjs'
import { patchManifest, versionForCommit } from './prepare-agents-anywhere-release.mjs'
import { prepareInstalledAaRuntime } from './prepare-agents-anywhere-runtime.mjs'

const commit = 'a'.repeat(40)
const version = '0.1.0-dev.0.desktop.caaaaaaaaaaaa.r12345678'
const artifact = `agents-anywhere-dsh-bridge-next-${version}.tgz`

function fixture(t, desktopVersion = version) {
  const artifact = `agents-anywhere-dsh-bridge-next-${desktopVersion}.tgz`
  const root = mkdtempSync(join(tmpdir(), 'dsh-aa-policy-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const write = (path, data) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), JSON.stringify(data))
  }
  const patch = (path, change) => {
    const data = JSON.parse(readFileSync(join(root, path), 'utf8'))
    change(data)
    write(path, data)
  }
  const runtimePeers = Object.fromEntries(AA_PEERS.map(name => [name, '0.1.5-rc.2 || 0.1.6-alpha.2']))
  write('package.json', { resolutions: { [AA_PACKAGE]: aaConnectorResolution(artifact) } })
  for (const [index, workspace] of AA_WORKSPACES.entries()) {
    write(`${workspace}/package.json`, {
      dependencies: {
        [AA_PACKAGE]: `file:../vendor/agents-anywhere/${artifact}`,
        ...Object.fromEntries(AA_PEERS.map(name => [name, index === 0 ? '0.1.5-rc.2' : '0.1.6-alpha.2'])),
      },
    })
    write(`${workspace}/node_modules/${AA_PACKAGE}/package.json`, { version: desktopVersion, peerDependencies: runtimePeers })
  }
  write(`vendor/agents-anywhere/${artifact}`, 'prepared AA bytes')
  write('vendor/agents-anywhere/provenance.json', {
    repository: AA_REPOSITORY, commit, artifact, desktopVersion, runtimePeers,
    sha256: createHash('sha256').update(readFileSync(join(root, 'vendor/agents-anywhere', artifact))).digest('hex'),
  })
  return { root, patch }
}

test('accepts the latest AA across Stable, Beta and Next runtime peers', t => {
  const { root } = fixture(t)
  assert.equal(assertPreparedAaRelease(root, commit).commit, commit)
})

for (const sourceVersion of ['0.1.0-dev.0', '2.0.1', '2.0.1+build.1']) {
  test(`accepts the generated artifact version for AA ${sourceVersion}`, t => {
    const generated = versionForCommit(sourceVersion, commit)
    const { root } = fixture(t, generated)
    assert.equal(assertPreparedAaRelease(root, commit).desktopVersion, generated)
  })
}

test('rejects a version identifying a different commit even when provenance matches', t => {
  const { root } = fixture(t, versionForCommit('2.0.1', 'b'.repeat(40)))
  assert.throws(() => assertPreparedAaRelease(root, commit), /artifact version does not identify the selected commit/)
})

test('rejects a compatibility patch pinned to a previous AA artifact', t => {
  const { root, patch } = fixture(t)
  patch('package.json', data => { data.resolutions[AA_PACKAGE] = aaConnectorResolution('old.tgz') })
  assert.throws(() => assertPreparedAaRelease(root, commit), /compatibility patch references a different AA artifact/)
})

test('pins the AA staging type graph while keeping both Desktop runtime peer ranges', t => {
  const { root } = fixture(t)
  const packagePath = join(root, 'staged')
  mkdirSync(packagePath)
  writeFileSync(join(packagePath, 'package.json'), JSON.stringify({
    version: '0.1.0-dev.0', scripts: { prepack: 'build', build: 'tsdown' },
    peerDependencies: { react: '^18' },
    devDependencies: {
      '@deepseek-ai/dsh-session': '0.1.5-rc.2',
      '@deepseek-ai/dsh-typert-protocol': '0.1.5-rc.2',
      '@deepseek-ai/schemastery': '3.18.2',
    },
    resolutions: { react: '18.3.1' },
  }))
  const peers = { '@deepseek-ai/dsh-session': '0.1.5-rc.2 || 0.1.7-alpha.2' }
  assert.deepEqual(patchManifest(packagePath, peers, version), { sourceVersion: '0.1.0-dev.0' })
  const staged = JSON.parse(readFileSync(join(packagePath, 'package.json'), 'utf8'))
  assert.equal(staged.version, version)
  assert.equal(staged.scripts.prepack, undefined)
  assert.equal(staged.peerDependencies['@deepseek-ai/dsh-session'], peers['@deepseek-ai/dsh-session'])
  assert.equal(staged.resolutions['@deepseek-ai/dsh-session'], '0.1.5-rc.2')
  assert.equal(staged.resolutions['@deepseek-ai/dsh-session-format'], '0.1.5-rc.2')
  assert.equal(staged.resolutions['@deepseek-ai/dsh-typert-protocol'], '0.1.5-rc.2')
  assert.equal(staged.resolutions['@deepseek-ai/schemastery'], '3.18.2')
  assert.equal(staged.resolutions['@deepseek-ai/cosmokit'], '1.8.3')
  assert.equal(staged.resolutions.react, '18.3.1')
})

test('rejects the former stable-old/beta-new split even if the tarball is valid', t => {
  const { root, patch } = fixture(t)
  patch('dsh-plugin-desktop/package.json', data => { data.dependencies[AA_PACKAGE] = 'file:../vendor/agents-anywhere/old.tgz' })
  assert.throws(() => assertPreparedAaRelease(root, commit), /dsh-plugin-desktop references a different AA artifact/)
})

test('rejects a Next install left on the old AA artifact', t => {
  const { root, patch } = fixture(t)
  patch('dsh-desktop-next/package.json', data => { data.dependencies[AA_PACKAGE] = 'file:../vendor/agents-anywhere/old.tgz' })
  assert.throws(() => assertPreparedAaRelease(root, commit), /dsh-desktop-next references a different AA artifact/)
})

test('rejects a prepared artifact after AA main advances', t => {
  const { root } = fixture(t)
  assert.throws(() => assertPreparedAaRelease(root, 'b'.repeat(40)), /not from the latest AA main commit/)
})

test('rejects stale installed code despite updated manifests and provenance', t => {
  const { root, patch } = fixture(t)
  patch(`dsh-plugin-desktop/node_modules/${AA_PACKAGE}/package.json`, data => { data.version = '0.1.0-old' })
  assert.throws(() => assertPreparedAaRelease(root, commit), /outdated installed AA package/)
})

test('requires rebuilding the AA peer patch after a Desktop runtime update', t => {
  const { root, patch } = fixture(t)
  patch('dsh-plugin-desktop-beta/package.json', data => { data.dependencies[AA_PEERS[0]] = '0.1.6-alpha.3' })
  assert.throws(() => assertPreparedAaRelease(root, commit), /runtime peers have changed/)
})

test('rejects corrupted or replaced vendor bytes', t => {
  const { root } = fixture(t)
  writeFileSync(join(root, 'vendor/agents-anywhere', artifact), 'replaced bytes')
  assert.throws(() => assertPreparedAaRelease(root, commit), /checksum mismatch/)
})

test('repairs the 0644 uv payload for both Mac architectures in all channels', { skip: process.platform === 'win32' }, t => {
  const { root } = fixture(t)
  const files = AA_WORKSPACES.flatMap(workspace => ['arm64', 'x64'].map(arch =>
    join(root, workspace, 'node_modules', '@dataiku', `uv-darwin-${arch}`, 'bin', 'uv')))
  for (const path of files) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, 'uv fixture')
    chmodSync(path, 0o644)
  }
  prepareInstalledAaRuntime(root, 'darwin')
  for (const path of files) {
    assert.equal(statSync(path).mode & 0o777, 0o755)
    assert.doesNotThrow(() => accessSync(path, constants.X_OK))
    assert.equal(readFileSync(path, 'utf8'), 'uv fixture')
  }
})
