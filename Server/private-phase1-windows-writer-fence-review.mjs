// Source-only, read-only Phase 1 TEST writer-fence review.
// Correlates immutable baseline and TWO independently reported maintenance
// snapshots. Never modifies Windows tasks, ports, processes, SQLite or files.
// A matching report is ONLY a prerequisite for a later separately approved
// coordinated backup, not proof of all filesystem writers or authorization.
import { assessPrivatePhase1WindowsTaskFencing } from './private-phase1-windows-test-task-fencing.mjs'
import { assessPrivatePhase1TestRoutingBoundary } from './private-phase1-test-network-boundary.mjs'

const SHA=/^[a-f0-9]{40}$/
const LIVE='127.0.0.1:3001'
const PROXY='127.0.0.1:13003'
const OLD='100.124.58.19:13002'
const PRIVATE=new Set([13004,13005,13006])
function refuse(reason) { throw new Error('Phase 1 writer fence refused: '+reason) }
function unique(list,key) {
  const found=new Set()
  for(const x of list) {
    const v=key(x)
    if(found.has(v)) refuse('duplicate host inventory entry.')
    found.add(v)
  }
}
function reviewObservation(observed,phase,baseline) {
  if(!observed||typeof observed!=='object'||Array.isArray(observed)||
      observed.schemaVersion!==1||observed.phase!==phase||
      observed.site!=='existing-secure-test'||observed.complete!==true||
      observed.installedTestSha!==baseline.installedTestSha||
      !Array.isArray(observed.listeners)||observed.listeners.length>40||
      !Array.isArray(observed.testProcesses)||observed.testProcesses.length>40||
      !Array.isArray(observed.testServices)||observed.testServices.length>20) {
    refuse('complete, stage-pinned sanitized Windows host observations required.')
  }
  for(const l of observed.listeners) {
    if(!l||!Number.isSafeInteger(l.pid)||l.pid<1||
       !Number.isSafeInteger(l.port)||l.port<1||l.port>65535||
       typeof l.address!=='string'||
       !['node.exe','svchost.exe'].includes(l.process)) {
      refuse('malformed protected listener or unidentified owner.')
    }
  }
  unique(observed.listeners,l=>l.address+':'+l.port)
  if(observed.testProcesses.some(p=>!p||!Number.isSafeInteger(p.pid)||p.pid<1||
     p.name!=='node.exe') ||
     observed.testServices.some(s=>typeof s!=='string'||s.length>100)) {
    refuse('malformed or incomplete TEST writer inventory.')
  }
  unique(observed.testProcesses,p=>p.pid)
  unique(observed.testServices,s=>s.toLowerCase())
  const endpoints=new Map(observed.listeners.map(x=>[x.address+':'+x.port,x]))
  const live=endpoints.get(LIVE),proxy=endpoints.get(PROXY)
  if(!live||live.process!=='node.exe'||live.pid!==baseline.livePid ||
      !proxy||proxy.process!=='svchost.exe'||proxy.pid!==baseline.portproxyPid ||
      observed.listeners.some(x=>PRIVATE.has(x.port)) ||
      observed.testServices.length!==0) {
    refuse('LIVE/portproxy ownership changed, private pilot started, or a TEST service appeared.')
  }
  if(phase==='baseline') {
    const legacy=endpoints.get(OLD)
    if(!legacy||legacy.process!=='node.exe'||legacy.pid!==baseline.legacyPid ||
       observed.testProcesses.length!==1 ||
       observed.testProcesses[0].pid!==baseline.legacyPid) {
      refuse('running legacy TEST process does not match pinned original baseline.')
    }
  } else {
    if(observed.testProcesses.length!==0 ||
       observed.listeners.some(x=>x.port===13002)) {
      refuse('legacy TEST writer or direct port 13002 remains present.')
    }
  }
  if(observed.listeners.length!==(phase==='baseline'?3:2)) {
    refuse('unreviewed protected listener present.')
  }
  return true
}
/**
 * The baseline remains the running legacy TEST. Maintenance snapshots can
 * only be taken after a NEW, separately authorized TEST-only task/process
 * fence. Independent collection, file locks, actual OS writer exclusion,
 * credentials/sessions, and rollback after writes remain unresolved.
 */
export function reviewPrivatePhase1WindowsWriterFence({
  baseline, maintenanceFirst, maintenanceSecond,
  taskBaseline, taskMaintenance, topologyLegacyFenced,
  expectedInstalledTestSha,
}) {
  if(!SHA.test(expectedInstalledTestSha)||!baseline||
     ![baseline.livePid,baseline.portproxyPid,baseline.legacyPid].every(x=>
       Number.isSafeInteger(x)&&x>0)||
     new Set([baseline.livePid,baseline.portproxyPid,baseline.legacyPid]).size!==3||
     baseline.installedTestSha!==expectedInstalledTestSha) {
    refuse('exact installed TEST revision and distinct protected process owners required.')
  }
  reviewObservation(baseline,'baseline',baseline)
  reviewObservation(maintenanceFirst,'maintenance-fenced',baseline)
  reviewObservation(maintenanceSecond,'maintenance-fenced',baseline)
  // Separate time-separated observations MUST agree in these exact protected
  // facts, but identical observations alone never prove there is no other
  // process with an open SQLite handle.
  if(JSON.stringify(maintenanceFirst)!==JSON.stringify(maintenanceSecond)) {
    refuse('protected listener or TEST writer reappeared between maintenance samples.')
  }
  const tasks=assessPrivatePhase1WindowsTaskFencing({
    baseline:taskBaseline,maintenance:taskMaintenance,
    expectedInstalledTestSha,
  })
  if(!tasks.observedTaskStatesMatch||tasks.blockers.length!==0) {
    refuse('legacy TEST scheduler tasks or protected definitions remain unfenced.')
  }
  if(!topologyLegacyFenced||topologyLegacyFenced.phase!=='legacy-fenced'||
     topologyLegacyFenced.installedTestSha!==expectedInstalledTestSha) {
    refuse('complete pre-backup TEST route observation required.')
  }
  const route=assessPrivatePhase1TestRoutingBoundary(topologyLegacyFenced)
  if(!route.legacyFenceTopologyMatches||route.blockers.length!==0) {
    refuse('legacy TEST network forwarding has changed unexpectedly.')
  }
  return Object.freeze({
    kind:'phase1-source-only-windows-writer-fence-review-v1',
    checkedExistingTestBaseline:true,
    reportedMaintenanceSamplesMatch:true,
    observedProtectedProcessAndPortFence:true,
    reportedTestScheduledTasksDisabled:true,
    reportedLegacyRouteUnchanged:true,
    allSystemWritersIndependentlyFenced:false,
    allSQLiteFileHandlesClosedVerified:false,
    liveHealthIndependentlyVerified:false,
    coordinatedSnapshotCaptured:false,
    backupAuthorized:false,
    rollbackAuthorized:false,
    testDeploymentAuthorized:false,
    liveDeploymentAuthorized:false,
    windowsServicesChanged:false,
    manualOperatorReviewRequired:true,
  })
}
