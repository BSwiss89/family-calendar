// Safety contract for the MANUAL, TEST-only offline backup capture.
// The real Windows host and installed calendars are NEVER used in CI.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const file=fileURLToPath(new URL('./capture-private-phase1-offline-legacy-test.ps1',import.meta.url))
const source=fs.readFileSync(file,'utf8')

test('manual capture checks existing TEST task and live shared protections',()=>{
  for(const value of [
    '[switch]$Capture','if(-not $Capture)',
    'OFFLINE_TEST_CAPTURE=NOT_STARTED',
    "Get-ScheduledTask -TaskName $testName",
    "Get-ScheduledTask -TaskName $updaterName",
    ".State -cne 'Disabled'",
    'auto-test-deploy',
    'Win32_Process','monthlyInfo.NextRunTime',
    '100.124.58.19','C:\\ProgramData',
    'manifestRows','restoreBootVerified=$false',
    'coordinatedCentralAndFamilySnapshot=$false',
    'testDeploymentAuthorized=$false',
    'liveDeploymentAuthorized=$false',
  ]){
    assert(source.includes(value),value)
  }
  assert.match(source,/sha256/i)
})
test('PowerShell script parses and has no scheduled-task/process-control commands',()=>{
  if(process.platform!=='win32')return
  const escaped=file.replaceAll("'","''")
  const program=[
    "$e=$null;$t=$null;$a=[System.Management.Automation.Language.Parser]::ParseFile('",
    escaped,
    "',[ref]$t,[ref]$e);if(@($e).Count){exit 30};",
    "$calls=@($a.FindAll({param($x)$x -is [System.Management.Automation.Language.CommandAst]},$true)|ForEach-Object{$_.GetCommandName()});",
    "$bad=@('Start-ScheduledTask','Stop-ScheduledTask','Enable-ScheduledTask','Disable-ScheduledTask','Set-ScheduledTask','Register-ScheduledTask','Start-Process','Stop-Process','Restart-Computer','shutdown','schtasks');",
    "if(@($calls|Where-Object{$bad -icontains $_}).Count){exit 31}",
  ].join('')
  const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',program],
    {encoding:'utf8',windowsHide:true,timeout:12000})
  assert.equal(result.status,0,result.stderr||'PowerShell AST validation refused')
  assert.equal((source.match(/& git -C \$test rev-parse HEAD/g)||[]).length,1)
  assert.equal((source.match(/& netsh interface portproxy show v4tov4/g)||[]).length,1)
  assert.doesNotMatch(source,/\bnetsh\s+interface\s+portproxy\s+(?:add|delete|reset)\b/i)
})
test('partial capture never removes data or claims deploy/restore permission',()=>{
  for(const value of [
    'OFFLINE_LEGACY_TEST_BACKUP=CAPTURED',
    'OFFLINE_LEGACY_TEST_BACKUP=REQUIRES_MANUAL_REVIEW',
    'AUTOMATIC_CLEANUP=NO','RESTORE_BOOT_VERIFIED=NO',
    'TEST_CUTOVER_AUTHORIZED=NO',
  ]) assert(source.includes(value),value)
  assert.doesNotMatch(source,/\bRemove-Item\b/i)
})
