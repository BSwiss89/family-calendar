import { readFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import sharp from 'sharp'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(root, 'public', 'calendar-icon.svg')
const svg = await readFile(source)
await mkdir(path.join(root, 'public'), { recursive: true })
await Promise.all([
  sharp(svg).resize(180, 180).png().toFile(path.join(root, 'public', 'apple-touch-icon.png')),
  sharp(svg).resize(192, 192).png().toFile(path.join(root, 'public', 'calendar-icon-192.png')),
  sharp(svg).resize(512, 512).png().toFile(path.join(root, 'public', 'calendar-icon-512.png')),
])
console.log('Generated Family Calendar PWA icons (180, 192, 512 pixels)')
