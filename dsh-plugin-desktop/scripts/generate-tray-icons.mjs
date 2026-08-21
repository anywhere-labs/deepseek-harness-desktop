/** Generate native tray bitmaps from the repository-owned brand mascot. */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const buildRoot = join(packageRoot, 'build')
const sourcePath = join(buildRoot, 'brand-mascot.png')

const colorVariants = [
  ['tray-icon-blue.png', 16],
  ['tray-icon-blue@1.25x.png', 20],
  ['tray-icon-blue@1.5x.png', 24],
  ['tray-icon-blue@2x.png', 32],
]

const templateVariants = [
  ['tray-iconTemplate.png', 16],
  ['tray-iconTemplate@2x.png', 32],
]

/**
 * Resize the full-color mascot into one Windows / Linux tray bitmap.
 * @param {string} filename - generated PNG name under `build/`.
 * @param {number} size - square pixel size.
 */
async function writeColorTrayIcon(filename, size) {
  await sharp(sourcePath)
    .resize({
      width: size,
      height: size,
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png({ compressionLevel: 9 })
    .toFile(join(buildRoot, filename))
}

/**
 * Build a black-and-alpha macOS template mark from the mascot alpha.
 * @param {string} filename - generated PNG name under `build/`.
 * @param {number} size - square pixel size.
 */
async function writeTemplateTrayIcon(filename, size) {
  const resized = sharp(sourcePath).resize({
    width: size,
    height: size,
    fit: 'contain',
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  })
  const { data, info } = await resized.ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const pixels = Buffer.alloc(info.width * info.height * 4)
  for (let index = 0; index < info.width * info.height; index += 1) {
    const offset = index * 4
    pixels[offset] = 0
    pixels[offset + 1] = 0
    pixels[offset + 2] = 0
    pixels[offset + 3] = data[offset + 3] ?? 0
  }
  await sharp(pixels, {
    raw: {
      width: info.width,
      height: info.height,
      channels: 4,
    },
  })
    .png({ compressionLevel: 9 })
    .toFile(join(buildRoot, filename))
}

await Promise.all([
  ...colorVariants.map(([filename, size]) => writeColorTrayIcon(filename, size)),
  ...templateVariants.map(([filename, size]) => writeTemplateTrayIcon(filename, size)),
])
