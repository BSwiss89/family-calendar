// Purely synthetic; cannot touch Windows processes, scheduler or SQLite.
import test from 'node:test'
import assert from 'node:assert/strict'
import { reviewPrivatePhase1WindowsWriterFence as review }
  from '../Server/private-phase1-windows-writer-fence-review.mjs'

const sha='76caa3e46186c3c5c6408f11b55800eb06779776'
const legacyIP='100.124.58.19'
const pid={livePid:19656,portproxyPid:2252,legacyPid:23164}
const taskNames=[
  'Family Calendar Server','Family Calendar Ollama Server',
  'Family Calendar Watchdog','Family Calendar Secure TEST',
  'Family Calendar Secure TEST Auto Deploy','Family Calendar Auto Deploy',
  'Family Calendar Auto Preview','Family Calendar Backup Ack Processor',
  'Family Calendar Backup Catchup Sender','Family Calendar Backup Cleanup',
  'Family Calendar Backup Sender','Family Calendar Local STT',
  'Family Calendar Monthly Restart','Family Calendar Project Backup',
  'Family Calendar Secure LIVE Auto Deploy',
]
const restarts=new Set([
  'Family Calendar Server','Family Calendar Ollama Server',
  'Family Calendar Secure TEST','Family Calendar Local STT',
])
const disabled=new Set([
  'Family Calendar Auto Deploy','Family Calendar Auto Preview',
  'Family Calendar Secure LIVE Auto Deploy',
])
const testTasks=new Set([
  'Family Calendar Secure TEST','Family Calendar Secure TEST Auto Deploy',
])
const sock=(address,port,pid,process)=>({address,port,pid,process})
function observed(phase='baseline') {
  return {
    schemaVersion:1,site:'existing-secure-test',phase,complete:true,
    installedTestSha:sha,...pid,
    observedAtMs:phase==='baseline'?1000:2000,
    listeners:[
      sock('127.0.0.1',3001,pid.livePid,'node.exe'),
      sock('127.0.0.1',13003,pid.portproxyPid,'svchost.exe'),
      ...(phase==='baseline'?
        [sock(legacyIP,13002,pid.legacyPid,'node.exe')]:[]),
    ],
    testProcesses:phase==='baseline'?
      [{pid:pid.legacyPid,name:'node.exe'}]:[],
    testServices:[],
  }
}
function tasks(stage) {
  return {
    schemaVersion:1,site:'existing-secure-test',stage,
    installedTestSha:sha,enumerationSucceeded:true,
    tasks:taskNames.map((name,i)=>{
      const off=disabled.has(name) ||
        (stage==='maintenance-fenced'&&testTasks.has(name))
      return {
        name,path:'\\',state:off?'Disabled':'Ready',enabled:!off,
        actionDigest:(i+1).toString(16).padStart(64,'0'),
        principalDigest:(i+21).toString(16).padStart(64,'0'),
        triggerDigest:(i+41).toString(16).padStart(64,'0'),
        triggerCount:1,restartCount:restarts.has(name)?3:0,
        multipleInstances:'IgnoreNew',
      }
    }),
  }
}
function route() {
  return {
    schemaVersion:1,site:'existing-secure-test',phase:'legacy-fenced',
    installedTestSha:sha,legacyTestAddress:legacyIP,gatewayPort:13004,
    portproxyRules:[{
      listenAddress:'127.0.0.1',listenPort:13003,
      connectAddress:legacyIP,connectPort:13002,
    }],
    listeners:[{address:'127.0.0.1',port:13003,role:'portproxy'}],
  }
}
function args() {
  return {
    baseline:observed(),maintenanceFirst:observed('maintenance-fenced'),
    maintenanceSecond:{...observed('maintenance-fenced'),observedAtMs:4000},
    taskBaseline:tasks('baseline'),taskMaintenance:tasks('maintenance-fenced'),
    topologyLegacyFenced:route(),expectedInstalledTestSha:sha,
  }
}
test('stable synthetic maintenance topology is observable but can NEVER authorize backup, rollback or TEST deploy',()=>{
  const result=review(args())
  assert.equal(result.checkedExistingTestBaseline,true)
  assert.equal(result.reportedMaintenanceSamplesMatch,true)
  assert.equal(result.observedProtectedProcessAndPortFence,true)
  assert.equal(result.reportedTestScheduledTasksDisabled,true)
  for(const key of ['allSystemWritersIndependentlyFenced',
    'allSQLiteFileHandlesClosedVerified','liveHealthIndependentlyVerified',
    'coordinatedSnapshotCaptured','backupAuthorized',
    'rollbackAuthorized','testDeploymentAuthorized','liveDeploymentAuthorized',
    'windowsServicesChanged']) {
    assert.equal(result[key],false,key)
  }
  assert.equal(result.manualOperatorReviewRequired,true)
  assert(Object.isFrozen(result))
})
test('live process, protected proxy or baseline TEST identity drift refuses',()=>{
  for(const patch of [
    x=>x.baseline.listeners[0].pid=999,
    x=>x.baseline.listeners[1].process='node.exe',
    x=>x.baseline.testProcesses[0].pid=1,
    x=>x.baseline.listeners[2].address='0.0.0.0',
    x=>x.baseline.testServices.push('unexpected-test-service'),
    x=>x.baseline.listeners.push(sock('127.0.0.1',13004,777,'node.exe')),
  ]){const x=args();patch(x);assert.throws(()=>review(x),/refused/)}
})
test('legacy writer, 13002 bypass and newly started private gateway refuse maintenance',()=>{
  for(const patch of [
    x=>x.maintenanceFirst.testProcesses.push({pid:23164,name:'node.exe'}),
    x=>x.maintenanceSecond.listeners.push(sock(legacyIP,13002,23164,'node.exe')),
    x=>x.maintenanceSecond.listeners.push(sock('127.0.0.1',13002,1,'node.exe')),
    x=>x.maintenanceFirst.listeners.push(sock('127.0.0.1',13004,2,'node.exe')),
    x=>x.maintenanceFirst.listeners[0].pid=111,
    x=>x.maintenanceFirst.testServices.push('manual-Test-service'),
  ]){const x=args();patch(x);assert.throws(()=>review(x),/refused/)}
})
test('TEST task auto-deployer, changed watchdog or route drift refuses',()=>{
  for(const patch of [
    x=>{
      const t=x.taskMaintenance.tasks.find(t=>t.name==='Family Calendar Secure TEST')
      t.state='Ready';t.enabled=true
    },
    x=>{
      const t=x.taskMaintenance.tasks.find(t=>t.name==='Family Calendar Secure TEST Auto Deploy')
      t.state='Ready';t.enabled=true
    },
    x=>{
      x.taskMaintenance.tasks.find(t=>t.name==='Family Calendar Watchdog')
        .actionDigest='f'.repeat(64)
    },
    x=>x.topologyLegacyFenced.portproxyRules[0].connectPort=13004,
    x=>x.topologyLegacyFenced.listeners.push({address:legacyIP,port:13002,role:'legacy-test'}),
    x=>x.expectedInstalledTestSha='f'.repeat(40),
  ]){const x=args();patch(x);assert.throws(()=>review(x),/refused/)}
})
test('maintenance snapshots must be time-separated, stable and correctly ordered',()=>{
  for(const patch of [
    x=>x.maintenanceSecond.observedAtMs=x.maintenanceFirst.observedAtMs,
    x=>x.maintenanceFirst.observedAtMs=x.baseline.observedAtMs,
    x=>x.maintenanceSecond.observedAtMs=x.maintenanceFirst.observedAtMs+15*60*1000+1,
    x=>x.maintenanceSecond.observedAtMs='4000',
    x=>x.baseline.observedAtMs=null,
  ]){const x=args();patch(x);assert.throws(()=>review(x),/refused/)}
  const reordered=args()
  reordered.maintenanceSecond.listeners.reverse()
  assert.equal(review(reordered).reportedMaintenanceSamplesMatch,true)
})
test('ambiguous inventories, duplicate listeners and mismatched samples fail closed',()=>{
  for(const patch of [
    x=>x.maintenanceFirst.complete=false,
    x=>x.maintenanceSecond.testProcesses=null,
    x=>x.maintenanceFirst.listeners.push({...x.maintenanceFirst.listeners[0]}),
    x=>x.maintenanceSecond.listeners.push({address:'::1',port:13005,pid:20,process:'node.exe'}),
    x=>x.maintenanceSecond.listeners[0].pid=12,
    x=>x.baseline.installedTestSha='bad',
    x=>x.maintenanceSecond.testServices.push(null),
  ]){const x=args();patch(x);assert.throws(()=>review(x),/refused/)}
})
