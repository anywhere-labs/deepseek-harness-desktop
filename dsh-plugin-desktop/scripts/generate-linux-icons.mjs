/** Generate Freedesktop hicolor PNG sizes from the shared application icon. */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

/** Pixel sizes required by Electron Builder Linux icon directories. */
export const LINUX_ICON_SIZES = [16, 24, 32, 48, 64, 96, 128, 256, 512]

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const sourcePath = join(packageRoot, 'build', 'app-icon.png')
const outputDirectory = join(packageRoot, 'build', 'icons')

/**
 * Derive one Freedesktop icon directory without changing the cross-platform source.
 * @param {string} source - absolute path to the square source PNG.
 * @param {string} output - absolute directory receiving `${size}x${size}.png` files.
 * @returns {Promise<void>} Resolves after every size has been written.
 */
export async function generateLinuxIcons(source = sourcePath, output = outputDirectory) {
  const resolvedSource = resolve(source)
  const resolvedOutput = resolve(output)
  if (resolvedSource === resolvedOutput || resolvedSource.startsWith(`${resolvedOutput}/`)) {
    throw new Error('generate-linux-icons: output directory must not contain the source icon')
  }

  const metadata = await sharp(resolvedSource).metadata()
  if (
    metadata.format !== 'png'
    || metadata.width !== metadata.height
    || metadata.width === undefined
    || metadata.channels !== 4
    || metadata.hasAlpha !== true
  ) {
    throw new Error('generate-linux-icons: source must be a square PNG with an alpha channel')
  }

  await mkdir(resolvedOutput, { recursive: true })
  await Promise.all(LINUX_ICON_SIZES.map(async (size) => {
    const rendered = await sharp(resolvedSource, { failOn: 'warning' })
      .resize({
        width: size,
        height: size,
        fit: 'fill',
        kernel: sharp.kernel.lanczos3,
      })
      .toColourspace('srgb')
      .png({ compressionLevel: 9 })
      .toBuffer()

    const generated = await sharp(rendered).metadata()
    if (
      generated.format !== 'png'
      || generated.width !== size
      || generated.height !== size
      || generated.channels !== 4
      || generated.hasAlpha !== true
    ) {
      throw new Error(`generate-linux-icons: ${size}x${size} icon did not keep square RGBA geometry`)
    }

    await writeFile(join(resolvedOutput, `${size}x${size}.png`), rendered)
  }))
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  await generateLinuxIcons()
}
