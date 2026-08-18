import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'))
const paths = [
  manifest.types,
  manifest.exports['.'].types,
  manifest.exports['./client'].types,
  manifest.exports['./contracts'].types,
]
for (const path of paths) {
  const absolute = resolve(packageRoot, path)
  if (!existsSync(absolute)) throw new Error(`missing package type export: ${path}`)
}
console.log(`verify-package-exports: ${paths.length} type exports exist`)
