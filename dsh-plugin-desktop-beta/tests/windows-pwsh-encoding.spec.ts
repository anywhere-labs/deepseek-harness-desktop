import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { win32 } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ENCODING_PREAMBLE } from '@deepseek-ai/dsh-pwsh-local'
import { SandboxPwshExecutor } from '@deepseek-ai/dsh-pwsh-sandbox'
import { SandboxProvider, type ConfinedArgv, type SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { OutputCollector } from '@deepseek-ai/dsh-subprocess-local/output'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesktopWindowsPwshSandbox, desktopWindowsPwshStderr } from '../src/windows-pwsh-sandbox.ts'

const windowsPowerShell = win32.join(
  process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
)
const hasWindowsPowerShell = process.platform === 'win32' && existsSync(windowsPowerShell)
const category = '\r\n    + CategoryInfo          : ParserError: (:) [], ParseException\r\n'
const diagnostic = '    + FullyQualifiedErrorId : TerminatorExpectedAtEndOfString\r\n'
const legacy = Buffer.concat([Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), Buffer.from(category + diagnostic)])
const gbk = (bytes: Buffer) => new TextDecoder('gbk', { fatal: true }).decode(bytes)

describe('Windows PowerShell raw parser diagnostic reader', () => {
  it('uses original bytes and preserves byte offsets', () => {
    const collector = new OutputCollector(legacy.length, 'stderr', undefined)
    collector.push(legacy)
    const original = collector.readFrom(0)
    const decode = vi.fn(gbk)
    desktopWindowsPwshStderr(collector, () => true, decode)
    expect(collector.readFrom(0)).toEqual({ ...original, text: '中文' + category + diagnostic })
    expect(decode).toHaveBeenCalledWith(legacy)
    expect(collector.readFrom(4).text).toBe(category + diagnostic)
    expect(collector.readFrom(legacy.length).nextOffset).toBe(legacy.length)
  })

  it('does not consume a legacy fragment before a late parser marker arrives', () => {
    const collector = new OutputCollector(1_000, 'stderr', undefined)
    desktopWindowsPwshStderr(collector, () => false, gbk)
    collector.push(legacy.subarray(0, 2))
    expect(collector.readFrom(0)).toEqual({ text: '', nextOffset: 0, lossy: false })
    collector.push(legacy.subarray(2, 4))
    expect(collector.readFrom(0).nextOffset).toBe(0)
    collector.push(legacy.subarray(4))
    expect(collector.readFrom(0)).toEqual({ text: '中文' + category + diagnostic, nextOffset: legacy.length, lossy: false })
  })

  it('does not consume an incomplete legacy character after the marker', () => {
    const collector = new OutputCollector(1_000, 'stderr', undefined)
    const strict = (bytes: Buffer) => { try { return gbk(bytes) } catch { return undefined } }
    desktopWindowsPwshStderr(collector, () => false, strict)
    collector.push(Buffer.concat([legacy, Buffer.from([0xd6])]))
    expect(collector.readFrom(0).nextOffset).toBe(0)
    collector.push(Buffer.from([0xd0]))
    expect(collector.readFrom(0).text).toBe('中文' + category + diagnostic + '中')
  })

  it('releases unchanged non-parser bytes on settlement, including a literal ParserError word', () => {
    const collector = new OutputCollector(1_000, 'stderr', undefined)
    collector.push(Buffer.concat([legacy.subarray(0, 4), Buffer.from(' user text ParserError')]))
    const original = collector.readFrom(0)
    let settled = false
    const decode = vi.fn(gbk)
    desktopWindowsPwshStderr(collector, () => settled, decode)
    expect(collector.readFrom(0).nextOffset).toBe(0)
    settled = true
    expect(collector.readFrom(0)).toEqual(original)
    expect(decode).not.toHaveBeenCalled()
  })

  it('passes valid UTF-8 and genuine replacement characters through immediately', () => {
    const collector = new OutputCollector(1_000, 'stderr', undefined)
    collector.push(Buffer.from('中文\uFFFD' + category + diagnostic))
    const original = collector.readFrom(0)
    const decode = vi.fn(gbk)
    desktopWindowsPwshStderr(collector, () => false, decode)
    expect(collector.readFrom(0)).toEqual(original)
    expect(decode).not.toHaveBeenCalled()
  })

  it('does not mistake an incomplete UTF-8 character after the marker for legacy bytes', () => {
    const collector = new OutputCollector(1_000, 'stderr', undefined)
    const bytes = Buffer.from(category + '中文')
    const decode = vi.fn(gbk)
    desktopWindowsPwshStderr(collector, () => false, decode)
    collector.push(bytes.subarray(0, bytes.length - 1))
    expect(collector.readFrom(0).nextOffset).toBe(0)
    expect(decode).not.toHaveBeenCalled()
    collector.push(bytes.subarray(bytes.length - 1))
    expect(collector.readFrom(0)).toEqual({ text: bytes.toString('utf8'), nextOffset: bytes.length, lossy: false })
  })

  it('preserves UTF-8 tail truncation beginning inside a code point', () => {
    const bytes = Buffer.from('中文' + category + diagnostic)
    const collector = new OutputCollector(bytes.length - 1, 'stderr', undefined)
    collector.push(bytes)
    const original = collector.readFrom(0)
    const decode = vi.fn(gbk)
    desktopWindowsPwshStderr(collector, () => true, decode)
    expect(original.lossy).toBe(true)
    expect(collector.readFrom(0)).toEqual(original)
    expect(decode).not.toHaveBeenCalled()
  })

  it('keeps truncated legacy tails and spill paths in original byte coordinates', () => {
    const original = { text: legacy.subarray(2).toString('utf8'), nextOffset: legacy.length, lossy: true, spillPath: 'original-spill.log' }
    const reader = { readFrom: () => original, snapshot: () => ({ bytes: legacy.subarray(2), totalBytes: legacy.length }) }
    desktopWindowsPwshStderr(reader, () => true, gbk)
    expect(reader.readFrom()).toEqual({ ...original, text: '文' + category + diagnostic })
  })

  it('contains invalid conversion and decoder/report exceptions without breaking the reader', () => {
    for (const decode of [() => undefined, () => { throw new Error('decoder unavailable') }]) {
      const collector = new OutputCollector(1_000, 'stderr', undefined)
      collector.push(legacy)
      const original = collector.readFrom(0)
      const report = vi.fn(() => { throw new Error('report failed') })
      desktopWindowsPwshStderr(collector, () => true, decode, report)
      expect(collector.readFrom(0)).toEqual(original)
      expect(collector.readFrom(0)).toEqual(original)
      expect(report.mock.calls.length).toBeLessThanOrEqual(1)
    }
  })

  it('keeps providers without optional raw snapshots unchanged', () => {
    const reader = { readFrom: () => ({ text: 'provider output', lossy: false, nextOffset: 15 }) }
    expect(desktopWindowsPwshStderr(reader, () => true)).toBe(reader)
  })

  it('keeps frozen custom snapshot readers without losing their output', () => {
    const original = { text: legacy.toString('utf8'), lossy: false, nextOffset: legacy.length }
    const reader = Object.freeze({ readFrom: () => original, snapshot: () => ({ bytes: legacy, totalBytes: legacy.length }) })
    const report = vi.fn()
    expect(desktopWindowsPwshStderr(reader, () => true, gbk, report)).toBe(reader)
    expect(reader.readFrom()).toEqual(original)
    expect(report).toHaveBeenCalledOnce()
  })
})

function originalArgv(command: string): string[] {
  return [windowsPowerShell, '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', ENCODING_PREAMBLE + command]
}

function runPowerShell(command: string, input?: string) {
  const argv = originalArgv(command)
  const result = spawnSync(argv[0]!, argv.slice(1), {
    windowsHide: true, timeout: 5_000, maxBuffer: 256_000,
    ...(input === undefined ? {} : { input }),
  })
  expect(result.error).toBeUndefined()
  expect(result.signal).toBeNull()
  return { status: result.status, stdout: result.stdout.toString('utf8'), stderr: result.stderr.toString('utf8') }
}

const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function executorContext(
  prepare: (argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal) => Promise<ConfinedArgv>,
  mode: 'workspace-write' | 'danger-full-access' = 'workspace-write',
  Executor: typeof SandboxPwshExecutor = DesktopWindowsPwshSandbox,
) {
  class TestSandbox extends SandboxProvider {
    override confine(argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal): Promise<ConfinedArgv> {
      return prepare(argv, policy, signal)
    }
  }
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, { mode, workspaceRoot: process.cwd() })
  await ctx.plugin(TestSandbox)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(Executor, { pwshPath: windowsPowerShell, graceMs: 100 })
  return ctx
}

const passthrough = async (argv: readonly string[]) => ({
  argv: [...argv], enforcement: 'full' as const, denialSignatures: [], runnerFailureRules: [],
})

async function originalExecution(command: string, stdin?: string) {
  // A direct Node spawn and the real managed Windows Job can inherit different
  // console cultures. Compare the unchanged upstream executor on the same
  // registered provider, not a different spawn implementation.
  const ctx = await executorContext(passthrough, 'workspace-write', SandboxPwshExecutor)
  return (await ctx.shell.execute(ctx.shell.resolve({ command, ...(stdin === undefined ? {} : { stdin }) }))).result()
}

describe('registered Desktop PowerShell execution', () => {
  it.runIf(hasWindowsPowerShell).each(['workspace-write', 'danger-full-access'] as const)(
    'repairs the actual system PowerShell parser output without changing argv in %s', async mode => {
      const prepare = vi.fn(passthrough)
      const ctx = await executorContext(prepare, mode)
      const spawn = vi.spyOn(ctx.subprocess, 'spawn')
      const command = '$x = "unterminated string'
      const original = runPowerShell(command)
      const result = await (await ctx.shell.execute(ctx.shell.resolve({ command }))).result()
      expect(result.exitCode).toBe(original.status)
      expect(result.stdout.text).toBe(original.stdout)
      expect(result.stderr.text).not.toContain('\uFFFD')
      expect(result.stderr.text).toContain('ParserError')
      expect(result.stderr.text).toContain('FullyQualifiedErrorId : TerminatorExpectedAtEndOfString')
      expect(spawn).toHaveBeenCalledOnce()
      expect(spawn.mock.calls[0]![0].argv).toEqual(originalArgv(command))
      if (mode === 'workspace-write') expect(prepare.mock.calls[0]![0]).toEqual(originalArgv(command))
      else expect(prepare).not.toHaveBeenCalled()
      console.info('PowerShell parser encoding comparison', JSON.stringify({ mode, original, result }))
    },
  )

  it.runIf(hasWindowsPowerShell).each([
    ['native failure', 'cmd.exe /d /c exit 17', 1],
    ['nonterminating error', "Write-Error '中文错误'", 1],
    ['terminating error', "throw '中文异常'", 1],
    ['missing command', 'no_such_dsh_encoding_command', 1],
    ['explicit exit after failure', 'cmd.exe /d /c exit 17; exit 23', 23],
    ['early return after native failure', 'cmd.exe /d /c exit 17; return', 1],
    ['early return after error', "Write-Error '中文错误'; return 9", 1],
    ['native failure in return expression', 'return (cmd.exe /d /c exit 17)', 1],
    ['finally error after return', "try { return } finally { Write-Error '中文错误' }", 1],
    ['break after error', "Write-Error '中文错误'; break", 1],
    ['continue after error', "Write-Error '中文错误'; continue", 1],
    ['quoted multiline Unicode', "Write-Output '中文''单引号'\nWrite-Output \"第二行\"", 0],
    ['startup culture and working directory', '$PSCulture; $PSUICulture; $PWD.Path; $env:PSModulePath', 0],
    ['trailing comment after failure', "Write-Error '中文错误' # comment at EOF", 1],
    ['existing param behavior', 'param($value) Write-Output ok', 1],
    ['existing requires behavior', '#requires -Version 999\nWrite-Output ok', 0],
    ['long command', `Write-Output '${'a'.repeat(24_000)}'`, 0],
  ] as const)('preserves original status and output for %s', async (_label, command, status) => {
    const ctx = await executorContext(passthrough)
    const original = await originalExecution(command)
    const result = await (await ctx.shell.execute(ctx.shell.resolve({ command }))).result()
    expect(original.exitCode).toBe(status)
    expect(result.exitCode).toBe(original.exitCode)
    expect(result.stdout.text).toBe(original.stdout.text)
    expect(result.stderr.text).toBe(original.stderr.text)
  })

  it.runIf(hasWindowsPowerShell).each([
    ['input enumerator', '@($input).Count'],
    ['input text', '$input | ForEach-Object { Write-Output $_ }'],
    ['console input', '[Console]::In.ReadToEnd()'],
  ])('preserves native stdin for %s', async (_label, command) => {
    const ctx = await executorContext(passthrough)
    const stdin = 'input text\n第二行\n'
    const original = await originalExecution(command, stdin)
    const result = await (await ctx.shell.execute(ctx.shell.resolve({ command, stdin }))).result()
    expect(result.exitCode).toBe(original.exitCode)
    expect(result.stdout.text).toBe(original.stdout.text)
    expect(result.stderr.text).toBe(original.stderr.text)
  })

  it.runIf(hasWindowsPowerShell)('keeps concurrent traced executions and the registered subprocess service isolated', async () => {
    const ctx = await executorContext(passthrough)
    const runtime = ctx.subprocess
    const originalSpawn = Object.getOwnPropertyDescriptor(runtime, 'spawn')
    const executions = await Promise.all([
      ctx.shell.execute(ctx.shell.resolve({ command: '$x = "unterminated' })),
      ctx.shell.execute(ctx.shell.resolve({ command: "Write-Error '中文错误'; return 9" })),
    ])
    const [parser, normal] = await Promise.all(executions.map(execution => execution.result()))
    expect(parser!.stderr.text).not.toContain('\uFFFD')
    expect(parser!.stderr.text).toContain('ParserError')
    expect(normal!.exitCode).toBe(1)
    expect(normal!.stderr.text).toContain('中文错误')
    expect(Object.getOwnPropertyDescriptor(runtime, 'spawn')).toEqual(originalSpawn)
  })

  it.runIf(hasWindowsPowerShell)('keeps confinement and the native process-range deadline unchanged', async () => {
    const confine = vi.fn(async (argv: readonly string[], _policy: SandboxPolicy, _signal?: AbortSignal) => passthrough(argv))
    const ctx = await executorContext(confine)
    const command = 'Write-Output ("original:" + $PID); Start-Sleep -Seconds 30'
    const result = await (await ctx.shell.execute(ctx.shell.resolve({ command, timeoutMs: 1_500 }))).result()
    expect(confine).toHaveBeenCalledOnce()
    expect(confine.mock.calls[0]![0]).toEqual(originalArgv(command))
    expect(confine.mock.calls[0]![1]).toMatchObject({ mode: 'workspace-write', workspaceRoot: process.cwd() })
    expect(confine.mock.calls[0]![2]?.aborted).toBe(true)
    expect(result).toMatchObject({ timedOut: true, aborted: false, sandbox: { enforcement: 'full', denied: false } })
    const pid = Number(/original:(\d+)/.exec(result.stdout.text)?.[1])
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true)
    expect(() => process.kill(pid, 0)).toThrow()
  }, 10_000)

  it('does not spawn after the inherited confinement preparation deadline expires', async () => {
    const entered = Promise.withResolvers<AbortSignal | undefined>()
    const prepared = Promise.withResolvers<ConfinedArgv>()
    const ctx = await executorContext(async (_argv, _policy, signal) => {
      entered.resolve(signal)
      return prepared.promise
    })
    const spawn = vi.spyOn(ctx.subprocess, 'spawn')
    const execution = ctx.shell.execute(ctx.shell.resolve({ command: 'Write-Output ok', timeoutMs: 30 }))
    const signal = await entered.promise
    const result = await (await execution).result()
    expect(signal?.aborted).toBe(true)
    expect(result).toMatchObject({ timedOut: true, aborted: false, exitCode: null })
    expect(spawn).not.toHaveBeenCalled()
    prepared.resolve(await passthrough(originalArgv('Write-Output ok')))
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(spawn).not.toHaveBeenCalled()
  })
})
