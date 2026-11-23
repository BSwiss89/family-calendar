// Disposable PowerShell AST fixtures; inspected scripts are NEVER executed.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const inspector=fileURLToPath(new URL('./inspect-private-phase1-watchdog-source.ps1',import.meta.url))
function inspect(source){
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'phase1-watchdog-ast-'))
  try{
    const target=path.join(temp,'synthetic-watchdog.ps1')
    fs.writeFileSync(target,source,'utf8')
    return spawnSync('powershell.exe',[
      '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',
      '-File',inspector,'-ScriptPath',target,
    ],{encoding:'utf8',windowsHide:true,timeout:12000})
  }finally{
    fs.rmSync(temp,{recursive:true,force:true})
  }
}
test('literal LIVE target and dynamic TEST target are reported without executing source',()=>{
  if(process.platform!=='win32')return
  const result=inspect(
    "throw 'MUST_NOT_EXECUTE_CANARY_SECRET'\n"+
    "Start-ScheduledTask -TaskName 'Family Calendar Server'\n"+
    "$name='Family Calendar Secure TEST'\n"+
    "Start-ScheduledTask -TaskName $name\n"+
    "$p=Get-Process node\n")
  assert.equal(result.status,0,result.stderr)
  assert.match(result.stdout,/KNOWN_TASK_LITERALS=.*Family Calendar Server/)
  assert.match(result.stdout,/KNOWN_TASK_LITERALS=.*Family Calendar Secure TEST/)
  assert.match(result.stdout,/TASK_PROCESS_CONTROL_COMMANDS=Start-ScheduledTask/)
  assert.match(result.stdout,/DYNAMIC_TASK_TARGETS=1/)
  assert.match(result.stdout,/PROCESS_INSPECTION_COMMANDS=1/)
  assert.match(result.stdout,/WATCHDOG_TEST_EXCLUSION_PROVEN=NO/)
  assert.match(result.stdout,/SCRIPT_EXECUTED=NO/)
  assert.doesNotMatch(result.stdout,/MUST_NOT_EXECUTE_CANARY_SECRET/)
})
test('indirect script calls and dynamic invocations never become safe approvals',()=>{
  if(process.platform!=='win32')return
  const result=inspect(
    "$command='Start-ScheduledTask'\n"+
    "& $command -TaskName 'Family Calendar Server'\n"+
    "& (Join-Path $PSScriptRoot 'other-tool.ps1')\n"+
    "Restart-Computer\n")
  assert.equal(result.status,0,result.stderr)
  assert.match(result.stdout,/TASK_PROCESS_CONTROL_COMMANDS=Restart-Computer/)
  assert.match(result.stdout,/DYNAMIC_COMMANDS=[1-9]/)
  assert.match(result.stdout,/PS1_LITERALS=1/)
  assert.match(result.stdout,/TEST_DEPLOY_AUTHORIZED=NO/)
})
test('invalid PowerShell source fails without executing it',()=>{
  if(process.platform!=='win32')return
  const result=inspect("Write-Output 'unclosed")
  assert.notEqual(result.status,0)
  assert.doesNotMatch(result.stdout,/SOURCE_SCOPE=ADVISORY_ONLY/)
})
