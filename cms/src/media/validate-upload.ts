import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { invalid, mediaMimes } from '../news/primitives'

export const MAX_MEDIA_BYTES = 50 * 1024 * 1024
export const MAX_IMAGE_PIXELS = 80_000_000
export const extensions: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
}

// Container/header checks, not a PDF parser, malware scanner or full codec validator.
function signature(bytes: Buffer, mime: string): boolean {
  const starts = (hex: string) => bytes.subarray(0, hex.length / 2).equals(Buffer.from(hex, 'hex'))
  if (mime === 'image/jpeg') return starts('ffd8ff')
  if (mime === 'image/png') return starts('89504e470d0a1a0a')
  if (mime === 'image/webp') return bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP' && bytes.readUInt32LE(4) + 8 === bytes.length
  if (mime === 'application/pdf') return /^%PDF-[12]\.\d[\r\n]/u.test(bytes.subarray(0, 10).toString('ascii')) &&
    /%%EOF\s*$/u.test(bytes.subarray(-1024).toString('ascii'))
  if (mime === 'video/mp4' || mime === 'video/quicktime') {
    if (bytes.length < 24 || bytes.toString('ascii', 4, 8) !== 'ftyp') return false
    const length = bytes.readUInt32BE(0)
    if (length < 16 || length > bytes.length || length > 4096 || length % 4) return false
    const brand = bytes.toString('ascii', 8, 12)
    return mime === 'video/quicktime' ? brand === 'qt  ' : ['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'M4V '].includes(brand)
  }
  if (mime === 'video/webm') {
    // Read EBML header children, requiring an actual DocType element (not a substring).
    if (!starts('1a45dfa3')) return false
    const vint = (offset: number, keepMarker = false) => {
      const first = bytes[offset]
      if (!first) return null
      let width = 1, mask = 128
      while (!(first & mask) && width <= 8) { width++; mask >>= 1 }
      if (width > 4 || offset + width > bytes.length) return null
      let value = keepMarker ? first : first & (mask - 1)
      for (let i = 1; i < width; i++) value = value * 256 + bytes[offset + i]
      return { value, width }
    }
    const header = vint(4)
    if (!header || header.value > 4096) return false
    const end = 4 + header.width + header.value
    if (end > bytes.length) return false
    let offset = 4 + header.width, webm = false
    while (offset < end) {
      const id = vint(offset, true)
      if (!id) return false
      offset += id.width
      const size = vint(offset)
      if (!size) return false
      offset += size.width
      if (offset + size.value > end) return false
      if (id.value === 0x4282) webm = size.value === 4 && bytes.toString('ascii', offset, offset + 4) === 'webm'
      offset += size.value
    }
    return webm
  }
  return false
}

export async function validateUpload({ bytes, mime, filename }: { bytes: Buffer; mime: string; filename: string }) {
  if (bytes.length > MAX_MEDIA_BYTES) invalid('media_too_large')
  if (!Buffer.isBuffer(bytes) || !bytes.length || !mediaMimes.includes(mime) ||
    typeof filename !== 'string' || !filename || filename.length > 255 || /[\x00-\x1f\x7f/\\]/u.test(filename)) invalid('invalid_media_upload')
  if (!signature(bytes, mime)) invalid('invalid_media_signature')
  if (mime.startsWith('image/')) {
    try {
      const image = sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS, animated: true, failOn: 'warning' })
      const metadata = await image.metadata()
      if (!metadata.width || !metadata.height || metadata.width * metadata.height > MAX_IMAGE_PIXELS) throw new Error()
      // Force decoding of all pages; never save sharp output. Stored SHA is of the original bytes.
      await image.stats()
    } catch { invalid('invalid_media_image') }
  }
  return { mime, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
}
