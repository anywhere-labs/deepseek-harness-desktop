/** Build a Linux AppImage package. */

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function run(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): void {
  console.log(`Running: ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`)
  }
}

function packageLinux(): void {
  const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const workspaceRoot = resolve(desktopRoot, '..')
  const require = createRequire(import.meta.url)
  const builderCli = require.resolve('electron-builder/cli.js')

  console.log('Building Linux AppImage package...')

  // Run build first
  console.log('Building application...')
  run('yarn', ['workspace', 'dsh-plugin-desktop', 'build'], workspaceRoot, process.env)

  // Package Linux AppImage
  console.log('Packaging Linux AppImage...')
  run(
    process.execPath,
    [builderCli, '--linux', 'AppImage', '--x64', '--publish', 'never', '--config.npmRebuild=false'],
    desktopRoot,
    process.env,
  )

  console.log('✓ Linux AppImage built successfully')
  console.log('Output: dsh-plugin-desktop/dist/')
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  try {
    packageLinux()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
