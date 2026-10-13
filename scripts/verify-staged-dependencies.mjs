// Validate the installed production dependency tree and native Sharp operation.
// This checks only the selected folder's installed packages. No server is started.
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

const folder = path.resolve(process.argv[2] ?? '.')
if (process.argv.length > 3) throw new Error('Pass one dependency installation folder only.')
const manifest = path.join(folder, 'package.json')
const lock = path.join(folder, 'package-lock.json')
if (!fs.existsSync(manifest) || !fs.existsSync(lock)) {
  throw new Error('The selected folder must contain both package.json and package-lock.json.')
}

const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'))
const lockData = JSON.parse(fs.readFileSync(lock, 'utf8'))
if (!pkg.dependencies || typeof pkg.dependencies !== 'object') {
  throw new Error('No runtime dependency list found in package.json.')
}
if (!lockData.packages?.['']) {
  throw new Error('Invalid npm lockfile; packages root missing.')
}

const manifestDeps = pkg.dependencies
const lockedDeps = lockData.packages[''].dependencies ?? {}
const packageNames = Object.keys(manifestDeps).sort()
for (const name of packageNames) {
  if (manifestDeps[name] !== lockedDeps[name]) {
    throw new Error('Package manifest and lockfile disagree about ' + name)
  }
}

const fromStage = createRequire(manifest)
for (const name of packageNames) {
  const resolved = fromStage.resolve(name)
  if (!fs.existsSync(resolved)) throw new Error('Missing installed package: ' + name)
}

// Make sure the backend can load its HTTP dependencies and a native image module.
if (typeof fromStage('express') !== 'function') throw new Error('Express did not load correctly.')
if (typeof fromStage('multer') !== 'function') throw new Error('Multer did not load correctly.')
const sharp = fromStage('sharp')
const buffer = await sharp({
  create: { width: 2, height: 2, channels: 3, background: '#ffffff' },
}).png().toBuffer()
if (buffer.length < 8 || buffer.subarray(1, 4).toString('hex') !== '504e47') {
  throw new Error('Sharp native image encoding failed.')
}

console.log('[PASS] Manifest and lockfile runtime dependencies agree.')
console.log('[PASS] All ' + packageNames.length + ' direct runtime packages resolve from installed folder.')
console.log('[PASS] Express and Multer load, and Sharp native image encoding works.')
console.log('RUNTIME DEPENDENCY VERIFICATION PASSED')
