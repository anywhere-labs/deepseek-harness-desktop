/** Validate the AA artifact selected by Stable, Beta and Next. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

export const AA_REPOSITORY = 'https://github.com/anywhere-labs/Agents-Anywhere.git'
export const AA_PACKAGE = '@agents-anywhere/dsh-bridge-next'
export const AA_WORKSPACES = ['dsh-plugin-desktop', 'dsh-plugin-desktop-beta', 'dsh-desktop-next']
export const AA_PEERS = ['@deepseek-ai/dsh-typert-protocol', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session']

export function aaConnectorResolution(artifact) {
  return `patch:${AA_PACKAGE}@file%3Avendor/agents-anywhere/${artifact}#./patches/agents-anywhere-connector-httpx.patch`
}

const json = path => JSON.parse(readFileSync(path, 'utf8'))

export function runtimePeerRanges(root) {
  const manifests = AA_WORKSPACES.map(workspace => json(join(root, workspace, 'package.json')))
  return Object.fromEntries(AA_PEERS.map(name => {
    const ranges = manifests.map(manifest => manifest.dependencies?.[name])
    if (ranges.some(range => typeof range !== 'string' || !range)) throw new Error(`Missing AA runtime peer: ${name}`)
    return [name, [...new Set(ranges)].join(' || ')]
  }))
}

/** Throws on stale provenance, a mismatched channel, or an obsolete installation. */
export function assertPreparedAaRelease(root, expectedCommit, { installed = true } = {}) {
  const provenance = json(join(root, 'vendor/agents-anywhere/provenance.json'))
  const fail = message => { throw new Error(`AA release check failed: ${message}. Run corepack yarn aa:prepare-release.`) }
  if (!/^[a-f0-9]{40}$/.test(expectedCommit) || provenance.commit !== expectedCommit) fail('artifact is not from the latest AA main commit')
  if (provenance.repository !== AA_REPOSITORY) fail('unexpected source repository')
  const artifact = provenance.artifact
  if (typeof artifact !== 'string' || basename(artifact) !== artifact || !artifact.endsWith('.tgz')) fail('invalid artifact path')
  if (json(join(root, 'package.json')).resolutions?.[AA_PACKAGE] !== aaConnectorResolution(artifact)) fail('Connector compatibility patch references a different AA artifact')
  if (JSON.stringify(provenance.runtimePeers) !== JSON.stringify(runtimePeerRanges(root))) fail('runtime peers have changed')
  // Stable source versions start their prerelease with "-desktop"; existing
  // source prereleases append ".desktop". Both carry the same commit marker.
  const commitMarker = new RegExp(`(?:-|\\.)desktop\\.c${expectedCommit.slice(0, 12)}\\.`)
  if (typeof provenance.desktopVersion !== 'string' || !commitMarker.test(provenance.desktopVersion)) fail('artifact version does not identify the selected commit')
  const bytes = readFileSync(join(root, 'vendor/agents-anywhere', artifact))
  if (createHash('sha256').update(bytes).digest('hex') !== provenance.sha256) fail('artifact checksum mismatch')
  for (const workspace of AA_WORKSPACES) {
    const manifest = json(join(root, workspace, 'package.json'))
    if (manifest.dependencies?.[AA_PACKAGE] !== `file:../vendor/agents-anywhere/${artifact}`) fail(`${workspace} references a different AA artifact`)
    if (installed) {
      const dependency = json(join(root, workspace, 'node_modules', AA_PACKAGE, 'package.json'))
      if (dependency.version !== provenance.desktopVersion) fail(`${workspace} has an outdated installed AA package`)
      for (const [name, range] of Object.entries(provenance.runtimePeers)) {
        if (dependency.peerDependencies?.[name] !== range) fail(`${workspace} has mismatched installed AA peers`)
      }
    }
  }
  return provenance
}
