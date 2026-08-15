/** Reject a packaged desktop shell that omitted the staged Host entrypoints. */

import { access, readFile } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import type { AfterPackContext } from 'electron-builder'
import ts from 'typescript'

const REQUIRED_HOST_FILES = [
  ['@deepseek-ai', 'dsh', 'lib', 'bin.js'],
  ['@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html'],
  ['@deepseek-ai', 'dsh-sandbox-windows-acl', 'lib', 'runner.js'],
] as const

const JAVASCRIPT_EXTENSIONS = new Set(['.cjs', '.js', '.mjs'])

async function verifyRelativeImportClosure(entry: string, packageRoot: string): Promise<void> {
  const pending = [entry]
  const visited = new Set<string>()
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === undefined || visited.has(current)) continue
    visited.add(current)
    await access(current)
    if (!JAVASCRIPT_EXTENSIONS.has(extname(current))) continue
    const source = await readFile(current, 'utf8')
    for (const imported of ts.preProcessFile(source, true, true).importedFiles) {
      if (!imported.fileName.startsWith('./') && !imported.fileName.startsWith('../')) continue
      const target = resolve(dirname(current), imported.fileName)
      const fromPackage = relative(packageRoot, target)
      if (fromPackage === '..' || fromPackage.startsWith(`..${sep}`)) {
        throw new Error(`packaged desktop runtime import escapes its package: ${imported.fileName}`)
      }
      pending.push(target)
    }
  }
}

/**
 * Verify the Host files required before the signed application can start.
 * @param context - Electron Builder's completed application directory.
 * @returns A promise that rejects when a staged Host entrypoint is absent.
 */
export async function afterPack(context: AfterPackContext): Promise<void> {
  const resources = context.electronPlatformName === 'darwin'
    ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : join(context.appOutDir, 'resources')
  for (const segments of REQUIRED_HOST_FILES) {
    await access(join(resources, 'host', 'node_modules', ...segments))
  }
  const runner = join(resources, 'host', 'node_modules', '@deepseek-ai', 'dsh-sandbox-windows-acl', 'lib', 'runner.js')
  await verifyRelativeImportClosure(runner, resolve(dirname(runner), '..'))
}

export default afterPack
