// src/ai-diagnostic-analyzer.ts
import { spawn } from 'node:child_process'
import { packagedDependencyPath } from './packaged-runtime-path.ts'
import type { AiDiagnosis } from './diagnostic-analyzer.ts'

const TIER_ONE_TIMEOUT_MS = 15_000
const TIER_ONE_MAX_STDOUT_BYTES = 1024 * 1024

export async function runTierOneAnalysis(
  input: string,
  signal?: AbortSignal,
): Promise<AiDiagnosis | undefined> {
  try {
    const dshCli = packagedDependencyPath(import.meta.url, '@deepseek-ai/dsh/lib/bin.js')
    const text = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [dshCli, '--recovery-analyze', '--stdin'], {
        stdio: ['pipe', 'pipe', 'ignore'],
      })
      let out = ''
      let settled = false
      const abortError = new DOMException('Tier-1 analysis aborted.', 'AbortError')
      const settle = (finalize: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', abortHandler)
        finalize()
      }
      const abortHandler = (): void => {
        child.kill('SIGKILL')
        settle(() => reject(abortError))
      }
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        settle(() => reject(new Error('dsh analyze timed out')))
      }, TIER_ONE_TIMEOUT_MS)
      timer.unref?.()
      // Swallow EPIPE and any stdin stream error; only the exit handler decides
      // the outcome. Without this, a child that exits before consuming stdin
      // fires an uncaught 'error' event in Electron main and crashes the process.
      child.stdin.on('error', () => {})
      child.stdout.on('data', chunk => {
        if (out.length < TIER_ONE_MAX_STDOUT_BYTES) out += String(chunk)
      })
      child.on('error', cause => settle(() => reject(cause)))
      child.on('exit', code => settle(() => {
        if (code === 0) resolve(out)
        else reject(new Error(`dsh exit ${code}`))
      }))
      if (signal !== undefined) {
        if (signal.aborted) {
          child.kill('SIGKILL')
          settle(() => reject(abortError))
        } else {
          signal.addEventListener('abort', abortHandler, { once: true })
        }
      }
      child.stdin.end(JSON.stringify({ input }))
    })
    const parsed = JSON.parse(text) as AiDiagnosis
    if (parsed?.options === undefined) return undefined
    return parsed
  } catch {
    return undefined   // 静默降级：绝不阻塞恢复页
  }
}
