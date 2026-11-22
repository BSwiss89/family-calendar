// Pure synthetic scheduler snapshots. No Windows tasks or other host resources.
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const psFile = fileURLToPath(new URL('./inspect-private-phase1-windows-test-task-fingerprints.ps1', import.meta.url))
test('PowerShell 5.1 inspector parses without touching Windows Task Scheduler',()=>{
  if (process.platform !== 'win32') return
  const expression = "$t=$null;$e=$null;[System.Management.Automation.Language.Parser]::ParseFile($args[0],[ref]$t,[ref]$e)|Out-Null;if(@($e).Count){exit 23}"
  const output=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',expression,psFile],{
    encoding:'utf8', windowsHide:true, timeout:12000,
  })
  assert.equal(output.status,0,'read-only Task Scheduler inspector must parse cleanly')
  const source=fs.readFileSync(psFile,'utf8')
  for(const forbidden of [/Stop-ScheduledTask/i,/Disable-ScheduledTask/i,
    /Start-ScheduledTask/i,/Set-ScheduledTask/i,/Register-ScheduledTask/i,
    /netsh.*portproxy.*add/i,/Remove-Item/i]){
    assert.doesNotMatch(source,forbidden)
  }
})
import assert from 'node:assert/strict'
import { assessPrivatePhase1WindowsTaskFencing as assess }
  from '../Server/private-phase1-windows-test-task-fencing.mjs'

const sha='76caa3e46186c3c5c6408f11b55800eb06779776'
function item(name, state='Ready', index=1) {
  return {
    name, path:'\\', state, enabled:state!=='Disabled',
    actionDigest:index.toString(16).padStart(64,'0'),
    principalDigest:(index+100).toString(16).padStart(64,'0'),
    triggerDigest:(index+200).toString(16).padStart(64,'0'),
    triggerCount:1, restartCount:3, multipleInstances:'IgnoreNew',
  }
}
const names = [
  'Family Calendar Server', 'Family Calendar Ollama Server',
  'Family Calendar Watchdog', 'Family Calendar Secure TEST',
  'Family Calendar Secure TEST Auto Deploy',
  'Family Calendar Auto Deploy', 'Family Calendar Backup Sender',
]
function baseline() {
  return {
    schemaVersion:1,site:'existing-secure-test',stage:'baseline',
    installedTestSha:sha,enumerationSucceeded:true,
    tasks:names.map((name,i)=>item(name,
      name==='Family Calendar Auto Deploy'?'Disabled':'Ready',i+1)),
  }
}
function maintenance() {
  const data=baseline()
  data.stage='maintenance-fenced'
  for(const task of data.tasks){
    if(['Family Calendar Secure TEST',
      'Family Calendar Secure TEST Auto Deploy'].includes(task.name)){
      task.state='Disabled'
      task.enabled=false
    }
  }
  return data
}
const review=(one=baseline(),two=maintenance())=>
  assess({baseline:one,maintenance:two,expectedInstalledTestSha:sha})

test('only both TEST scheduler tasks may be reported disabled; all attestation and release flags remain false',()=>{
  const r=review()
  assert.equal(r.observedTaskStatesMatch,true)
  assert.deepEqual(r.blockers,[])
  assert.equal(r.legacyTestTaskDisabledOnReportedSnapshot,true)
  assert.equal(r.legacyTestAutoDeployDisabledOnReportedSnapshot,true)
  for(const field of [
    'taskActionDefinitionAttestedByOperator',
    'watchdogTestRestartExcludedByCodeReview',
    'installedLegacyProcessStopped','installedLegacyBackendPortClosed',
    'sqliteWritersQuiesced','liveIsolationVerified','backupAndRollbackVerified',
    'safeToCutover','testDeploymentAuthorized','liveDeploymentAuthorized',
    'windowsTasksModified',
  ]) assert.equal(r[field],false,field)
  assert(Object.isFrozen(r)&&Object.isFrozen(r.blockers))
})
test('unfenced TEST auto-deployer or legacy start task remains a blocker',()=>{
  for(const name of ['Family Calendar Secure TEST',
    'Family Calendar Secure TEST Auto Deploy']){
    const other=maintenance()
    const current=other.tasks.find(x=>x.name===name)
    current.state='Ready';current.enabled=true
    const r=review(baseline(),other)
    assert.equal(r.observedTaskStatesMatch,false)
    assert(r.blockers.some(x=>/starter or auto-deployer/.test(x)))
    assert.equal(r.safeToCutover,false)
  }
})
test('changed watchdog, LIVE, unrelated tasks or app task set cannot pass',()=>{
  for(const name of ['Family Calendar Watchdog',
    'Family Calendar Server','Family Calendar Ollama Server',
    'Family Calendar Backup Sender']){
    const other=maintenance()
    const current=other.tasks.find(x=>x.name===name)
    current.state='Disabled';current.enabled=false
    const r=review(baseline(),other)
    assert.equal(r.observedTaskStatesMatch,false)
    assert(r.blockers.some(x=>/task state changed|watchdog/.test(x)))
  }
  let other=maintenance()
  other.tasks.push(item('Family Calendar Notes', 'Ready',80))
  assert(review(baseline(),other).blockers.some(x=>/Task set changed/.test(x)))
  other=maintenance()
  other.tasks.pop()
  assert(review(baseline(),other).blockers.some(x=>/Task set changed/.test(x)))
})
test('action, principal, trigger, retry and instance drift are all blockers',()=>{
  for(const [key,value] of [
    ['actionDigest','f'.repeat(64)],
    ['principalDigest','f'.repeat(64)],
    ['triggerDigest','f'.repeat(64)],
    ['restartCount',4],['triggerCount',2],['multipleInstances','Parallel'],
  ]){
    const other=maintenance()
    other.tasks[3][key]=value
    const r=review(baseline(),other)
    assert.equal(r.observedTaskStatesMatch,false)
    assert(r.blockers.some(x=>/definition, principal or trigger/.test(x)))
  }
})
test('wrong or malformed task inventories fail before comparison, never auto-accept',()=>{
  for(const patch of [
    {installedTestSha:'wrong'}, {site:'live'}, {stage:'candidate-review'},
    {enumerationSucceeded:false},{schemaVersion:2},{tasks:[]},
  ])assert.throws(()=>review(baseline(),{...maintenance(),...patch}),/refused/)
  for(const changed of [
    data=>data.tasks[0].actionDigest='bad',
    data=>data.tasks[0].enabled=false,
    data=>data.tasks[0].state='Unknown',
    data=>data.tasks[0].path='\\Other\\',
    data=>data.tasks.push({...data.tasks[0]}),
    data=>data.tasks.push(item('Family Calendar Secure TEST Shadow','Ready',88)),
  ]){
    const other=maintenance()
    changed(other)
    assert.throws(()=>review(baseline(),other),/refused/)
  }
})
test('baseline LIVE deployer enabled or TEST settings changed refuses start',()=>{
  const current=baseline()
  current.tasks.find(x=>x.name==='Family Calendar Auto Deploy')
    .state='Ready'
  current.tasks.find(x=>x.name==='Family Calendar Auto Deploy')
    .enabled=true
  assert.throws(()=>review(current,maintenance()),/LIVE auto-deploy/)
  const baselineTasks=baseline()
  baselineTasks.tasks.find(x=>x.name==='Family Calendar Secure TEST Auto Deploy')
    .multipleInstances='Parallel'
  assert.throws(()=>review(baselineTasks,maintenance()),/replay prevention/)
})
