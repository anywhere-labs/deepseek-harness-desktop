/** Real Windows smoke for the official minimal pwsh stack over the Desktop ACL relay. */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import { resolvePwshPath } from '@deepseek-ai/dsh-pwsh-local'
import LocalSandbox from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import TerminalSessionService from '@deepseek-ai/dsh-terminal'
import * as TerminalBash from '@deepseek-ai/dsh-terminal-bash'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as ToolPwshPersistent from '@deepseek-ai/dsh-tool-pwsh-persistent'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import { adaptWindowsAclTerminalSpawn } from '../lib/windows-subprocess.js'

const WORKER_FLAG = '--worker'
const EXECUTION_POLICY = 'PSEXECUTIONPOLICYPREFERENCE'

function deadline(promise, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error(`${label} timed out after ${timeoutMs}ms`)) }, timeoutMs)
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}

function sameWindowsPath(left, right) {
  return win32.normalize(left).toUpperCase() === win32.normalize(right).toUpperCase()
}

function expect(condition, message) {
  if (!condition) throw new Error(message)
}

function toolText(result) {
  return result.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

function owner(ctx, rawId, cwd) {
  const id = SessionId(rawId)
  const scope = ctx.plugin(() => {})
  const session = Session.create(id, [], { version: 0, id, createdAt: 0, cwd })
  const value = {
    id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted() {}, discarded() {}, claimed() {} }),
    status: 'idle',
    ctx: scope.ctx,
    send() {},
    followup() {},
    steer() { return { outcome: Promise.resolve({ status: 'rejected' }) } },
    inject() {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(value)
  return value
}

async function scenario(inputs) {
  const context = new Context()
  let callNumber = 0
  try {
    await context.plugin(SystemPrompt)
    await context.plugin(ToolRegistry)
    await context.plugin(AgentRegistry)
    await context.plugin(TerminalSessionService)
    await context.plugin(LocalSandbox, {})
    // A Node worker models the Electron Host by asking the official sandbox
    // provider to emit the same Electron + runner prefix used in production.
    context.sandbox.internals.windowsAclRunnerArgs = [inputs.electron, inputs.runner]
    await context.plugin(SandboxPolicyService, {
      mode: 'read-only',
      workspaceRoot: inputs.packageRoot,
    })

    class SmokeDesktopSubprocess extends LocalSubprocessRuntime {
      spawnTerminal(spec) {
        return super.spawnTerminal(adaptWindowsAclTerminalSpawn(spec, {
          platform: 'win32',
          electron: true,
          execPath: inputs.electron,
          upstreamRunner: inputs.runner,
          trampoline: inputs.trampoline,
          env: process.env,
        }))
      }
    }

    await context.plugin(SmokeDesktopSubprocess)
    await context.plugin(TerminalBash, {
      shellDialect: 'pwsh',
      shellPath: inputs.shellPath,
      timeoutMs: 20_000,
      idleSilenceMs: 1_000,
      handoffGraceMs: 500,
      disposeGraceMs: 1_000,
    })
    await context.plugin(ToolPwshPersistent, { timeoutMs: 30_000 })

    const agent = owner(context, `windows-minimal-${inputs.label}`, inputs.packageRoot)
    const execute = (command, signal = new AbortController().signal) => context.tools.execute({
      signal,
      callId: CallId(`${inputs.label}-${++callNumber}`),
      name: 'pwsh',
      arguments: { command },
      agent,
    })

    const first = await execute('$global:DshDesktopRelayState = 41; Write-Output ([int]$global:DshDesktopRelayState + 1)')
    expect(!first.isError && toolText(first).trim() === '42', `${inputs.label}: first persistent command failed: ${JSON.stringify(first)}`)

    const second = await execute('Write-Output ("中文 special=&|<>^ value=" + ([int]$global:DshDesktopRelayState * 2))')
    expect(
      !second.isError && toolText(second).trim() === '中文 special=&|<>^ value=82',
      `${inputs.label}: Unicode or persistent state failed: ${JSON.stringify(second)}`,
    )

    const policy = await execute("if (Test-Path Env:PSExecutionPolicyPreference) { Write-Output $env:PSExecutionPolicyPreference } else { Write-Output '<unset>' }")
    const expectedPolicy = inputs.expectsBypass ? 'Bypass' : '<unset>'
    expect(
      !policy.isError && toolText(policy).trim() === expectedPolicy,
      `${inputs.label}: unexpected process execution policy: ${JSON.stringify(policy)}`,
    )

    const controller = new AbortController()
    const abortTimer = setTimeout(() => { controller.abort(new Error('windows-minimal-audit-stop')) }, 3_000)
    const aborted = await execute('Start-Sleep -Seconds 60', controller.signal).finally(() => { clearTimeout(abortTimer) })
    expect(aborted.isError && /abort|windows-minimal-audit-stop/iu.test(toolText(aborted)), `${inputs.label}: abort was not reported: ${JSON.stringify(aborted)}`)
    expect(context.terminals.list(agent).length === 0, `${inputs.label}: aborted terminal was not reset`)

    const recovered = await execute('Write-Output "after-abort-ok"')
    expect(!recovered.isError && toolText(recovered).trim() === 'after-abort-ok', `${inputs.label}: recovery failed: ${JSON.stringify(recovered)}`)

    const exited = await execute('exit 7')
    expect(toolText(exited).includes('next pwsh call starts from the workspace'), `${inputs.label}: shell exit was not reset: ${JSON.stringify(exited)}`)
    expect(context.terminals.list(agent).length === 0, `${inputs.label}: exited terminal was not reset`)

    const afterExit = await execute('Write-Output "after-exit-ok"')
    expect(!afterExit.isError && toolText(afterExit).trim() === 'after-exit-ok', `${inputs.label}: post-exit recovery failed: ${JSON.stringify(afterExit)}`)
    return { label: inputs.label, shellPath: inputs.shellPath }
  } finally {
    await context.fiber.dispose()
  }
}

async function worker() {
  for (const key of Object.keys(process.env)) {
    if (key.toUpperCase() === EXECUTION_POLICY) delete process.env[key]
  }
  const packageRoot = fileURLToPath(new URL('..', import.meta.url))
  const electron = join(packageRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
  const trampoline = join(packageRoot, 'lib', 'windows-acl-runner.js')
  const runner = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-sandbox-windows-acl/runner'))
  const systemRoot = process.env.SystemRoot
  if (systemRoot === undefined || systemRoot.length === 0) throw new Error('Windows minimal PTY smoke requires SystemRoot')
  const fallback = win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const resolved = resolvePwshPath()
  const paths = [{
    label: 'official-resolver',
    shellPath: resolved,
    expectsBypass: sameWindowsPath(resolved, fallback),
  }]
  if (existsSync(fallback) && !sameWindowsPath(resolved, fallback)) {
    paths.push({ label: 'windows-powershell-5.1-fallback', shellPath: fallback, expectsBypass: true })
  }

  const results = []
  for (const path of paths) {
    results.push(await scenario({ packageRoot, electron, trampoline, runner, ...path }))
  }
  await new Promise(resolve => { process.stdout.write(`${JSON.stringify({ ok: true, results })}\n`, resolve) })
}

async function parent() {
  const script = fileURLToPath(import.meta.url)
  const child = spawn(process.execPath, [script, WORKER_FLAG], {
    cwd: dirname(script),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const exitCode = await deadline(new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  }), 90_000, 'Windows minimal PTY smoke worker').catch(error => {
    child.kill()
    throw error
  })
  let report
  try {
    report = JSON.parse(stdout)
  } catch {
    report = undefined
  }
  if (exitCode !== 0 || report?.ok !== true || stderr.length > 0) {
    throw new Error(`Windows minimal PTY smoke leaked host output or failed: ${JSON.stringify({ exitCode, stdout, stderr })}`)
  }
}

async function main() {
  if (process.platform !== 'win32') return
  if (process.argv.includes(WORKER_FLAG)) {
    await worker()
    process.exit(0)
  }
  await parent()
}

void main().catch(cause => {
  const detail = cause instanceof Error ? cause.stack ?? cause.message : String(cause)
  process.stderr.write(`verify-windows-minimal-pty: ${detail}\n`)
  process.exitCode = 1
})
