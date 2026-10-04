/** Explicit hidden Electron check; its parent owns cleanup after Chromium releases userData. */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'win32' && !(process.platform === 'linux' && process.env.DISPLAY)) {
  throw new Error('Plugin frame checks require Windows or Linux under xvfb-run; check:next never starts Electron.')
}
const home = mkdtempSync(join(tmpdir(), 'dsh-next-plugin-frames-'))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
try {
  const electron = createRequire(import.meta.url)('electron')
  const entry = fileURLToPath(new URL('verify-protocol.mjs', import.meta.url))
  const child = spawn(electron, [entry, '--plugin-frames', '--plugin-frames-home', home], { env, stdio: 'inherit', windowsHide: true })
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => resolve(code ?? 1))
  })
  process.exitCode = code
} finally {
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
