/** Knock out the mascot studio backdrop and write the 1024 RGBA16 app-icon source. */

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const buildRoot = join(packageRoot, 'build')
const defaultSourcePath = join(buildRoot, 'brand-mascot.png')
const sourcePath = process.argv[2] ?? defaultSourcePath
const mascotOutputPath = join(buildRoot, 'brand-mascot.png')
const outputPath = join(buildRoot, 'app-icon.png')

/** Circle that follows the rendered sphere, inside the white studio canvas. */
const MASCOT_CENTER_X = 512
const MASCOT_CENTER_Y = 498
const MASCOT_RADIUS = 313
const MASCOT_FEATHER = 1.2

/**
 * Replace the opaque white studio backdrop with a tight circular alpha.
 * @param {Buffer} source - original RGB or RGBA mascot bytes.
 * @returns {Promise<Buffer>} 1024 RGBA PNG with a transparent exterior.
 */
export async function knockOutMascotBackdrop(source) {
  const { data, info } = await sharp(source, { failOn: 'warning' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const pixels = Buffer.from(data)
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const distance = Math.hypot(x + 0.5 - MASCOT_CENTER_X, y + 0.5 - MASCOT_CENTER_Y)
      let alpha = 255
      if (distance >= MASCOT_RADIUS + MASCOT_FEATHER) {
        alpha = 0
      }
      else if (distance > MASCOT_RADIUS) {
        alpha = Math.round(255 * (1 - (distance - MASCOT_RADIUS) / MASCOT_FEATHER))
      }
      pixels[(y * info.width + x) * 4 + 3] = Math.min(pixels[(y * info.width + x) * 4 + 3] ?? 255, alpha)
    }
  }

  const knocked = await sharp(pixels, {
    raw: {
      width: info.width,
      height: info.height,
      channels: 4,
    },
  })
    .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 0 })
    .png()
    .toBuffer()

  return sharp(knocked)
    .resize({
      width: 1024,
      height: 1024,
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
      kernel: sharp.kernel.lanczos3,
    })
    .png({ compressionLevel: 9 })
    .toBuffer()
}

const existing = await sharp(outputPath).metadata()
if (existing.icc === undefined) {
  throw new Error('process-brand-icon: existing app-icon.png must provide an ICC profile')
}

const iccDirectory = await mkdtemp(join(tmpdir(), 'ai-buddy-icc-'))
const iccPath = join(iccDirectory, 'source.icc')
await writeFile(iccPath, existing.icc)

const cleaned = await knockOutMascotBackdrop(await sharp(sourcePath).toBuffer())
await writeFile(mascotOutputPath, cleaned)

const rendered = await sharp(cleaned)
  .ensureAlpha()
  .toColourspace('rgb16')
  .withIccProfile(iccPath)
  .png({
    compressionLevel: 9,
    progressive: false,
    adaptiveFiltering: false,
    palette: false,
  })
  .toBuffer()

const generated = await sharp(rendered).metadata()
if (
  generated.format !== 'png'
  || generated.width !== 1024
  || generated.height !== 1024
  || generated.space !== 'rgb16'
  || generated.depth !== 'ushort'
  || generated.bitsPerSample !== 16
  || generated.channels !== 4
  || generated.hasAlpha !== true
) {
  throw new Error('process-brand-icon: generated icon did not satisfy the RGBA16 source contract')
}

await writeFile(outputPath, rendered)
process.stdout.write(`process-brand-icon: wrote ${mascotOutputPath} and ${outputPath}\n`)
