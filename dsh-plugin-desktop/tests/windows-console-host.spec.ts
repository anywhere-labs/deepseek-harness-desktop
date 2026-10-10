import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

// The Electron-hosted ACL runner starts without a console. A restricted console child that has
// to create its own console fails DLL initialization with 0xC0000142 (#991), and a hidden
// AllocConsole() window can be handed to Windows Terminal and flash on every command (#1268).
// This runs the real console setup in a detached (consoleless) Node process and then starts a
// real restricted cmd.exe, once per strategy the target Windows version can reach.
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const consoleHost = pathToFileURL(join(packageRoot, 'src', 'windows-console-host.ts')).href
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const probe = `
import { AclSandbox, workspaceWriteSid } from '@deepseek-ai/dsh-sandbox-windows-acl'
import { ensureWindowsConsoleHost, loadWindowsConsoleHostApi } from ${JSON.stringify(consoleHost)}
const [workspace, strategy] = process.argv.slice(-2)
const api = loadWindowsConsoleHostApi()
const report = { consoleBefore: api.hasConsole(), windowless: api.allocWindowlessConsole !== undefined }
const loadApi = strategy === 'donor' ? () => ({ ...api, allocWindowlessConsole: undefined }) : () => api
await ensureWindowsConsoleHost('win32', loadApi)
report.consoleAfter = api.hasConsole()
report.consoleWindow = api.getConsoleWindow() !== null
const sandbox = new AclSandbox({ writableDirs: [workspace], mode: 'workspace-write', tempDir: null, writeSid: workspaceWriteSid(workspace) })
const cmd = (process.env.SystemRoot ?? 'C:\\\\Windows') + '\\\\System32\\\\cmd.exe'
try {
  await sandbox.init()
  const child = sandbox.spawn({ command: cmd, args: ['/d', '/c', 'echo inside>inside.txt'], cwd: workspace, stdio: 'inherit' })
  report.exitCode = (await child.wait()).exitCode
} finally {
  sandbox.dispose()
}
process.stdout.write(JSON.stringify(report))
`

function runDetached(workspace: string, strategy: string): Promise<{ status: number | null, stdout: string, stderr: string }> {
  // DETACHED_PROCESS: the probe starts with no console, like the Electron GUI runner.
  const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', probe, workspace, strategy], {
    cwd: packageRoot,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', status => resolve({ status, stdout, stderr }))
  })
}

describe.runIf(process.platform === 'win32')('Windows ACL runner console host on real Windows', () => {
  it.each(['default', 'donor'])('gives a consoleless runner a windowless console restricted children inherit (%s)', async (strategy) => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-console-host-'))
    roots.push(root)
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)

    const result = await runDetached(workspace, strategy)

    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      consoleBefore: false,
      consoleAfter: true,
      consoleWindow: false,
      exitCode: 0,
    })
    expect(existsSync(join(workspace, 'inside.txt'))).toBe(true)
    expect(readFileSync(join(workspace, 'inside.txt'), 'utf8').trim()).toBe('inside')
  }, 60_000)
})
