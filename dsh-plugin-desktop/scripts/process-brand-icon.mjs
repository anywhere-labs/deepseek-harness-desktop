/** Convert the AI Buddy mascot into the 1024 RGBA16 app-icon source. */

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const buildRoot = join(packageRoot, 'build')
const sourcePath = process.argv[2]
const outputPath = join(buildRoot, 'app-icon.png')
const existingPath = join(buildRoot, 'app-icon.png')

if (typeof sourcePath !== 'string' || sourcePath.length === 0) {
  throw new Error('process-brand-icon: pass the mascot PNG path')
}

const existing = await sharp(existingPath).metadata()
if (existing.icc === undefined) {
  throw new Error('process-brand-icon: existing app-icon.png must provide an ICC profile')
}

const iccDirectory = await mkdtemp(join(tmpdir(), 'ai-buddy-icc-'))
const iccPath = join(iccDirectory, 'source.icc')
await writeFile(iccPath, existing.icc)

const mascot = await sharp(sourcePath, { failOn: 'warning' })
  .resize({
    width: 1024,
    height: 1024,
    fit: 'contain',
    background: { r: 255, g: 255, b: 255, alpha: 0 },
  })
  .ensureAlpha()
  .png()
  .toBuffer()

const rendered = await sharp({
  create: {
    width: 1024,
    height: 1024,
    channels: 4,
    background: { r: 255, g: 255, b: 255, alpha: 1 },
  },
})
  .composite([{ input: mascot }])
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
process.stdout.write(`process-brand-icon: wrote ${outputPath}\n`)
