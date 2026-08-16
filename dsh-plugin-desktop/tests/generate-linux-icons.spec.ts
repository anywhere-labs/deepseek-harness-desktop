import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'

const packageRoot = new URL('../', import.meta.url)
const sourceUrl = new URL('build/app-icon.png', packageRoot)
const generatorUrl = new URL('scripts/generate-linux-icons.mjs', packageRoot)

interface LinuxIconGenerator {
  LINUX_ICON_SIZES: readonly number[]
  generateLinuxIcons: (source?: string, output?: string) => Promise<void>
}

async function loadGenerator(): Promise<LinuxIconGenerator> {
  return await import(generatorUrl.href) as LinuxIconGenerator
}

describe('Linux hicolor icon generator', () => {
  it('writes square Freedesktop PNG sizes without modifying the source', async () => {
    const { generateLinuxIcons, LINUX_ICON_SIZES } = await loadGenerator()
    const sourcePath = fileURLToPath(sourceUrl)
    const before = createHash('sha256').update(readFileSync(sourcePath)).digest('hex')
    const output = mkdtempSync(join(tmpdir(), 'dsh-linux-icons-'))

    try {
      await generateLinuxIcons(sourcePath, output)
      expect(LINUX_ICON_SIZES).toEqual([16, 24, 32, 48, 64, 96, 128, 256, 512])
      for (const size of LINUX_ICON_SIZES) {
        const metadata = await sharp(readFileSync(join(output, `${size}x${size}.png`))).metadata()
        expect(metadata).toEqual(expect.objectContaining({
          format: 'png',
          width: size,
          height: size,
          space: 'srgb',
          channels: 4,
          hasAlpha: true,
        }))
      }
      expect(createHash('sha256').update(readFileSync(sourcePath)).digest('hex')).toBe(before)
    } finally {
      rmSync(output, { recursive: true, force: true })
    }
  })

  it('refuses to write into a directory that contains the source icon', async () => {
    const { generateLinuxIcons } = await loadGenerator()
    const sourcePath = fileURLToPath(sourceUrl)

    await expect(generateLinuxIcons(sourcePath, fileURLToPath(new URL('build', packageRoot))))
      .rejects.toThrow('output directory must not contain the source icon')
  })
})
