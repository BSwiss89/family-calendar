// Exercise the ACTUAL Calendar backend with a disposable npm production tree.
// No production files, ports, tasks, uploads or databases are modified.
// --self-test: CI/local test using a fresh npm install and synthetic SQLite seed.
// --commit SHA: verify current approved GitHub candidate, copy its installed npm
//              packages and use a read-only snapshot of the TEST database.
import { spawn, spawnSync } from 'node:child_process'
import { DatabaseSync, backup } from 'node:sqlite'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const checkout = path.resolve(scriptDir, '..')
const home = process.env.USERPROFILE ?? os.homedir()
const live = path.join(home, 'Projects', 'family-calendar')
const test = path.join(home, 'Projects', 'family-calendar-test')
const candidates = path.join(home, 'Projects', 'family-calendar-release-backups', 'dependency-candidates')
const fullSha = /^[a-f0-9]{40}$/
const forbiddenPorts = new Set([3001, 13001, 13002, 13003, 11434])
const argv = process.argv.slice(2)
const fixtureMode = argv.length === 1 && argv[0] === '--self-test'
const commitMode = argv.length === 2 && argv[0] === '--commit' && fullSha.test(argv[1])

function requireSafe(ok, message) {
  if (!ok) throw new Error('Isolated candidate backend refused: ' + message)
}

function runNode(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: checkout,
    stdio: 'inherit',
    timeout: 45000,
    windowsHide: true,
  })
  requireSafe(result.status === 0, 'approved candidate verifier failed')
}

function installTempPackages(folder) {
  const win = process.platform === 'win32'
  const command = win ? 'cmd.exe' : 'npm'
  const args = win
    ? ['/d', '/s', '/c', 'npm ci --omit=dev --no-audit --no-fund']
    : ['ci', '--omit=dev', '--no-audit', '--no-fund']
  const result = spawnSync(command, args, {
    cwd: folder,
    stdio: 'inherit',
    timeout: 120000,
    windowsHide: true,
  })
  requireSafe(result.status === 0, 'disposable npm ci failed')
}

function seedSyntheticSqlite(dbPath) {
  const db = new DatabaseSync(dbPath)
  try {
    // Startup migrations create all other tables, but the current application
    // expects this legacy mapping table to exist before a migration INSERT.
    db.exec('CREATE TABLE event_people (event_id INTEGER NOT NULL, person_id INTEGER NOT NULL, PRIMARY KEY (event_id, person_id)) STRICT')
  } finally {
    db.close()
  }
}

async function snapshotTestDb(destination) {
  const sourcePath = path.join(test, 'Server', 'data', 'calendar.db')
  const productionDb = path.join(live, 'Server', 'data', 'calendar.db')
  requireSafe(fs.existsSync(sourcePath) && fs.existsSync(productionDb),
    'separate TEST and LIVE SQLite files must both exist')
  const sourceReal = fs.realpathSync(sourcePath).toLowerCase()
  const liveReal = fs.realpathSync(productionDb).toLowerCase()
  requireSafe(sourceReal !== liveReal, 'TEST database resolves to live SQLite data')
  const source = new DatabaseSync(sourcePath, { readOnly: true })
  try {
    await backup(source, destination)
  } finally {
    source.close()
  }
  requireSafe(fs.existsSync(destination) && fs.statSync(destination).size > 0,
    'read-only TEST snapshot was empty')
}

async function unusedLoopbackPort() {
  const listener = createServer()
  const port = await new Promise((resolve, reject) => {
    listener.once('error', reject)
    listener.listen(0, '127.0.0.1', () => resolve(listener.address().port))
  })
  await new Promise(resolve => listener.close(resolve))
  requireSafe(Number.isInteger(port) && !forbiddenPorts.has(port),
    'OS-assigned port overlaps a protected local service')
  return port
}

async function stopOwnProcess(child) {
  if (!child) return
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill()
  const awaitExit = async (milliseconds) => {
    if (child.exitCode !== null || child.signalCode !== null) return
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, milliseconds)),
    ])
  }
  await awaitExit(5000)
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
    await awaitExit(3000)
  }
  requireSafe(child.exitCode !== null || child.signalCode !== null,
    'temporary Node process did not exit; keep temp folder for investigation')
}

async function exerciseBackend(folder, port) {
  const entry = path.join(folder, 'Server', 'index.mjs')
  const expectedHtml = fs.readFileSync(path.join(folder, 'dist', 'index.html'), 'utf8').trim()
  const child = spawn(process.execPath, [entry], {
    cwd: folder,
    windowsHide: true,
    env: {
      ...process.env,
      FAMILY_CALENDAR_HOST: '127.0.0.1',
      FAMILY_CALENDAR_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', bytes => { log = (log + bytes.toString()).slice(-3500) })
  }
  try {
    let healthy = false
    for (let i = 0; i < 60; i++) {
      if (child.exitCode !== null || child.signalCode !== null) break
      try {
        const r = await fetch('http://127.0.0.1:' + port + '/api/health', {
          signal: AbortSignal.timeout(900),
        })
        if (r.ok && (await r.json()).status === 'ok') {
          healthy = true
          break
        }
      } catch { /* Loopback server is starting. */ }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    requireSafe(healthy && child.exitCode === null && child.signalCode === null,
      'real backend never reached healthy state. ' + log.slice(-1400))

    const base = 'http://127.0.0.1:' + port
    const page = await fetch(base + '/', { signal: AbortSignal.timeout(5000) })
    requireSafe(page.status === 200 && (await page.text()).trim() === expectedHtml,
      'real backend did not serve the expected isolated frontend HTML')
    const people = await fetch(base + '/api/people', { signal: AbortSignal.timeout(5000) })
    requireSafe(people.ok && Array.isArray(await people.json()),
      'real backend failed the isolated people API')
    const lists = await fetch(base + '/api/lists', { signal: AbortSignal.timeout(5000) })
    requireSafe(lists.ok && Array.isArray(await lists.json()),
      'real backend failed the isolated lists API')
    console.log('[PASS] Actual Calendar Node backend booted using the selected npm production tree.')
    console.log('[PASS] Isolated HTTP health, expected frontend, people and lists endpoints.')
  } finally {
    await stopOwnProcess(child)
    console.log('[PASS] Isolated Node process stopped without touching the production service.')
  }
}

async function main() {
  requireSafe(fixtureMode || commitMode,
    'usage: --self-test or --commit <full approved 40-character Git SHA>')
  const source = fixtureMode ? checkout : test
  if (commitMode) {
    requireSafe(process.platform === 'win32' && process.env.USERPROFILE?.toLowerCase() === 'c:\\users\\bobby',
      'approved candidate check must run as authorized laptop user')
    requireSafe(path.resolve(checkout).toLowerCase() === path.resolve(test).toLowerCase(),
      'approved candidate script must run from the TEST checkout')
    runNode([path.join(scriptDir, 'verify-commit-dependencies.mjs'), '--commit', argv[1]])
  }
  requireSafe(fs.existsSync(path.join(source, 'Server', 'index.mjs')),
    'actual Calendar backend source is missing')
  requireSafe(fs.existsSync(path.join(source, 'dist', 'index.html')),
    'built candidate frontend is missing')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-backend-candidate-'))
  const app = path.join(root, 'disposable-app')
  let shouldKeep = false
  try {
    fs.mkdirSync(path.join(app, 'Server', 'data'), { recursive: true })
    fs.mkdirSync(path.join(app, 'dist'), { recursive: true })
    for (const name of ['package.json', 'package-lock.json']) {
      fs.copyFileSync(path.join(source, name), path.join(app, name))
    }
    fs.copyFileSync(path.join(source, 'Server', 'index.mjs'), path.join(app, 'Server', 'index.mjs'))
    fs.copyFileSync(path.join(source, 'dist', 'index.html'), path.join(app, 'dist', 'index.html'))

    if (commitMode) {
      const candidate = path.join(candidates, argv[1])
      requireSafe(fs.existsSync(path.join(candidate, 'node_modules')),
        'preserved approved candidate has no npm modules')
      fs.cpSync(path.join(candidate, 'node_modules'), path.join(app, 'node_modules'), {
        recursive: true, force: false, errorOnExist: true,
      })
      await snapshotTestDb(path.join(app, 'Server', 'data', 'calendar.db'))
      console.log('[PASS] Preserved approved packages copied; independent TEST SQLite snapshot made.')
    } else {
      seedSyntheticSqlite(path.join(app, 'Server', 'data', 'calendar.db'))
      installTempPackages(app)
      console.log('[PASS] Fresh production npm install and synthetic disposable SQLite database.')
    }

    runNode([path.join(scriptDir, 'verify-staged-dependencies.mjs'), app])
    const port = await unusedLoopbackPort()
    await exerciseBackend(app, port)
    console.log('')
    console.log(fixtureMode
      ? 'REAL CALENDAR BACKEND WITH ISOLATED NPM FIXTURE PASSED'
      : 'VERIFIED PRESERVED CANDIDATE REAL BACKEND SMOKE TEST PASSED')
    console.log('No live files, npm packages, data, listeners, or scheduled tasks were changed.')
  } catch (error) {
    if (error.message.includes('keep temp folder for investigation')) shouldKeep = true
    throw error
  } finally {
    if (shouldKeep) {
      console.error('Temporary folder retained for investigation: ' + root)
    } else {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
}

await main().catch(error => {
  console.error('ISOLATED REAL BACKEND PACKAGE SMOKE TEST FAILED: ' + error.message)
  process.exitCode = 1
})
