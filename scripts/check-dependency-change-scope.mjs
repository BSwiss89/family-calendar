// Read-only scope policy for a future explicitly authorized npm-changing release.
// This file neither updates Git refs nor writes files, packages, services or SQLite.
import { execFileSync } from 'node:child_process'

const sha = /^[a-f0-9]{40}$/
const approved = /^(?:Server\/index\.mjs|src\/.+|public\/.+|\.github\/.+|scripts\/.+|docs\/.+|index\.html|README\.md|\.gitignore|eslint\.config\.js|vite\.config\.ts|tsconfig(?:\.[^/]+)?\.json|package\.json|package-lock\.json)$/

function ensure(ok, message) {
  if (!ok) throw new Error('Dependency cutover scope refused: ' + message)
}

function migrationSection(source) {
  const start = source.indexOf('const database = new DatabaseSync(databasePath)')
  const finish = source.indexOf('app.use(express.json())')
  ensure(start >= 0 && finish > start, 'cannot isolate the known SQLite startup migrations')
  return source.slice(start, finish)
}

function assertChangeScope(files, previousBackend, candidateBackend) {
  ensure(Array.isArray(files) && files.length > 0, 'no changed files')
  ensure(files.every((file) => typeof file === 'string' && approved.test(file)),
    'unexpected file outside approved release paths')
  ensure(files.includes('package.json') && files.includes('package-lock.json'),
    'explicit npm cutover requires both package.json and package-lock.json to change')
  if (files.includes('Server/index.mjs')) {
    ensure(typeof previousBackend === 'string' && typeof candidateBackend === 'string',
      'both old and new backend versions are required')
    ensure(migrationSection(previousBackend) === migrationSection(candidateBackend),
      'known database startup migrations changed')
  }
  return true
}

function expectRejected(action, label) {
  let rejected = false
  try { action() } catch { rejected = true }
  ensure(rejected, 'unsafe fixture accepted: ' + label)
  console.log('[PASS] Rejected ' + label)
}

function selfTest() {
  const oldBackend = [
    'const database = new DatabaseSync(databasePath)',
    'database.exec("PRAGMA foreign_keys = ON")',
    'app.use(express.json())',
    '// old unrelated API behavior',
  ].join('\n')
  const safeBackend = oldBackend.replace('// old unrelated API behavior', '// new unrelated API behavior')
  const unsafeBackend = oldBackend.replace('PRAGMA foreign_keys = ON', 'PRAGMA foreign_keys = OFF')
  const standard = ['package.json', 'package-lock.json', 'src/App.tsx']
  assertChangeScope(standard)
  assertChangeScope(['package.json', 'package-lock.json', 'Server/index.mjs'], oldBackend, safeBackend)
  console.log('[PASS] Approved explicit npm cutover and unchanged database migration sections.')
  expectRejected(() => assertChangeScope(['package-lock.json']), 'unpaired package lock change')
  expectRejected(() => assertChangeScope(['package.json']), 'unpaired package manifest change')
  expectRejected(() => assertChangeScope([]), 'empty release')
  expectRejected(() => assertChangeScope([...standard, 'Server/data/calendar.db']), 'household SQLite changes')
  expectRejected(() => assertChangeScope([...standard, '.npmrc']), 'unreviewed npm configuration')
  expectRejected(() => assertChangeScope([...standard, 'Server/index.mjs'], oldBackend, unsafeBackend),
    'changed backend database startup migrations')
  expectRejected(() => assertChangeScope([...standard, 'Server/index.mjs'], 'missing migrations', safeBackend),
    'backend migration section cannot be isolated')
  console.log('DEPENDENCY CUTOVER SCOPE SAFETY FIXTURES PASSED')
}

function git(folder, ...args) {
  return execFileSync('git', ['-C', folder, ...args], {
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
  })
}

function check(live, test) {
  ensure(live && test && live !== test, 'two independent Git folders are required')
  const from = git(live, 'rev-parse', 'HEAD').trim()
  const to = git(test, 'rev-parse', 'HEAD').trim()
  ensure(sha.test(from) && sha.test(to) && from !== to,
    'release requires two distinct full Git commit SHAs')
  const ancestor = execFileSync('git', ['-C', test, 'merge-base', from, to], {
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
  }).trim()
  ensure(sha.test(ancestor) && ancestor === from, 'existing live code must be an ancestor of candidate')
  const changed = git(test, 'diff', '--name-only', '-z', from + '..' + to)
    .split('\0').filter(Boolean)
  const backendChanged = changed.includes('Server/index.mjs')
  const previous = backendChanged ? git(live, 'show', from + ':Server/index.mjs') : null
  const candidate = backendChanged ? git(test, 'show', to + ':Server/index.mjs') : null
  assertChangeScope(changed, previous, candidate)
  console.log('[PASS] Only permitted release files changed; both npm manifest and lockfile are included.')
  console.log('[PASS] Backend SQLite startup migrations unchanged if backend changed.')
  console.log('[PASS] Previous production Git commit is an ancestor of the tested candidate.')
  console.log('READ-ONLY DEPENDENCY CHANGE SCOPE PASSED')
  console.log('Old commit: ' + from)
  console.log('Candidate commit: ' + to)
}

if (process.argv.length === 3 && process.argv[2] === '--self-test') {
  selfTest()
} else if (process.argv.length === 5 && process.argv[2] === '--check') {
  check(process.argv[3], process.argv[4])
} else {
  throw new Error('Usage: --self-test or --check <live-repository> <test-repository>')
}
