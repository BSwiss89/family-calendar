// Recheck a preserved npm candidate against the exact approved GitHub commit.
// Never moves dependencies, stops services, or modifies a household database.
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const commitPattern = /^[a-f0-9]{40}$/
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex').toUpperCase()
const requireSafe = (condition, message) => {
  if (!condition) throw new Error(message)
}
const read = (file) => fs.readFileSync(file)
const assertHash = (actual, expected, label) => requireSafe(
  actual === expected, label + ' does not match the approved candidate.',
)

function inspectEvidence({ candidate, commit, expectedManifest, expectedLock }) {
  requireSafe(commitPattern.test(commit), 'Expected a full 40-character Git commit SHA.')
  requireSafe(path.basename(candidate) === commit, 'Candidate folder does not match commit.')
  requireSafe(fs.existsSync(candidate) && fs.statSync(candidate).isDirectory(), 'Candidate directory missing.')
  requireSafe(!fs.lstatSync(candidate).isSymbolicLink(), 'Candidate directory is a link or junction.')
  const metadataFile = path.join(candidate, 'candidate.json')
  const manifest = path.join(candidate, 'package.json')
  const lockfile = path.join(candidate, 'package-lock.json')
  for (const file of [metadataFile, manifest, lockfile]) {
    requireSafe(fs.existsSync(file) && fs.statSync(file).isFile(), 'Missing candidate file: ' + path.basename(file))
    requireSafe(!fs.lstatSync(file).isSymbolicLink(), 'Unexpected linked candidate file: ' + path.basename(file))
  }
  // Windows PowerShell 5.1's Set-Content -Encoding UTF8 prepends EF BB BF.
  // Accept that standard BOM for previously preserved candidates, but do not
  // silently strip any other unexpected metadata bytes.
  const metadataBytes = read(metadataFile)
  const hasUtf8Bom = metadataBytes.length >= 3 &&
    metadataBytes[0] === 0xef && metadataBytes[1] === 0xbb && metadataBytes[2] === 0xbf
  const metadataJson = metadataBytes.subarray(hasUtf8Bom ? 3 : 0).toString('utf8')
  const meta = JSON.parse(metadataJson)
  requireSafe(meta.approvedCommit === commit, 'Metadata points to a different approved commit.')
  requireSafe(meta.status === 'prepared-not-applied', 'Candidate is not marked as prepared and unapplied.')
  requireSafe(typeof meta.createdAt === 'string' && !Number.isNaN(Date.parse(meta.createdAt)), 'Candidate creation date is invalid.')
  const manifestHash = digest(read(manifest))
  const lockHash = digest(read(lockfile))
  assertHash(manifestHash, meta.manifestSha256, 'Manifest metadata SHA-256')
  assertHash(lockHash, meta.lockfileSha256, 'Lockfile metadata SHA-256')
  assertHash(manifestHash, digest(expectedManifest), 'Manifest source SHA-256')
  assertHash(lockHash, digest(expectedLock), 'Lockfile source SHA-256')
  requireSafe(fs.existsSync(path.join(candidate, 'node_modules')), 'Candidate node_modules not installed.')
  return { manifestHash, lockHash }
}

function expectReject(callback, label) {
  let rejected = false
  try { callback() } catch { rejected = true }
  requireSafe(rejected, 'Invalid candidate accepted: ' + label)
  console.log('[PASS] Rejected ' + label)
}

function syntheticTests() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-candidate-validator-'))
  const commit = 'a'.repeat(40)
  const folder = path.join(temp, commit)
  const manifest = Buffer.from('{"name":"test","dependencies":{}}\n')
  const lock = Buffer.from('{"lockfileVersion":3,"packages":{"":{}}}\n')
  try {
    fs.mkdirSync(folder)
    fs.mkdirSync(path.join(folder, 'node_modules'))
    fs.writeFileSync(path.join(folder, 'package.json'), manifest)
    fs.writeFileSync(path.join(folder, 'package-lock.json'), lock)
    const meta = {
      approvedCommit: commit,
      manifestSha256: digest(manifest),
      lockfileSha256: digest(lock),
      createdAt: new Date().toISOString(),
      status: 'prepared-not-applied',
    }
    const metaFile = path.join(folder, 'candidate.json')
    const save = () => fs.writeFileSync(metaFile, JSON.stringify(meta))
    const check = () => inspectEvidence({ candidate: folder, commit, expectedManifest: manifest, expectedLock: lock })
    save()
    check()
    console.log('[PASS] Authentic commit-bound candidate metadata accepted.')
    // Exercise actual EF BB BF bytes emitted by Windows PowerShell 5.1.
    fs.writeFileSync(metaFile, Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(JSON.stringify(meta)),
    ]))
    check()
    console.log('[PASS] PowerShell UTF-8 BOM metadata accepted without changing hashes.')
    save()
    meta.approvedCommit = 'b'.repeat(40)
    save()
    expectReject(check, 'metadata referencing another GitHub commit')
    meta.approvedCommit = commit
    meta.manifestSha256 = '0'.repeat(64)
    save()
    expectReject(check, 'modified manifest hash in metadata')
    meta.manifestSha256 = digest(manifest)
    save()
    fs.appendFileSync(path.join(folder, 'package-lock.json'), 'tampered')
    expectReject(check, 'altered package lockfile')
    fs.writeFileSync(path.join(folder, 'package-lock.json'), lock)
    fs.appendFileSync(path.join(folder, 'package.json'), 'tampered')
    expectReject(check, 'altered package manifest')
    fs.writeFileSync(path.join(folder, 'package.json'), manifest)
    meta.status = 'already-applied'
    save()
    expectReject(check, 'replayed or already-applied candidate')
    meta.status = 'prepared-not-applied'
    save()
    fs.renameSync(path.join(folder, 'node_modules'), path.join(folder, 'missing-modules'))
    expectReject(check, 'candidate missing installed modules')
    console.log('COMMIT-PINNED CANDIDATE SAFETY FIXTURES PASSED')
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
}

if (process.argv.slice(2).includes('--self-test')) {
  requireSafe(process.argv.length === 3, 'Self-test has no extra arguments.')
  syntheticTests()
} else {
  requireSafe(process.argv.length === 4 && process.argv[2] === '--commit', 'Usage: node scripts/verify-commit-dependencies.mjs --commit <full SHA>')
  const commit = process.argv[3]
  requireSafe(commitPattern.test(commit), 'Full 40-character commit required.')
  const home = process.env.USERPROFILE ?? os.homedir()
  const test = path.join(home, 'Projects', 'family-calendar-test')
  const base = path.join(home, 'Projects', 'family-calendar-release-backups', 'dependency-candidates')
  const candidate = path.join(base, commit)
  const git = (...args) => execFileSync('git', ['-C', test, ...args], { encoding: 'utf8', timeout: 30000 }).trim()
  requireSafe(git('rev-parse', 'HEAD') === commit, 'Test repository no longer matches the candidate commit.')
  const mainRef = git('ls-remote', 'origin', 'refs/heads/main').split(/\s+/)
  requireSafe(mainRef.length === 2 && mainRef[0] === commit && mainRef[1] === 'refs/heads/main',
    'GitHub main no longer matches this candidate; refuse reuse.')
  const manifest = read(path.join(test, 'package.json'))
  const lockfile = read(path.join(test, 'package-lock.json'))
  const hashes = inspectEvidence({ candidate, commit, expectedManifest: manifest, expectedLock: lockfile })
  const checker = path.join(test, 'scripts', 'verify-staged-dependencies.mjs')
  const result = spawnSync(process.execPath, [checker, candidate], { encoding: 'utf8', timeout: 30000 })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  requireSafe(result.status === 0, 'Preserved candidate runtime dependency verification failed.')
  console.log('[PASS] Candidate is bound to current approved GitHub main ' + commit.slice(0, 7))
  console.log('[PASS] Preserved manifest matches approved source: ' + hashes.manifestHash)
  console.log('[PASS] Preserved lockfile matches approved source: ' + hashes.lockHash)
  console.log('PRESERVED COMMIT DEPENDENCY CANDIDATE VERIFIED')
}
