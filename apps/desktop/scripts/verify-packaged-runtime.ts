/** Reject a packaged desktop shell that omitted the staged Host entrypoints. */

import { access, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AfterPackContext } from 'electron-builder'

const REQUIRED_HOST_FILES = [
  ['@deepseek-ai', 'dsh', 'lib', 'bin.js'],
  ['@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html'],
  ['@deepseek-ai', 'dsh-sandbox-windows-acl', 'lib', 'runner.js'],
] as const

const RELATIVE_IMPORT = /\bfrom\s+['"](\.\/[^'"]+)['"]/gu

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
  const source = await readFile(runner, 'utf8')
  for (const match of source.matchAll(RELATIVE_IMPORT)) {
    const specifier = match[1]
    if (specifier !== undefined) await access(join(dirname(runner), specifier))
  }
}

export default afterPack
