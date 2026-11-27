// SOURCE-ONLY DISPOSABLE Phase 1 integration: real calendar backend children,
// private gateway, reviewed supervisor ownership and a real signed Owner login.
//
// This runner REFUSES installed-site data and OS service activation: identity,
// household data and supervisor locks must be under a fresh OS-temp fixture.
// It neither registers Windows tasks, changes HTTPS/portproxy/firewall, nor
// attests OS-wide writer fencing. NEVER use as a TEST or LIVE deployment tool.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { fork, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { planReviewedPrivateTestStartup } from './private-reviewed-test-startup-plan.mjs'
import { createReviewedWindowsSupervisorOwnership } from './private-reviewed-windows-supervisor-ownership.mjs'
import { startPrivateHouseholdGateway, verifyPrivateBackendBindings } from './private-household-gateway.mjs'
import { resolvePrivatePhase1GatewayLoopbackPort } from './private-household-gateway.mjs'
import { captureClosedPhase1SupervisorBackup } from './private-phase1-supervised-backup.mjs'
import { assertLocalMaintenanceClear } from './private-phase1-local-maintenance-control.mjs'
import { capturePendingActivationBackup } from './private-phase1-pending-activation-backup.mjs'

const PROTECTED = new Set([443, 8443, 3001, 11434, 13001, 13002, 13003, 13004])
function refuse(message) {
  throw new Error('Disposable Phase 1 gateway supervisor refused: ' + message)
}
function inside(parent, child) {
  const rel = path.relative(parent, child)
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) &&
    !path.isAbsolute(rel)
}
function physicalDirectory(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) ||
      !fs.lstatSync(directory).isDirectory() ||
      fs.lstatSync(directory).isSymbolicLink()) {
    refuse('absolute physical fixture directories are required.')
  }
  return fs.realpathSync(directory)
}
function physicalFile(filename) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename) ||
      !fs.lstatSync(filename).isFile() || fs.lstatSync(filename).isSymbolicLink()) {
    refuse('an existing physical central identity SQLite file is required.')
  }
  return fs.realpathSync(filename)
}
function verifiedPaths({ fixtureRoot, storageRoot, stateDirectory, identityDatabasePath,
  serverDirectory }) {
  const temp = physicalDirectory(os.tmpdir())
  const root = physicalDirectory(fixtureRoot)
  const storage = physicalDirectory(storageRoot)
  const state = physicalDirectory(stateDirectory)
  const identity = physicalFile(identityDatabasePath)
  const server = physicalDirectory(serverDirectory)
  const checkout = path.dirname(server)
  if (!inside(temp, root) || !inside(root, storage) || !inside(root, state) ||
      !inside(root, identity) || inside(storage, state) || inside(state, storage) ||
      inside(storage, identity) || inside(state, identity) ||
      !fs.existsSync(path.join(server, 'index.mjs')) ||
      inside(root, checkout) || inside(checkout, root)) {
    refuse('central identity, storage, state and source must be separately contained.')
  }
  // A trusted checkout in the home Projects area may be an installed site.
  // Never spawn from one of these installed LIVE/TEST roots during a fixture.
  const projects = path.join(os.homedir(), 'Projects')
  const blocked = ['family-calendar', 'family-calendar-test',
    'family-calendar-test-security-stage', 'family-calendar-live-auth-candidate']
  blocked.push('family-calendar-phase1-test-code')
  if (blocked.some(name => path.resolve(checkout).toLowerCase() ===
      path.resolve(projects, name).toLowerCase())) {
    refuse('installed LIVE/TEST source checkout cannot run this fixture.')
  }
  return { root, storage, state, identity, server, checkout }
}

async function choosePort(used) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const listener = net.createServer()
    let port
    try {
      await new Promise((resolve, reject) => {
        listener.once('error', reject)
        listener.listen(0, '127.0.0.1', resolve)
      })
      port = listener.address().port
    } finally {
      if (listener.listening) {
        await new Promise((resolve, reject) => listener.close(error =>
          error ? reject(error) : resolve()))
      }
    }
    if (port >= 1024 && port <= 65535 && !used.has(port) &&
        !PROTECTED.has(port)) {
      used.add(port)
      return port
    }
  }
  refuse('no distinct private loopback backend port available.')
}
function childEnvironment(storageRoot, householdId, port, token) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^FAMILY_CALENDAR_/i.test(key) &&
    !['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE'].includes(key.toUpperCase())))
  return {
    ...env,
    FAMILY_CALENDAR_HOST: '127.0.0.1',
    FAMILY_CALENDAR_PORT: String(port),
    FAMILY_CALENDAR_AUTH_MODE: 'disabled',
    FAMILY_CALENDAR_HOUSEHOLD_STORAGE_ROOT: storageRoot,
    FAMILY_CALENDAR_HOUSEHOLD_ID: householdId,
    FAMILY_CALENDAR_HOUSEHOLD_TEST_ONLY: 'YES',
    FAMILY_CALENDAR_PRIVATE_UPSTREAM_TOKEN: token,
  }
}
async function spawnBackend(paths, householdId, port, token, guard) {
  const child = fork(path.join(paths.server, 'index.mjs'), [], {
    cwd: paths.checkout,
    env: childEnvironment(paths.storage, householdId, port, token),
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  const closed = new Promise(resolve => child.once('close', resolve))
  const backend = { householdId, port, token, child, closed }
  try {
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
    guard.captureBackend({ householdId, child })
    for (let attempt = 0; attempt < 60; attempt++) {
      if (child.exitCode !== null || child.signalCode !== null) break
      try {
        const response = await fetch('http://127.0.0.1:' + port + '/api/health', {
          headers: { 'x-family-calendar-upstream-token': token },
          signal: AbortSignal.timeout(1000),
        })
        if (response.status === 200 && (await response.json()).status === 'ok') {
          const direct = await fetch('http://127.0.0.1:' + port + '/api/events', {
            signal: AbortSignal.timeout(1000),
          })
          if (direct.status !== 403) refuse('direct household backend bypass detected.')
          return backend
        }
      } catch {
        // Startup attempts may encounter an unopened listener; never relax
        // the authenticated health, direct-denial or later identity proof.
      }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    refuse('private household backend did not prove authenticated health.')
  } catch (error) {
    // Let the coordinator explicitly reconcile this captured child; do not
    // auto-delete any writer lock or assume an exit after process.kill().
    error.capturedBackend = backend
    throw error
  }
}
async function stopCaptured(backend) {
  const { child, closed, householdId } = backend
  if (child.exitCode === null && child.signalCode === null) {
    if (!child.connected) refuse('supervised backend IPC disconnected unexpectedly.')
    await new Promise((resolve, reject) => child.send({
      type: 'private-household-test-shutdown', householdId,
    }, error => error ? reject(error) : resolve()))
  }
  let timer
  try {
    await Promise.race([
      closed,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(
          'Private child did not confirm exit; manual fixture review required.')), 12000)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
  if (child.exitCode !== 0) {
    refuse('private backend did not exit cleanly; retain supervisor lock.')
  }
}

/**
 * Real Node household backend + gateway integration, but only within an
 * independently disposable OS-temp fixture. Exactly the planner's approved
 * primary/invited families are eligible. Never use installed calendar DBs.
 */
export async function launchDisposableReviewedPhase1Gateway({
  fixtureRoot, storageRoot, stateDirectory, identityDatabasePath,
  serverDirectory, primaryHouseholdId, operatorUserIds,
  trustedPhase1GatewayPort = null,
}) {
  const paths = verifiedPaths({
    fixtureRoot, storageRoot, stateDirectory, identityDatabasePath,
    serverDirectory,
  })
  return launchReviewedGateway({paths,primaryHouseholdId,operatorUserIds,trustedPhase1GatewayPort,disposable:true})
}

// No public path override or fixture bypass: the persistent wrapper below
// derives every path from the fixed TEST installation and checks the host.
async function launchReviewedGateway({paths,primaryHouseholdId,operatorUserIds,trustedPhase1GatewayPort,disposable}) {
  if (!Array.isArray(operatorUserIds) || operatorUserIds.length !== 1 ||
      !Number.isSafeInteger(operatorUserIds[0]) || operatorUserIds[0] < 1) {
    refuse('one independently trusted operator ID must be supplied.')
  }
  const gatewayPort = resolvePrivatePhase1GatewayLoopbackPort({
    port: trustedPhase1GatewayPort, phase1OwnerPilotOnly: true,
  })
  const central = new DatabaseSync(paths.identity)
  let guard = null
  const backends = []
  let gateway = null
  try {
    if(!disposable){
      const operator=central.prepare("SELECT id FROM family_users WHERE id=? AND disabled=0 AND account_kind='person'").get(operatorUserIds[0])
      if(!operator||central.prepare('SELECT COUNT(*) AS n FROM household_memberships WHERE user_id=?').get(operator.id).n!==0)refuse('active separate operator required.')
    }
    let plan = planReviewedPrivateTestStartup({
      identityDatabase: central,
      serverDirectory: paths.server, storageRoot: paths.storage,
      stateDirectory: paths.state, primaryHouseholdId,
    })
    guard = createReviewedWindowsSupervisorOwnership({
      plan, stateDirectory: paths.state,
    })
    const used = new Set(PROTECTED)
    if (gatewayPort !== 0) used.add(gatewayPort)
    const backendPorts = {}
    const backendTokens = {}
    for (const householdId of plan.householdIds) {
      const port = await choosePort(used)
      const token = randomBytes(32).toString('hex')
      const backend = await spawnBackend(paths, householdId, port, token, guard)
        .catch(error => {
          if (error.capturedBackend) backends.push(error.capturedBackend)
          throw error
        })
      backends.push(backend)
      backendPorts[householdId] = port
      backendTokens[householdId] = token
    }
    // Recheck tenant identity of EACH real child before central gateway boot.
    await verifyPrivateBackendBindings(
      new Map(Object.entries(backendPorts)),
      new Map(Object.entries(backendTokens)),
    )
    let shutdownRequested = false
    let activationInProgress = false
    // The HTTP layer can request only an issuer-scoped, password-reverified
    // household ID. Ports, upstream secrets, paths and child ownership are
    // chosen exclusively here, inside the already reviewed TEST supervisor.
    async function activateHousehold(householdId) {
      if(shutdownRequested||activationInProgress||guard.snapshot().phase!=='running'||
         backends.some(({child})=>child.exitCode!==null||child.signalCode!==null||!child.connected))
        throw Error('Private household supervisor is busy or held.')
      assertLocalMaintenanceClear(paths.root)
      if(plan.householdIds.includes(householdId))throw Error('Household already active.')
      activationInProgress=true
      let reserved=false
      try{
        // Synchronous preflight/backup: the pending household is unrouted,
        // has no writer lock, no journals and exactly its empty seed schema.
        capturePendingActivationBackup({paths,identityDatabase:central,householdId})
        guard.beginEnrollment(householdId)
        reserved=true
        const port=await choosePort(used)
        const token=randomBytes(32).toString('hex')
        const backend=await spawnBackend(paths,householdId,port,token,guard).catch(error=>{
          if(error.capturedBackend)backends.push(error.capturedBackend)
          throw error
        })
        backends.push(backend)
        if(guard.snapshot().phase!=='enrolling')throw Error('Supervisor held during activation.')
        await gateway.enrollHouseholdBackend({householdId,port,upstreamToken:token})
        backendPorts[householdId]=port
        backendTokens[householdId]=token
        const householdIds=Object.freeze([primaryHouseholdId,...[...plan.householdIds.slice(1),householdId].sort()])
        plan=Object.freeze({...plan,householdIds,householdCount:householdIds.length})
        guard.finishEnrollment(householdId)
        return {activation:'active',householdId}
      }catch(error){
        // Once a child was reserved, never silently restart or discard its
        // possibly initialized storage. Keep a durable hold for local review.
        if(reserved)guard.failEnrollment(householdId)
        throw error
      }finally{activationInProgress=false}
    }
    gateway = await startPrivateHouseholdGateway({
      identityDatabase: central, serverDirectory: paths.server,
      storageRoot: paths.storage, backendPorts, backendTokens,
      independentHouseholdAdministratorUserIds: operatorUserIds,
      enforceFamilyMemberPermissions: true,
      phase1OwnerPilotOnly: true,
      trustedPhase1GatewayPort,
      activateReviewedHousehold: activateHousehold,
      supervisorAdmissionCheck: () => guard.snapshot().phase === 'running' &&
        backends.every(({child}) => child.exitCode === null && child.signalCode === null && child.connected === true),
    })
    guard.markHealthy()
    return Object.freeze({
      base: gateway.base,
      snapshot: () => Object.freeze({
        ...guard.snapshot(),
        activationInProgress,
        householdIds: Object.freeze([...plan.householdIds]),
        gatewayLocalhostOnly: new URL(gateway.base).hostname === '127.0.0.1',
        gatewayPort: gateway.port,
        childPorts: Object.freeze([...Object.values(backendPorts)]),
        realCalendarBackendsStarted: true,
        realGatewayStarted: true,
        supervisorAdmissionOpen: guard.snapshot().phase === 'running' &&
          backends.every(({child}) => child.exitCode === null && child.signalCode === null && child.connected === true),
        osTempFixtureOnly: disposable,
        testDeploymentAuthorized: false,
        liveDeploymentAuthorized: false,
        osWideWriterFencingVerified: false,
        windowsTaskInstalled: false,
      }),
      // Fault injection is restricted to the captured OS-temp fixture child.
      ...(disposable?{crashCapturedBackendForTest(householdId) {
        if (shutdownRequested || guard.snapshot().phase !== 'running') refuse('fixture not running.')
        const backend = backends.find(item => item.householdId === householdId)
        if (!backend) refuse('unknown captured fixture child.')
        return backend.child.kill()
      }}:{}),
      // Explicit fixture-only cleanup after a hold. Never clear supervisor
      // ownership or a crash marker; no automatic restart or rollback.
      async [disposable?'closeHeldFixtureForTest':'closeHeldForReview']() {
        if (shutdownRequested || guard.snapshot().phase !== 'held') refuse('held fixture required.')
        shutdownRequested = true
        await gateway.close()
        const failures = []
        for (const backend of [...backends].reverse()) {
          try {
            if (backend.child.exitCode !== null || backend.child.signalCode !== null) await backend.closed
            else await stopCaptured(backend)
          } catch (error) { failures.push(error) }
        }
        central.close()
        if (failures.length) throw new AggregateError(failures,'Held fixture cleanup requires review.')
        return Object.freeze({gatewayClosed:true, allCapturedChildrenExited:true,
          ownerInstanceRetained:true, testDeploymentAuthorized:false})
      },
      async shutdownAndCaptureBackup() {
        if (shutdownRequested || activationInProgress) refuse('supervised shutdown already requested or activation in progress.')
        shutdownRequested = true
        guard.beginGracefulShutdown()
        await gateway.closeForOfflineBackup(async () => {
          for (const backend of [...backends].reverse()) await stopCaptured(backend)
        })
        central.close()
        guard.beginDisposableOfflineCapture(plan.householdIds)
        const receipt = await captureClosedPhase1SupervisorBackup({paths,plan,guard,backends,gatewayPort:gateway.port})
        guard.completeDisposableOfflineCapture()
        guard.finishGracefulShutdown()
        return Object.freeze({...receipt,allChildrenExited:true,gatewayClosed:true,ownerInstanceReleased:true,testDeploymentAuthorized:false})
      },
      async shutdown() {
        if (shutdownRequested || activationInProgress) refuse('reviewed fixture shutdown already requested or activation in progress.')
        shutdownRequested = true
        guard.beginGracefulShutdown()
        await gateway.close()
        for (const backend of [...backends].reverse()) {
          await stopCaptured(backend)
        }
        central.close()
        guard.finishGracefulShutdown()
        return Object.freeze({
          allChildrenExited: true, gatewayClosed: true,
          ownerInstanceReleased: true, osWideWriterFencingVerified: false,
          testDeploymentAuthorized: false,
        })
      },
    })
  } catch (error) {
    // A failed boot retains the supervisor instance lock. Never automatically
    // re-enable an old service, reclaim a lock or infer safe OS-wide recovery.
    const failures = [error]
    if (gateway) {
      try { await gateway.close() } catch (failure) { failures.push(failure) }
    }
    for (const backend of [...backends].reverse()) {
      try { await stopCaptured(backend) }
      catch (failure) { failures.push(failure) }
    }
    try { central.close() } catch (failure) { failures.push(failure) }
    if (failures.length > 1) {
      throw new AggregateError(failures,
        'Disposable private boot failed; supervised recovery requires operator review.')
    }
    throw error
  }
}


// Fixed, local persistent TEST launch contract. The inactive staging module
// cannot create this activation review or remove its DO-NOT-START hold.
// The separate operator-approved cutover must first prepare both. There is
// deliberately no CLI flag to override either requirement.
export async function launchReviewedWindowsPhase1TestGateway(){
 if(process.platform!=='win32')refuse('Windows TEST host required.')
 // SYSTEM has a different home profile. Use the fixed checkout's physical
 // sibling layout; the Windows host gate verifies the actual registered user profile.
 const projects=physicalDirectory(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..','..'))
 if(path.basename(projects).toLowerCase()!=='projects')refuse('fixed Projects directory required.')
 const checkout=physicalDirectory(path.join(projects,'family-calendar-phase1-test-code'))
 const server=physicalDirectory(path.join(checkout,'Server'))
 if(server!==physicalDirectory(path.dirname(fileURLToPath(import.meta.url))))refuse('fixed TEST code checkout required.')
 const root=physicalDirectory(path.join(projects,'family-calendar-phase1-test-data'))
 if(path.dirname(root)!==projects||path.dirname(checkout)!==projects)refuse('fixed physical TEST sibling roots required.')
 assertLocalMaintenanceClear(root)
 const storage=physicalDirectory(path.join(root,'data'))
 const state=physicalDirectory(path.join(root,'supervisor-state'))
 const identity=physicalFile(path.join(storage,'central','identity.db'))
 if(path.dirname(storage)!==root||path.dirname(state)!==root||path.dirname(identity)!==path.join(storage,'central')||
    fs.statSync(identity).nlink!==1)refuse('unexpected TEST data layout.')
 for(const name of ['DO-NOT-START.json','ACTIVATION-IN-PROGRESS.json']){
  try{fs.lstatSync(path.join(root,name));refuse('inactive or unfinished TEST activation hold present.')}
  catch(e){if(e.code!=='ENOENT')throw e}
 }
 const reviewPath=physicalFile(path.join(root,'ACTIVE-TEST-REVIEW.json'))
 if(path.dirname(reviewPath)!==root||fs.statSync(reviewPath).nlink!==1||fs.statSync(reviewPath).size>8192)refuse('invalid activation review file.')
 const r=JSON.parse(fs.readFileSync(reviewPath,'utf8'))
 const sha=/^[a-f0-9]{40}$/
 if(r?.kind!=='phase1-windows-active-test-review-v1'||r.site!=='existing-secure-test'||
    !sha.test(r.candidateSha??'')||!sha.test(r.legacyTestSha??'')||!sha.test(r.liveSha??'')||
    r.primaryHouseholdId!=='primary-family'||!Number.isSafeInteger(r.operatorUserId)||r.operatorUserId<1||
    r.testStartupApproved!==true||r.liveDeploymentAuthorized!==false||r.gatewayPort!==13004)refuse('explicit reviewed TEST activation configuration required.')
 const ps=path.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe')
 const result=spawnSync(ps,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',
   path.join(checkout,'scripts','assert-private-phase1-windows-launch-host.ps1'),
   '-ExpectedCandidateSha',r.candidateSha,'-ExpectedInstalledTestSha',r.legacyTestSha,'-ExpectedLiveSha',r.liveSha],{
    encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:1024*1024})
 if(result.error||result.status!==0||result.stdout.trim()!=='PHASE1_WINDOWS_LAUNCH_HOST=PASS | TEST_ONLY=YES')refuse('Windows launch host preflight failed.')
 // Detect a changed review during the host checks. It is a local protected
 // operator file, not an externally authenticated deployment receipt.
 if(JSON.stringify(JSON.parse(fs.readFileSync(reviewPath,'utf8')))!==JSON.stringify(r)||fs.existsSync(path.join(root,'DO-NOT-START.json'))||
    fs.existsSync(path.join(root,'ACTIVATION-IN-PROGRESS.json')))refuse('activation review changed during host preflight.')
 assertLocalMaintenanceClear(root)
 return launchReviewedGateway({paths:{root,storage,state,identity,server,checkout},primaryHouseholdId:r.primaryHouseholdId,
   operatorUserIds:[r.operatorUserId],trustedPhase1GatewayPort:13004,disposable:false})
}
