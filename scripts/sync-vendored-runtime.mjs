import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const upstreamPath = join(root, 'upstream.json')
const workspacePath = join(root, 'package.json')
const mode = process.argv[2]
const channelFlag = process.argv.indexOf('--channel')
const requestedChannel = channelFlag === -1 ? undefined : process.argv[channelFlag + 1]

if (mode !== '--write' && mode !== '--check') {
  throw new Error('usage: node scripts/sync-vendored-runtime.mjs <--write|--check> [--channel stable|beta]')
}

const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const isDshPackage = name => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')
const isDshResolution = selector => selector === '@deepseek-ai/dsh'
  || selector.startsWith('@deepseek-ai/dsh@')
  || selector.startsWith('@deepseek-ai/dsh-')
const fail = message => { throw new Error(`sync-vendored-runtime: ${message}`) }

const upstreamDocument = readJson(upstreamPath)
const channel = requestedChannel ?? upstreamDocument.activeChannel
if (channel !== 'stable' && channel !== 'beta') fail(`unknown release channel ${JSON.stringify(channel)}`)
const upstream = upstreamDocument.channels?.[channel]
if (upstream === undefined || typeof upstream !== 'object') fail(`missing upstream metadata for ${channel}`)
const otherChannel = channel === 'stable' ? 'beta' : 'stable'
const otherVersion = upstreamDocument.channels?.[otherChannel]?.sourceVersion
if (typeof otherVersion !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z.-]*$/u.test(otherVersion)) {
  fail(`unsafe ${otherChannel} source version ${JSON.stringify(otherVersion)}`)
}
const marketPath = join(root, 'dsh-community-market', 'package.json')
const pluginPaths = [
  join(root, upstream.package, 'package.json'),
  ...(channel === 'beta' ? [marketPath] : []),
]
// Stable and Beta both load the market bundle, and dsh 0.2 refuses a bundle
// whose dsh peers exclude the running runtime, so its peers accept every
// channel's version while its build dependencies follow Beta.
const marketPeerRange = [...new Set(['stable', 'beta'].map(name => upstreamDocument.channels?.[name]?.sourceVersion))].join(' || ')
const expectedRange = (path, field) => path === marketPath && field === 'peerDependencies' ? marketPeerRange : version
const version = upstream.sourceVersion
if (typeof version !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z.-]*$/u.test(version)) {
  fail(`unsafe source version ${JSON.stringify(version)}`)
}

const vendorRelative = `vendor/dsh-runtime/${version}`
const vendorDirectory = join(root, ...vendorRelative.split('/'))
const manifestPath = join(vendorDirectory, 'manifest.json')
const resolutionSelector = (name, range = version) => `${name}@npm:${range}`
const isChannelResolution = selector => selector.endsWith(`@npm:${version}`)
  || selector.endsWith(`@npm:^${version}`)
const isOtherChannelResolution = selector => selector.endsWith(`@npm:${otherVersion}`)
  || selector.endsWith(`@npm:^${otherVersion}`)

function packageName(filename) {
  const suffix = `-${version}.tgz`
  if (!filename.startsWith('deepseek-ai-') || !filename.endsWith(suffix)) {
    fail(`unexpected upstream tarball name ${JSON.stringify(filename)}`)
  }
  const unscoped = filename.slice('deepseek-ai-'.length, -suffix.length)
  if (unscoped.length === 0) fail(`empty package name in ${JSON.stringify(filename)}`)
  return `@deepseek-ai/${unscoped}`
}

function expectedResolution(entry) {
  const source = `file:${vendorRelative}/${entry.filename}`
  const unscoped = entry.name.slice('@deepseek-ai/'.length)
  const patchRelative = `patches/${unscoped}@${version}.patch`
  return existsSync(join(root, patchRelative))
    ? `patch:${entry.name}@${source.replace(':', '%3A')}#./${patchRelative}`
    : source
}

function writeVendor() {
  const packedDirectory = join(root, 'deepseek-harness', 'dist', 'npm')
  const orderPath = join(packedDirectory, 'publish-order.txt')
  if (!existsSync(orderPath)) {
    fail('upstream release tarballs are missing; run yarn upstream:prepare-runtime first')
  }
  const filenames = readFileSync(orderPath, 'utf8').trim().split(/\r?\n/u).filter(Boolean)
  if (filenames.length === 0 || new Set(filenames).size !== filenames.length) {
    fail('upstream publish order is empty or contains duplicate tarballs')
  }

  mkdirSync(vendorDirectory, { recursive: true })
  const packages = filenames.map((filename) => {
    if (basename(filename) !== filename) fail(`tarball path escapes its directory: ${JSON.stringify(filename)}`)
    const source = join(packedDirectory, filename)
    if (!existsSync(source) || !statSync(source).isFile()) fail(`missing packed tarball ${filename}`)
    const target = join(vendorDirectory, filename)
    copyFileSync(source, target)
    return {
      name: packageName(filename),
      version,
      filename,
      size: statSync(source).size,
      sha256: sha256(source),
    }
  })
  const names = packages.map(entry => entry.name)
  if (new Set(names).size !== names.length) fail('two tarballs map to the same package name')

  const expectedFiles = new Set([...filenames, 'manifest.json'])
  for (const entry of readdirSync(vendorDirectory, { withFileTypes: true })) {
    if (expectedFiles.has(entry.name)) continue
    if (!entry.isFile()) fail(`unexpected directory in vendored runtime: ${entry.name}`)
    unlinkSync(join(vendorDirectory, entry.name))
  }

  const manifest = {
    formatVersion: 1,
    repository: upstreamDocument.repository,
    commit: upstream.commit,
    version,
    buildProfile: 'official',
    packages,
  }
  writeJson(manifestPath, manifest)

  upstream.runtimePackageVersion = version
  upstream.runtimeSource = `${vendorRelative}/manifest.json`
  writeJson(upstreamPath, upstreamDocument)

  const workspace = readJson(workspacePath)
  const resolutions = Object.fromEntries(Object.entries(workspace.resolutions ?? {})
    .filter(([selector]) => !isDshResolution(selector) || isOtherChannelResolution(selector)))
  for (const entry of packages) {
    resolutions[resolutionSelector(entry.name)] = expectedResolution(entry)
    resolutions[resolutionSelector(entry.name, `^${version}`)] = expectedResolution(entry)
  }
  workspace.resolutions = resolutions
  writeJson(workspacePath, workspace)

  const packageNames = new Set(packages.map(entry => entry.name))
  for (const path of pluginPaths) {
    const plugin = readJson(path)
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const name of Object.keys(plugin[field] ?? {})) {
        if (isDshPackage(name) && packageNames.has(name)) plugin[field][name] = expectedRange(path, field)
      }
    }
    writeJson(path, plugin)
  }
}

function checkVendor() {
  if (!existsSync(manifestPath)) fail(`missing ${relative(root, manifestPath)}`)
  const manifest = readJson(manifestPath)
  if (manifest.formatVersion !== 1) fail('unsupported vendored runtime manifest format')
  for (const field of ['repository', 'commit']) {
    const expected = field === 'repository' ? upstreamDocument.repository : upstream[field]
    if (manifest[field] !== expected) fail(`manifest ${field} differs from upstream.json ${channel} channel`)
  }
  if (manifest.version !== version || upstream.runtimePackageVersion !== version) {
    fail('source, runtime, and manifest versions must match')
  }
  if (manifest.buildProfile !== 'official') fail('vendored runtime must use the official client build profile')
  if (upstream.runtimeSource !== `${vendorRelative}/manifest.json`) {
    fail('upstream.json points at the wrong runtime manifest')
  }
  if (!Array.isArray(manifest.packages) || manifest.packages.length === 0) fail('runtime manifest has no packages')

  const workspace = readJson(workspacePath)
  const resolutions = workspace.resolutions ?? {}
  const expectedFiles = new Set(['manifest.json'])
  const names = new Set()
  for (const entry of manifest.packages) {
    if (entry.version !== version || packageName(entry.filename) !== entry.name || names.has(entry.name)) {
      fail(`invalid manifest package ${JSON.stringify(entry.name)}`)
    }
    names.add(entry.name)
    expectedFiles.add(entry.filename)
    const path = join(vendorDirectory, entry.filename)
    if (!existsSync(path) || !statSync(path).isFile()) fail(`missing vendored tarball ${entry.filename}`)
    if (statSync(path).size !== entry.size || sha256(path) !== entry.sha256) {
      fail(`vendored tarball integrity differs for ${entry.filename}`)
    }
    if (resolutions[resolutionSelector(entry.name)] !== expectedResolution(entry)
      || resolutions[resolutionSelector(entry.name, `^${version}`)] !== expectedResolution(entry)) {
      fail(`workspace resolution differs for ${entry.name}`)
    }
  }
  for (const selector of Object.keys(resolutions).filter(isChannelResolution)) {
    const name = selector.slice(0, selector.indexOf('@npm:'))
    if (!names.has(name)) fail(`workspace has a stale ${channel} DSH resolution for ${selector}`)
  }
  for (const entry of readdirSync(vendorDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !expectedFiles.has(entry.name)) fail(`unexpected vendored runtime entry ${entry.name}`)
  }

  for (const path of pluginPaths) {
    const plugin = readJson(path)
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [name, range] of Object.entries(plugin[field] ?? {})) {
        if (!isDshPackage(name)) continue
        if (!names.has(name)) fail(`${relative(root, path)} references absent runtime package ${name}`)
        const expected = expectedRange(path, field)
        if (range !== expected) fail(`${relative(root, path)} ${field}.${name} must use ${expected}`)
      }
    }
  }
  process.stdout.write(
    `sync-vendored-runtime: ${channel} ${String(manifest.packages.length)} packages from ${manifest.commit.slice(0, 10)} are verified\n`,
  )
}

if (mode === '--write') writeVendor()
checkVendor()
