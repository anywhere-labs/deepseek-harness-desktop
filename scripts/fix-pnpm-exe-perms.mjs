/**
 * @pnpm/exe ships its standalone pnpm binary with non-executable
 * permissions (its setup.js replaces a placeholder file). Restore +x on
 * POSIX so the packaged-install path can spawn it directly.
 */
import { chmodSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

if (process.platform === 'win32') process.exit(0)

const candidates = [
  resolve(import.meta.dirname, '..', 'apps', 'desktop', 'node_modules', '@pnpm', 'exe', 'pnpm'),
  resolve(import.meta.dirname, '..', 'node_modules', '@pnpm', 'exe', 'pnpm'),
]
for (const candidate of candidates) {
  if (existsSync(candidate)) {
    chmodSync(candidate, 0o755)
    console.log(`chmod +x ${join('node_modules', '@pnpm', 'exe', 'pnpm')}`)
  }
}
