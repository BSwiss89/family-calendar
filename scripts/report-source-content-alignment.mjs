// Read-only source-content comparison of two exact Git commits.
// Unlike branch-history diffs, matching Git blob IDs prove identical file bytes.
// Does not fetch, merge, deploy, access running processes, or inspect databases.
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const SHA = /^[a-f0-9]{40}$/i
const COUNT_KEYS = ['identical', 'different', 'live_only', 'test_only']

export function isAppSourcePath(file) {
  return typeof file === 'string' && (file.startsWith('src/') || file.startsWith('Server/'))
}

export function parseTreeEntries(output) {
  if (typeof output !== 'string') throw new TypeError('Git tree output must be text')
  const files = new Map()
  for (const row of output.split('\0')) {
    if (!row) continue
    const match = /^([0-7]{6}) blob ([a-f0-9]{40,64})\t(.+)$/s.exec(row)
    if (!match) throw new Error('Unexpected git ls-tree entry; refusing partial audit')
    const [, , oid, file] = match
    if (!isAppSourcePath(file)) continue
    if (files.has(file)) throw new Error('Duplicate path in Git tree: ' + file)
    files.set(file, oid)
  }
  return files
}

export function compareSourceTrees(live, test) {
  if (!(live instanceof Map) || !(test instanceof Map)) {
    throw new TypeError('Both source trees must be Maps of paths to Git blob IDs')
  }
  const files = []
  const counts = Object.fromEntries(COUNT_KEYS.map(key => [key, 0]))
  const allPaths = [...new Set([...live.keys(), ...test.keys()])].filter(isAppSourcePath).sort()
  for (const file of allPaths) {
    const inLive = live.has(file)
    const inTest = test.has(file)
    const status = inLive && inTest
      ? (live.get(file) === test.get(file) ? 'identical' : 'different')
      : (inLive ? 'live_only' : 'test_only')
    counts[status] += 1
    files.push({ path: file, status, liveBlob: inLive ? live.get(file) : null, testBlob: inTest ? test.get(file) : null })
  }
  return { counts, totalPaths: files.length, files }
}

function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  if (result.error || result.status !== 0) {
    throw new Error('Git command failed (' + args[0] + '): ' + (result.error?.message || result.stderr || 'exit ' + result.status).trim())
  }
  return result.stdout
}

function commitTree(sha) {
  if (!SHA.test(sha)) throw new Error('Use an exact 40-character commit SHA, not a moving branch')
  if (git(['cat-file', '-t', sha]).trim() !== 'commit') throw new Error('Reference is not a Git commit: ' + sha)
  return parseTreeEntries(git(['ls-tree', '-r', '-z', sha, '--', 'src', 'Server']))
}

function main(args) {
  const json = args.includes('--json')
  const positional = args.filter(arg => arg !== '--json')
  if (positional.length !== 2 || !positional.every(arg => SHA.test(arg))) {
    throw new Error('Usage: node scripts/report-source-content-alignment.mjs LIVE_SHA TEST_SHA [--json]')
  }
  const [liveSha, testSha] = positional
  const report = compareSourceTrees(commitTree(liveSha), commitTree(testSha))
  if (report.totalPaths === 0) throw new Error('No source paths found; cannot make a parity claim')
  if (json) {
    process.stdout.write(JSON.stringify({ liveSha, testSha, ...report }, null, 2) + '\n')
    return
  }
  console.log('Source-content alignment (read only)')
  console.log('LIVE ' + liveSha)
  console.log('TEST ' + testSha)
  console.log('Paths: ' + report.totalPaths + '; identical=' + report.counts.identical +
    '; different=' + report.counts.different + '; LIVE-only=' + report.counts.live_only +
    '; TEST-only=' + report.counts.test_only)
  const different = report.files.filter(item => item.status !== 'identical')
  for (const item of different.slice(0, 60)) {
    console.log(item.status.padEnd(10) + ' ' + item.path)
  }
  if (different.length > 60) console.log('... ' + (different.length - 60) + ' more; use --json for full inventory')
  console.log('Identical blobs establish exact file-content equality only; not functional parity or release approval.')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(process.argv.slice(2)) }
  catch (error) { console.error(error.message); process.exitCode = 2 }
}
