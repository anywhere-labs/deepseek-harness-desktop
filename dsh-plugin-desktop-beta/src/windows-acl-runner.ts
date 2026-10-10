/** Node-mode trampoline for the upstream Windows ACL runner. */

import { fileURLToPath, pathToFileURL } from 'node:url'
import { ensureWindowsConsoleHost } from './windows-console-host.ts'

const RUN_AS_NODE = 'ELECTRON_RUN_AS_NODE'
const RUNNER_FAILURE_EXIT = 127
const RUNNER_SIGNATURE = 'windows-acl-run'

function removeRunAsNodeEnvironment(): void {
  for (const key of Object.keys(process.env)) {
    if (key.toUpperCase() === RUN_AS_NODE) delete process.env[key]
  }
}

async function main(): Promise<void> {
  const requestedRunner = process.argv[2]
  removeRunAsNodeEnvironment()
  const expectedRunner = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-sandbox-windows-acl/runner'))
  if (requestedRunner !== expectedRunner) {
    throw new Error('desktop trampoline received an unexpected ACL runner')
  }
  await ensureWindowsConsoleHost()
  process.argv = [process.argv[0] as string, expectedRunner, ...process.argv.slice(3)]
  await import(pathToFileURL(expectedRunner).href)
}

void main().catch((cause: unknown) => {
  const detail = cause instanceof Error ? cause.message : String(cause)
  process.stderr.write(`${RUNNER_SIGNATURE}: desktop trampoline: ${detail}\n`)
  process.exitCode = RUNNER_FAILURE_EXIT
})
