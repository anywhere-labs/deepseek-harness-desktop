/**
 * Install an additional runtime version into the Desktop data dir.
 *
 * The install is a standalone production `pnpm install` of the runtime
 * manifest pinned to the requested version — the same mechanics the
 * bundled-runtime staging uses, minus workspace involvement. Requires a
 * `pnpm` executable (dev machines and the shell's own build machines have
 * it; a fully self-contained downloader is a follow-up).
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const RUNTIME_FRONTEND_VERSION = '0.0.1-rc.5'

export interface InstallRuntimeOptions {
  version: string
  targetDir: string
  /** pnpm executable (pnpm / pnpm.cmd). Absent = resolve bundled/system pnpm. */
  pnpmCommand?: string
  /** resourcesPath of the packaged app (where the bundled pnpm lives). */
  resourcesPath?: string
}

/**
 * Resolve a runnable pnpm command: the standalone binary bundled into the
 * app resources (packaged mode), else the system pnpm (development/build
 * machines). Returns undefined when neither exists.
 */
export function resolvePnpmCommand(resourcesPath?: string): string | undefined {
  if (resourcesPath !== undefined) {
    const bundled = join(resourcesPath, 'pnpm-exe', process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm')
    if (existsSync(bundled)) return bundled
  }
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
}

export function runtimeManifest(version: string): Record<string, unknown> {
  return {
    name: '@deepseek-ai/dsh-desktop-runtime',
    description: 'Dependency-only install root for a managed desktop Host runtime',
    version: '0.0.0',
    private: true,
    type: 'module',
    dependencies: {
      '@deepseek-ai/dsh': version,
      '@deepseek-ai/dsh-web-frontend': RUNTIME_FRONTEND_VERSION,
    },
  }
}

const STAGING_WORKSPACE = `packages: []
allowBuilds:
  node-pty: true
  koffi: true
  '@deepseek-ai/dsh-subprocess-local': true
  '@google/genai': false
  protobufjs: false
`

const INSTALL_ARGS = [
  'install',
  '--prod',
  '--config.node-linker=hoisted',
  '--config.verify-deps-before-run=false',
  '--config.auto-install-peers=true',
]

function run(command: string, args: readonly string[], cwd: string): Promise<void> {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, CI: 'true' }, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) accept()
      else reject(new Error(`runtime install failed (${code === null ? `signal ${String(signal)}` : `exit ${String(code)}`}): ${command} ${args.join(' ')}`))
    })
  })
}

export async function installRuntimeVersion(options: InstallRuntimeOptions): Promise<void> {
  const { version, targetDir } = options
  const pnpmCommand = options.pnpmCommand ?? resolvePnpmCommand(options.resourcesPath)
  if (pnpmCommand === undefined) throw new Error('no pnpm executable available (system or bundled)')
  await rm(targetDir, { recursive: true, force: true })
  await mkdir(targetDir, { recursive: true })
  await writeFile(join(targetDir, 'package.json'), `${JSON.stringify(runtimeManifest(version), null, 2)}\n`)
  await writeFile(join(targetDir, 'pnpm-workspace.yaml'), STAGING_WORKSPACE)
  await run(pnpmCommand, INSTALL_ARGS, targetDir)
  const entry = join(targetDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!existsSync(entry)) {
    throw new Error(`runtime install completed but Host entry is missing: ${entry}`)
  }
  const frontend = join(targetDir, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html')
  if (!existsSync(frontend)) {
    throw new Error(`runtime install completed but Web frontend is missing: ${frontend}`)
  }
}
