import sharp from 'sharp'
import { MarketMediaError, type RawMarketImage } from './restricted-image.js'

const OUTPUT_SIZE = 128
const MAX_INPUT_PIXELS = 16 * 1024 * 1024
const ALLOWED_FORMATS = new Set(['jpeg', 'png', 'webp'])
const FORMAT_BY_CONTENT_TYPE: Record<RawMarketImage['contentType'], string> = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
}

/** Decode an untrusted image and emit a fixed-size metadata-free PNG. */
export async function normalizeMarketImage(image: RawMarketImage): Promise<Buffer> {
  try {
    const decoder = sharp(image.body, {
      animated: false,
      failOn: 'warning',
      limitInputPixels: MAX_INPUT_PIXELS,
      sequentialRead: true,
    })
    const metadata = await decoder.metadata()
    if (
      metadata.format === undefined
      || !ALLOWED_FORMATS.has(metadata.format)
      || metadata.format !== FORMAT_BY_CONTENT_TYPE[image.contentType]
      || metadata.width === undefined
      || metadata.height === undefined
      || metadata.width <= 0
      || metadata.height <= 0
      || metadata.width * metadata.height > MAX_INPUT_PIXELS
      || (metadata.pages ?? 1) !== 1
    ) {
      throw new MarketMediaError('invalid-image')
    }
    return await decoder
      .rotate()
      .resize(OUTPUT_SIZE, OUTPUT_SIZE, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png({ compressionLevel: 9 })
      .toBuffer()
  } catch (cause) {
    if (cause instanceof MarketMediaError) throw cause
    throw new MarketMediaError('invalid-image')
  }
}
