/** Materialize the packaged desktop Host dependency closure from npm. */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, lstat, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

const desktopRoot = resolve(import.meta.dirname, '..')
const staging = join(desktopRoot, 'runtime-host')
const runtimeManifest = join(desktopRoot, 'runtime', 'package.json')
const entry = join(staging, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
const frontend = join(staging, 'node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html')

/**
 * The official runtime and web frontend are pinned npm packages, not
 * workspace sources. Staging is a standalone hoisted production install
 * of the runtime manifest — upstream upgrades are a version bump here,
 * never a source merge.
 */
const INSTALL_ARGS = [
  'install',
  '--prod',
  '--config.node-linker=hoisted',
  '--config.verify-deps-before-run=false',
  // The official npm packages declare parts of their Cordis plugin tree as
  // peer dependencies; auto-installation is what makes the published closure
  // bootable without vendoring a workspace peer graph.
  '--config.auto-install-peers=true',
]

/**
 * Minimal workspace settings for the standalone staging install. The local
 * pnpm-workspace.yaml makes staging its own workspace root (parents are
 * ignored automatically) and whitelists the native/helper install scripts
 * the packaged Host needs at runtime.
 */
const STAGING_WORKSPACE = `packages: []
allowBuilds:
  node-pty: true
  koffi: true
  '@deepseek-ai/dsh-subprocess-local': true
  '@google/genai': false
  protobufjs: false
`

async function run(command: string, args: readonly string[], cwd: string): Promise<void> {
  await new Promise<void>((accept, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, CI: 'true' }, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) accept()
      else reject(new Error(`desktop runtime staging failed (${code === null ? `signal ${String(signal)}` : `exit ${String(code)}`}): ${command} ${args.join(' ')}`))
    })
  })
}

async function findSymlink(directory: string): Promise<string | undefined> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) return path
    if (metadata.isDirectory()) {
      const nested = await findSymlink(path)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

/**
 * Defensively dereference any remaining symlinks (pnpm may still emit a
 * few for bins even with the hoisted linker). Electron Builder copies
 * node_modules verbatim into resources; dangling links would break the
 * packaged Host.
 */
async function materializeLinks(): Promise<void> {
  const nodeModules = join(staging, 'node_modules')
  if (!existsSync(nodeModules)) return
  for (let link = await findSymlink(nodeModules); link !== undefined; link = await findSymlink(nodeModules)) {
    const segments = link.slice(nodeModules.length + 1).split(sep)
    const bin = segments.lastIndexOf('.bin')
    if (bin >= 0) {
      await rm(join(nodeModules, ...segments.slice(0, bin + 1)), { recursive: true, force: true })
      continue
    }
    const source = await realpath(link)
    await rm(link, { recursive: true, force: true })
    await cp(source, link, {
      recursive: true,
      dereference: true,
      filter: path => path !== join(source, 'node_modules') && !path.startsWith(join(source, 'node_modules') + sep),
    })
  }
}

async function main(): Promise<void> {
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  await cp(runtimeManifest, join(staging, 'package.json'))
  await writeFile(join(staging, 'pnpm-workspace.yaml'), STAGING_WORKSPACE)
  await run(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', INSTALL_ARGS, staging)
  await materializeLinks()
  if (!existsSync(entry)) throw new Error(`desktop Host entry missing after staging: ${entry}`)
  if (!existsSync(frontend)) throw new Error(`desktop Web frontend missing after staging: ${frontend}`)
  console.log(`desktop runtime staged at ${staging}`)
}

await main()
