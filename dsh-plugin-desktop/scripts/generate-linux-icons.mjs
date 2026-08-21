/** Generate the freedesktop icon theme sizes installed by the Linux packages. */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

/**
 * Icon theme sizes written to build/icons.
 *
 * Capped at 512 because the freedesktop hicolor index.theme declares no
 * 1024x1024 directory, and a spec-compliant icon theme lookup never enumerates
 * an undeclared directory.
 */
export const LINUX_ICON_SIZES = [16, 24, 32, 48, 64, 96, 128, 256, 512]

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const sourcePath = join(packageRoot, 'build', 'app-icon.png')
const outputRoot = join(packageRoot, 'build', 'icons')

/**
 * Render every icon theme size from the cross-platform source icon.
 * @param {string} source - absolute path to the square source PNG.
 * @param {string} output - absolute directory receiving NxN.png files.
 * @returns {Promise<void>} Resolves after every icon has been written.
 */
export async function generateLinuxIcons(source = sourcePath, output = outputRoot) {
  const largest = LINUX_ICON_SIZES[LINUX_ICON_SIZES.length - 1]
  const metadata = await sharp(source).metadata()
  if (metadata.format !== 'png' || metadata.width !== metadata.height) {
    throw new Error('generate-linux-icons: source must be a square PNG')
  }
  if (metadata.width === undefined || metadata.width < largest) {
    throw new Error(`generate-linux-icons: source must be at least ${largest}x${largest} pixels`)
  }

  await mkdir(output, { recursive: true })
  await Promise.all(LINUX_ICON_SIZES.map(async (size) => {
    const rendered = await sharp(source, { failOn: 'warning' })
      .resize({ width: size, height: size, fit: 'fill', kernel: sharp.kernel.lanczos3 })
      .toColourspace('srgb')
      .png({ compressionLevel: 9, palette: false })
      .toBuffer()
    await writeFile(join(output, `${String(size)}x${String(size)}.png`), rendered)
  }))
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  await generateLinuxIcons()
}
