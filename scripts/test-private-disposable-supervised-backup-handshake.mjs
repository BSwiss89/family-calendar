// Actual child-process shutdown & loopback probes, but ONLY temp SQLite,
// fake accounts, and isolated ports. No installed LIVE/TEST site or scheduler.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { provisionEmptyHousehold } from '../Server/household-storage.mjs'
import {
  createHouseholdMembershipTables, registerHousehold, grantHouseholdMembership,
} from '../Server/household-memberships.mjs'
import { setFamilyAccount } from '../Server/family-auth.mjs'
import { createEventShareTables } from '../Server/event-only-shares.mjs'
import { createEventShareSyncJournal } from '../Server/event-share-sync-journal.mjs'
import { installPrivateEventIdentity } from '../Server/private-event-identity.mjs'
import { createReviewedWindowsSupervisorOwnership }
  from '../Server/private-reviewed-windows-supervisor-ownership.mjs'
import { captureAfterDisposableReviewedShutdown }
  from '../Server/private-disposable-supervised-backup-handshake.mjs'
import { verifyOfflinePrivateRestoreSet } from '../Server/private-restore-preflight.mjs'

const primary = 'home-calendar'
const invited = 'family-' + 'a'.repeat(24)
const pwd = 'Fake-Only-Synthetic-Strong-Password-123!'

async function reservePort(used) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const server = net.createServer()
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const port = server.address().port
    await new Promise(resolve => server.close(resolve))
    if (port >= 1024 && !used.has(port) &&
        !new Set([3001, 13001, 13002, 13003, 11434, 443, 8443]).has(port)) {
      used.add(port)
      return port
    }
  }
  throw new Error('No suitable synthetic loopback test port.')
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  await new Promise((resolve, reject) => {
    let done = false
    const timeout = setTimeout(() => finish(new Error('Synthetic child did not stop.')), 15000)
    function finish(error) {
      if (done) return
      done = true
      clearTimeout(timeout)
      child.off('exit', exited)
      child.off('error', errored)
      if (error) reject(error)
      else resolve()
    }
    const exited = () => finish()
    const errored = e => finish(e)
    child.once('exit', exited)
    child.once('error', errored)
    if (!child.kill()) finish(new Error('Could not stop synthetic child.'))
  })
}

async function fixture(t) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-quiesced-backup-'))
  const children = []
  const sockets = []
  t.after(async () => {
    for (const server of sockets) {
      if (server.listening) await new Promise(resolve => server.close(resolve))
    }
    for (const child of children) await stopChild(child)
    fs.rmSync(work, { recursive: true, force: true })
  })
  const serverDirectory = path.join(work, 'checkout', 'Server')
  const sourceRoot = path.join(work, 'already-offline')
  const destinationRoot = path.join(work, 'independently-verified-backup')
  const stateDirectory = path.join(work, 'supervisor-state')
  fs.mkdirSync(serverDirectory, { recursive: true })
  fs.mkdirSync(sourceRoot)
  fs.mkdirSync(path.join(sourceRoot, 'central'))
  fs.mkdirSync(stateDirectory)
  const ids = [primary, invited]
  for (const [i, id] of ids.entries()) {
    const home = provisionEmptyHousehold({ serverDirectory, storageRoot: sourceRoot,
      householdId: id })
    const db = new DatabaseSync(home.databasePath)
    try {
      db.exec('CREATE TABLE events(id INTEGER PRIMARY KEY, title TEXT, date TEXT, end_date TEXT, time TEXT, end_time TEXT, repeat_unit TEXT) STRICT')
      db.exec('CREATE TABLE lists(id INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT')
      installPrivateEventIdentity(db)
      db.prepare('INSERT INTO events(title,date) VALUES(?,?)')
        .run('Private calendar event ' + i, '2027-01-15')
      db.prepare('INSERT INTO lists(name) VALUES(?)').run('Groceries ' + i)
    } finally { db.close() }
    fs.writeFileSync(path.join(home.uploadFolder, 'photo.bin'), Buffer.from([17, 0, i + 1]))
  }
  const central = new DatabaseSync(path.join(sourceRoot, 'central', 'identity.db'))
  try {
    createHouseholdMembershipTables(central)
    createEventShareTables(central)
    createEventShareSyncJournal(central)
    for (const [i, id] of ids.entries()) {
      const username = 'fake-owner-' + i
      setFamilyAccount(central, username, 'Synthetic Owner ' + i, pwd)
      registerHousehold(central, { householdId: id, displayName: 'Family ' + i })
      const userId = central.prepare('SELECT id FROM family_users WHERE username=?')
        .get(username).id
      grantHouseholdMembership(central, {
        serverVerifiedUserId: userId, householdId: id, role: 'owner',
      })
    }
  } finally { central.close() }
  const plan = Object.freeze({
    kind: 'reviewed-private-test-startup-plan-v1', primaryHouseholdId: primary,
    householdIds: Object.freeze([...ids]), householdCount: ids.length,
    planVerifiedReadOnly: true, deploymentAuthorized: false,
    taskSchedulerInstalled: false,
  })
  const supervisor = createReviewedWindowsSupervisorOwnership({plan,stateDirectory})
  const backends = []
  for (const householdId of ids) {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    })
    children.push(child)
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
    supervisor.captureBackend({householdId,child})
    backends.push({householdId,child})
  }
  supervisor.markHealthy()
  const used=new Set()
  const gatewayPort=await reservePort(used)
  const backendPorts={}
  for(const id of ids) backendPorts[id]=await reservePort(used)
  return {
    work, ids, plan, supervisor, backends, children, sockets,
    gatewayPort, backendPorts, gatewayClosed:true,
    serverDirectory, sourceRoot, destinationRoot, stateDirectory,
  }
}

function options(f) {
  const { plan, supervisor, backends, backendPorts, gatewayPort, gatewayClosed,
    serverDirectory, sourceRoot, destinationRoot } = f
  return { plan, supervisor, backends, backendPorts, gatewayPort, gatewayClosed,
    serverDirectory, sourceRoot, destinationRoot }
}

async function gracefullyStop(f) {
  f.supervisor.beginGracefulShutdown()
  for (const backend of f.backends) await stopChild(backend.child)
  assert.equal(f.supervisor.snapshot().allCapturedChildrenExited, true)
}

test('real child exits and closed loopback allow a verified two-family offline backup while owner lock remains held', async t => {
  const f=await fixture(t)
  await gracefullyStop(f)
  const result=await captureAfterDisposableReviewedShutdown(options(f))
  assert.equal(result.capturedOsChildrenExited,true)
  assert.equal(result.nominatedLoopbackPortsClosed,true)
  assert.equal(result.supervisorInstanceHeldDuringCopy,true)
  assert.equal(result.allSystemWritersFenced,false)
  assert.equal(result.productionBackupAuthorized,false)
  assert.deepEqual(result.attestation.households,[invited,primary].sort())
  assert.equal(f.supervisor.snapshot().phase,'stopping')
  assert.equal(fs.existsSync(path.join(f.stateDirectory,
    '.family-calendar-reviewed-supervisor-instance.lock')),true)
  assert.deepEqual(verifyOfflinePrivateRestoreSet({
    serverDirectory:f.serverDirectory,restoreRoot:f.destinationRoot,
  },result.attestation),{ok:true,households:2,files:result.fileCount})
  assert.equal(f.supervisor.finishGracefulShutdown().instanceReleasedByOwner,true)
})

test('running even one captured writer refuses backup without source writes',async t=>{
  const f=await fixture(t)
  f.supervisor.beginGracefulShutdown()
  await stopChild(f.backends[0].child)
  await assert.rejects(captureAfterDisposableReviewedShutdown(options(f)),
    /every expected captured OS child must already have exited/)
  assert.equal(fs.existsSync(f.destinationRoot),false)
  assert.equal(f.supervisor.snapshot().phase,'stopping')
})

test('open gateway loopback listener blocks backup and holds exclusive instance for review',async t=>{
  const f=await fixture(t)
  await gracefullyStop(f)
  const listener=net.createServer(socket=>socket.end())
  f.sockets.push(listener)
  await new Promise((resolve,reject)=>{
    listener.once('error',reject)
    listener.listen(f.gatewayPort,'127.0.0.1',resolve)
  })
  await assert.rejects(captureAfterDisposableReviewedShutdown(options(f)),
    /listener still accepts connections/)
  assert.equal(fs.existsSync(f.destinationRoot),false)
  assert.equal(f.supervisor.snapshot().phase,'capturing')
  assert.throws(()=>f.supervisor.finishGracefulShutdown(),
    /child exits must be confirmed/)
})

test('uncheckpointed source SQLite WAL refuses snapshot while owner lock remains held',async t=>{
  const f=await fixture(t)
  await gracefullyStop(f)
  const wal=path.join(f.sourceRoot,'households',primary,'data','calendar.db-wal')
  fs.writeFileSync(wal,'synthetic WAL should be refused')
  await assert.rejects(captureAfterDisposableReviewedShutdown(options(f)),
    /unrecognized or missing files/)
  assert.equal(fs.existsSync(f.destinationRoot),false)
  assert.equal(f.supervisor.snapshot().phase,'capturing')
  assert.equal(fs.existsSync(path.join(f.stateDirectory,
    '.family-calendar-reviewed-supervisor-instance.lock')),true)
})

test('mismatched family identity scope, reused port and incomplete gateway closure all fail',async t=>{
  const f=await fixture(t)
  await gracefullyStop(f)
  const opts=options(f)
  await assert.rejects(captureAfterDisposableReviewedShutdown({
    ...opts,plan:Object.freeze({...f.plan,householdIds:Object.freeze([primary])}),
  }),/reviewed household plan|exact household scope/)
  await assert.rejects(captureAfterDisposableReviewedShutdown({
    ...opts,backendPorts:{[primary]:f.gatewayPort,[invited]:f.backendPorts[invited]},
  }),/distinct/)
  await assert.rejects(captureAfterDisposableReviewedShutdown({
    ...opts,gatewayClosed:false,
  }),/closed gateway required/)
  assert.equal(f.supervisor.snapshot().phase,'stopping')
  assert.equal(fs.existsSync(f.destinationRoot),false)
})

test('valid backup format with a foreign household is rejected before publication',async t=>{
  const f=await fixture(t)
  await gracefullyStop(f)
  fs.mkdirSync(path.join(f.sourceRoot,'households','unknown-household'))
  await assert.rejects(captureAfterDisposableReviewedShutdown(options(f)),
    /offline source households differ from supervised household scope/)
  assert.equal(fs.existsSync(f.destinationRoot),false)
  assert.equal(f.supervisor.snapshot().phase,'capturing')
})
