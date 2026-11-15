// On-demand, authenticated recipe photo import (not a generic URL proxy).
// Called only after Save Recipe is explicitly pressed. No SQLite writes here.
import sharp from 'sharp'

const MAX_SOURCE_BYTES = 3 * 1024 * 1024
const MAX_PIXELS = 20_000_000
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024

export function normalizeTheMealDbImageUrl(value) {
  if (typeof value !== 'string' || value.length > 300 ||
    !/^https:\/\/(?:www\.)?themealdb\.com\/images\/media\/meals\/[a-z0-9_-]+\.(?:jpg|jpeg|png|webp)$/i.test(value)) {
    return null
  }
  const url = new URL(value)
  if (url.username || url.password || url.port || url.search || url.hash) return null
  return url.toString()
}

export async function fetchVerifiedRecipeImage(value, { fetchImpl = fetch } = {}) {
  const url = normalizeTheMealDbImageUrl(value)
  if (!url) throw new TypeError('Unapproved recipe photo source.')
  const response = await fetchImpl(url, {
    method: 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(8_000),
    headers: { Accept: 'image/jpeg, image/png, image/webp' },
  })
  if (!response.ok) throw new Error('Recipe photo source is unavailable.')
  const type = (response.headers?.get?.('content-type') ?? '').split(';')[0].trim().toLowerCase()
  if (!['image/jpeg','image/png','image/webp'].includes(type)) {
    throw new Error('Recipe photo is not a supported image.')
  }
  const declared = response.headers?.get?.('content-length')
  if (declared != null && (!/^\d+$/.test(declared) || Number(declared) > MAX_SOURCE_BYTES)) {
    throw new Error('Recipe photo is too large.')
  }
  if (!response.body) throw new Error('Recipe photo has no data.')
  const chunks = []
  let total = 0
  for await (const chunk of response.body) {
    const next = Buffer.from(chunk)
    total += next.length
    if (total > MAX_SOURCE_BYTES) {
      await response.body.cancel?.().catch?.(() => {})
      throw new Error('Recipe photo is too large.')
    }
    chunks.push(next)
  }
  if (total === 0) throw new Error('Recipe photo is empty.')
  const input = Buffer.concat(chunks)
  const transformer = sharp(input, { limitInputPixels: MAX_PIXELS, failOn: 'error' })
  const metadata = await transformer.metadata()
  if (!['jpeg','png','webp'].includes(metadata.format) ||
    !metadata.width || !metadata.height ||
    metadata.width * metadata.height > MAX_PIXELS) {
    throw new Error('Recipe photo dimensions or format are invalid.')
  }
  const output = await sharp(input, { limitInputPixels: MAX_PIXELS })
    .rotate()
    .resize({ width: 1000, height: 1000, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80 })
    .toBuffer()
  if (output.length === 0 || output.length > MAX_OUTPUT_BYTES) {
    throw new Error('Converted recipe photo is too large.')
  }
  return output
}
