/**
 * Cross-platform boot check for the staged/packaged Host: spawns
 * `dsh web` from the staged runtime and waits for the canonical
 * readiness line (`dsh web: http://127.0.0.1:<port>`). Used by CI on
 * all three platforms (grep-pipe steps are not portable to pwsh).
 *
 * Usage: node --import tsx scripts/boot-check-host.ts <bin.js>
 */
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const READINESS_PREFIX = 'dsh web: '
const TIMEOUT_MS = 60_000

const binPath = resolve(process.argv[2] ?? 'apps/desktop/runtime-host/node_modules/@deepseek-ai/dsh/lib/bin.js')

const child = spawn(process.execPath, ['--expose-internals', binPath, 'web', '--host', '127.0.0.1', '--port', '0'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})

let pending = ''
let ready = false
let timedOut = false

const timer = setTimeout(() => {
  timedOut = true
  console.error('HOST BOOT FAILED: no readiness line within 60s')
  child.kill('SIGKILL')
  process.exit(1)
}, TIMEOUT_MS)

function onChunk(chunk: Buffer): void {
  pending += chunk.toString()
  for (;;) {
    const newline = pending.indexOf('\n')
    if (newline === -1) break
    const line = pending.slice(0, newline)
    pending = pending.slice(newline + 1)
    if (line.startsWith(READINESS_PREFIX)) {
      const url = line.slice(READINESS_PREFIX.length).trim()
      if (new URL(url).hostname === '127.0.0.1' || new URL(url).hostname === 'localhost') {
        ready = true
        clearTimeout(timer)
        console.log(`HOST BOOT OK: ${url}`)
        child.kill('SIGTERM')
      }
    }
  }
}

child.stdout?.on('data', onChunk)
child.stderr?.on('data', onChunk)
child.on('exit', code => {
  if (!timedOut && !ready) {
    console.error(`HOST BOOT FAILED: exited early with code ${String(code)}`)
    process.exit(1)
  }
  if (ready) process.exit(0)
})
