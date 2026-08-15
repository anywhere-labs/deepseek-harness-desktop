/**
 * Upstream contract gate for the desktop shell.
 *
 * The shell consumes a deliberately tiny upstream surface:
 *   1. @deepseek-ai/dsh — the Host CLI entry (lib/bin.js) + its public
 *      package metadata (exports/bin/dependencies);
 *   2. @deepseek-ai/dsh-web-frontend — the Web UI static bundle
 *      (dist/index.html + asset inventory);
 *   3. the readiness line the supervisor parses (`dsh web: <url>`) —
 *      validated by the CI boot-check step, not re-snapshotted here.
 *
 * Snapshot, don't fork: `--snapshot` records the surface of the installed
 * upstream packages; `verify` recomputes and diffs. On an upstream bump,
 * the diff fails HERE (CI), the diff is reviewed, and the snapshot is
 * regenerated — the recorded upgrade procedure.
 *
 * Run via `node --import tsx scripts/verify-upstream-contract.ts [--snapshot]`.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const snapshotDir = join(root, 'contracts', 'upstream')
const dshSnapshotPath = join(snapshotDir, 'dsh.snapshot.json')
const frontendSnapshotPath = join(snapshotDir, 'web-frontend.snapshot.json')

interface DshSnapshot {
  version: string
  bin: Record<string, string>
  exports: Record<string, unknown>
  dependencies: Record<string, string>
  binJsSha256: string
}

interface FrontendSnapshot {
  version: string
  distFiles: number
  indexHtmlSha256: string
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function resolveInstalledPackage(packageName: string): string {
  const path = import.meta.resolve(`${packageName}/package.json`)
  const filePath = path.startsWith('file:') ? path.slice('file:'.length) : path
  return filePath
}

function computeDshSnapshot(): DshSnapshot {
  const manifestPath = resolveInstalledPackage('@deepseek-ai/dsh')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    version?: string
    bin?: Record<string, string>
    exports?: Record<string, unknown>
    dependencies?: Record<string, string>
  }
  const packageDir = join(manifestPath, '..')
  const binJs = join(packageDir, 'lib', 'bin.js')
  if (!existsSync(binJs)) throw new Error(`@deepseek-ai/dsh Host entry missing: ${binJs}`)
  return {
    version: manifest.version ?? '',
    bin: manifest.bin ?? {},
    exports: manifest.exports ?? {},
    dependencies: manifest.dependencies ?? {},
    binJsSha256: sha256File(binJs),
  }
}

function computeFrontendSnapshot(): FrontendSnapshot {
  const manifestPath = resolveInstalledPackage('@deepseek-ai/dsh-web-frontend')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: string }
  const packageDir = join(manifestPath, '..')
  const dist = join(packageDir, 'dist')
  if (!existsSync(dist)) throw new Error(`@deepseek-ai/dsh-web-frontend dist missing: ${dist}`)
  const countFiles = (dir: string): number =>
    readdirSync(dir).reduce((total, entry) => {
      const path = join(dir, entry)
      return total + (statSync(path).isDirectory() ? countFiles(path) : 1)
    }, 0)
  const indexHtml = join(dist, 'index.html')
  if (!existsSync(indexHtml)) throw new Error(`web frontend index missing: ${indexHtml}`)
  return {
    version: manifest.version ?? '',
    distFiles: countFiles(dist),
    indexHtmlSha256: sha256File(indexHtml),
  }
}

function readSnapshot<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

function compare(label: string, path: string, current: object): boolean {
  const recorded = readSnapshot(path)
  if (recorded === undefined) {
    console.error(`${label} snapshot missing: ${path}`)
    return false
  }
  if (JSON.stringify(recorded) === JSON.stringify(current)) {
    console.log(`${label} contract OK`)
    return true
  }
  console.error(`${label} contract drifted:`)
  console.error(`  recorded: ${JSON.stringify(recorded)}`)
  console.error(`  current : ${JSON.stringify(current)}`)
  return false
}

const dsh = computeDshSnapshot()
const frontend = computeFrontendSnapshot()

if (process.argv[2] === '--snapshot') {
  const { mkdirSync } = await import('node:fs')
  mkdirSync(snapshotDir, { recursive: true })
  writeFileSync(dshSnapshotPath, `${JSON.stringify(dsh, null, 2)}\n`)
  writeFileSync(frontendSnapshotPath, `${JSON.stringify(frontend, null, 2)}\n`)
  console.log(`contracts snapshots written to ${snapshotDir}`)
  process.exit(0)
}

const dshOk = compare('@deepseek-ai/dsh', dshSnapshotPath, dsh)
const frontendOk = compare('@deepseek-ai/dsh-web-frontend', frontendSnapshotPath, frontend)
if (!dshOk || !frontendOk) {
  console.error('Regenerate after review: node --import tsx scripts/verify-upstream-contract.ts --snapshot')
  process.exit(1)
}
