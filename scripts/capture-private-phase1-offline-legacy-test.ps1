# Phase 1 OFFLINE LEGACY TEST backup acquisition. Not a cutover/deployer.
# NO scheduled tasks, processes, ports, routing, SQLite source, LIVE data or
# code are changed. -Capture creates only a NEW recovery folder, and only
# AFTER a separately approved operator has stopped and disabled both legacy
# TEST tasks. Default invocation is an inspection with zero writes.
# Failure AFTER folder creation leaves that folder for manual review; it is
# NEVER considered a verified backup, deleted or used for automatic rollback.
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)]
  [ValidatePattern('^[a-f0-9]{40}$')]
  [string]$ExpectedInstalledTestSha,
  [switch]$Capture
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$homeRoot=$env:USERPROFILE
$test=Join-Path $homeRoot 'Projects\family-calendar-test-security-stage'
$preview=Join-Path $homeRoot 'Projects\family-calendar-preview\Server'
$recovery=Join-Path $homeRoot 'Projects\family-calendar-phase1-recovery'
$supervisor='C:\ProgramData\FamilyCalendar\SecureTest\start-secure-test-patched.ps1'
$node='C:\ProgramData\FamilyCalendar\Runtime\node-v24.22.1\node.exe'
$testName='Family Calendar Secure TEST'
$updaterName='Family Calendar Secure TEST Auto Deploy'
function Refuse([string]$reason){throw ('Phase 1 offline TEST capture refused: '+$reason)}
function Normal([string]$p){
  return [IO.Path]::GetFullPath($p).TrimEnd('\')
}
function ExactFolder([string]$p){
  $item=Get-Item -LiteralPath $p -Force -ErrorAction Stop
  if(-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){
    Refuse 'Unexpected linked or missing source folder.'
  }
  return $item.FullName
}
function ExactFile([string]$p){
  $item=Get-Item -LiteralPath $p -Force -ErrorAction Stop
  if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){
    Refuse 'Unexpected linked or missing source file.'
  }
  return $item.FullName
}
function VerifyJunction([string]$name){
  $source=Join-Path (Join-Path $test 'Server') $name
  $expected=Join-Path $preview $name
  $link=Get-Item -LiteralPath $source -Force -ErrorAction Stop
  if($link.LinkType -cne 'Junction' -or @($link.Target).Count -ne 1 -or
     -not [string]::Equals((Normal ([string](@($link.Target)[0]))),
                            (Normal $expected),[StringComparison]::OrdinalIgnoreCase)){
    Refuse 'The existing TEST data/uploads junction differs from the reviewed baseline.'
  }
  $null=ExactFolder $expected
  return $expected
}
function ListFiles([string]$root){
  $all=New-Object 'System.Collections.Generic.List[string]'
  $pending=New-Object 'System.Collections.Generic.Queue[string]'
  $pending.Enqueue((ExactFolder $root))
  while($pending.Count -gt 0){
    $folder=$pending.Dequeue()
    foreach($entry in @(Get-ChildItem -LiteralPath $folder -Force -ErrorAction Stop)){
      if($entry.Attributes -band [IO.FileAttributes]::ReparsePoint){
        Refuse 'Backup source contains an unexpected link.'
      }
      if($entry.PSIsContainer){$pending.Enqueue($entry.FullName)}
      elseif(-not $entry.PSIsContainer){$all.Add($entry.FullName)}
      else{Refuse 'Unsupported source entry.'}
      if($all.Count -gt 50000){Refuse 'Source file count exceeds reviewed limit.'}
    }
  }
  return @($all.ToArray() | Sort-Object)
}
function ShaFile([string]$file){
  $sha=[Security.Cryptography.SHA256]::Create()
  $stream=[IO.File]::Open($file,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
  try{return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-','').ToLowerInvariant()}
  finally{$stream.Dispose();$sha.Dispose()}
}
function CompareAndCopy([string]$source,[string]$destination){
  $items=@(ListFiles $source)
  foreach($file in $items){
    $relative=$file.Substring((Normal $source).Length).TrimStart('\')
    if([string]::IsNullOrWhiteSpace($relative)){Refuse 'Invalid relative backup file path.'}
    $target=Join-Path $destination $relative
    $parent=Split-Path -Parent $target
    if(-not [IO.Directory]::Exists($parent)){$null=New-Item -ItemType Directory -Path $parent -Force -ErrorAction Stop}
    $before=ShaFile $file
    Copy-Item -LiteralPath $file -Destination $target -ErrorAction Stop
    $after=ShaFile $file
    $saved=ShaFile $target
    if($before -cne $after -or $before -cne $saved){
      Refuse 'Source changed during capture or copied bytes differ.'
    }
  }
  $written=@(ListFiles $destination)
  if($items.Count -ne $written.Count){Refuse 'Snapshot file enumeration mismatched.'}
  return $items.Count
}
function CheckSqlite([string]$filename){
  $js="const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1],{readOnly:true});try{if(d.prepare('PRAGMA integrity_check').get().integrity_check!=='ok'||d.prepare('PRAGMA foreign_key_check').all().length!==0)process.exitCode=3}finally{d.close()}"
  & $node -e $js $filename 2>$null | Out-Null
  if($LASTEXITCODE -ne 0){Refuse 'Copied SQLite database failed independent integrity checks.'}
}
# Exact installed source and physical TEST roots, not arbitrary caller paths.
$null=ExactFolder $test
$null=ExactFolder $preview
$null=ExactFolder $recovery
$null=ExactFile $supervisor
$null=ExactFile $node
$actual=((& git -C $test rev-parse HEAD 2>$null)|Out-String).Trim()
if($LASTEXITCODE -ne 0 -or $actual -cne $ExpectedInstalledTestSha){
  Refuse 'Installed legacy TEST source SHA no longer matches reviewed baseline.'
}
$data=VerifyJunction 'data'
$uploads=VerifyJunction 'uploads'
$dist=ExactFolder (Join-Path $test 'dist')
$null=ExactFile (Join-Path $dist 'index.html')
$db=ExactFile (Join-Path $data 'calendar.db')
$dataItems=@(ListFiles $data)
$uploadFiles=@(ListFiles $uploads)
$distFiles=@(ListFiles $dist)
$testTask=Get-ScheduledTask -TaskName $testName -ErrorAction Stop
$updaterTask=Get-ScheduledTask -TaskName $updaterName -ErrorAction Stop
$liveTask=Get-ScheduledTask -TaskName 'Family Calendar Server' -ErrorAction Stop
$watchdogTask=Get-ScheduledTask -TaskName 'Family Calendar Watchdog' -ErrorAction Stop
$monthlyTask=Get-ScheduledTask -TaskName 'Family Calendar Monthly Restart' -ErrorAction Stop
if($liveTask.State -cne 'Running' -or @('Ready','Running') -cnotcontains [string]$watchdogTask.State -or
   @('Ready','Running') -cnotcontains [string]$monthlyTask.State){
  Refuse 'Shared LIVE or scheduled recovery protection differs from baseline.'
}
$monthlyInfo=Get-ScheduledTaskInfo -TaskName 'Family Calendar Monthly Restart' -ErrorAction Stop
if($monthlyInfo.NextRunTime -le (Get-Date).AddHours(2)){
  Refuse 'Monthly reboot timing cannot protect a coordinated backup window.'
}
$rules=@(& netsh interface portproxy show v4tov4)
if($LASTEXITCODE -ne 0){Refuse 'Cannot inspect existing TEST forwarding.'}
$legacy=@($rules | Where-Object {$_ -match '^\s*127\.0\.0\.1\s+13003\s+100\.124\.58\.19\s+13002\s*$'})
if($legacy.Count -ne 1){Refuse 'Existing TEST portproxy differs from reviewed baseline.'}
$listeners=@(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object {$_.LocalPort -in @(13002,13003,13004,13005,13006)})
$proxy=@($listeners | Where-Object {$_.LocalPort -eq 13003 -and $_.LocalAddress -eq '127.0.0.1'})
if($proxy.Count -ne 1){Refuse 'Existing TEST 13003 listener differs from reviewed baseline.'}
$old=@($listeners | Where-Object {$_.LocalPort -eq 13002})
$new=@($listeners | Where-Object {$_.LocalPort -in @(13004,13005,13006)})
$taskStates='test='+$testTask.State+' updater='+$updaterTask.State
if(-not $Capture){
  Write-Output ('OFFLINE_TEST_CAPTURE=NOT_STARTED | TEST_SOURCE_SHA='+$actual+' | UPLOAD_FILES='+$uploadFiles.Count+' | DIST_FILES='+$distFiles.Count+' | TASKS='+$taskStates+' | LEGACY_LISTENERS='+$old.Count+' | PRIVATE_LISTENERS='+$new.Count+' | READ_ONLY=YES | DEPLOYMENT_AUTHORIZED=NO')
  return
}
# An explicitly invoked -Capture does NOT stop tasks or disconnect TEST.
# The caller must independently approve shutdown and fence both TEST tasks.
# The normal read-only inventory may see SQLite WAL sidecars while
# legacy TEST is running. A cold capture may NOT omit those files.
if($dataItems.Count -ne 1 -or $dataItems[0] -cne $db){
  Refuse 'Legacy data folder contains unreviewed files, journal or WAL sidecars.'
}
if($testTask.State -cne 'Disabled' -or $updaterTask.State -cne 'Disabled' -or
   $old.Count -ne 0 -or $new.Count -ne 0){
  Refuse 'Both legacy TEST tasks must already be disabled, and all old/new TEST backends closed.'
}
# Reject an updater already running even if its scheduled task now says
# Disabled; otherwise it could independently relaunch the old TEST backend.
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$admin=([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if(-not $admin -or $identity.Name -eq 'NT AUTHORITY\SYSTEM'){
  Refuse 'Offline capture must be explicitly run as an elevated interactive administrator, never SYSTEM.'
}
$processes=@(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
  @('node.exe','powershell.exe','pwsh.exe') -icontains [string]$_.Name
})
foreach($process in $processes){
  if([string]::IsNullOrWhiteSpace([string]$process.CommandLine)){
    Refuse 'One active Node/PowerShell process cannot be inspected for TEST ownership.'
  }
  if([string]$process.CommandLine -match '(?i)family-calendar-test-security-stage|auto-test-deploy\.ps1|secure-test-auto-deploy\.ps1|start-secure-test-patched\.ps1'){
    Refuse 'Legacy TEST Node, updater or supervisor still has an active process.'
  }
}
# Lock the source SQLite against writers throughout the copy. The lock is
# not an OS-wide guarantee for uploads; only coordinated shutdown qualifies.
$guard=[IO.File]::Open($db,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
$folder=$null
try{
  $snapshotName='OFFLINE-LEGACY-TEST-'+(Get-Date -Format 'yyyyMMdd-HHmmss')+'-'+[guid]::NewGuid().ToString('N')
  $folder=Join-Path $recovery $snapshotName
  if([IO.Directory]::Exists($folder) -or [IO.File]::Exists($folder)){
    Refuse 'Recovery destination already exists.'
  }
  $null=New-Item -ItemType Directory -Path $folder -ErrorAction Stop
  foreach($name in @('uploads','dist')){$null=New-Item -ItemType Directory -Path (Join-Path $folder $name) -ErrorAction Stop}
  # Match the already-verified 34-file legacy recovery layout: database at
  # the snapshot ROOT, with sibling uploads/, dist/ and supervisor script.
  $copyDb=Join-Path $folder 'calendar.db'
  $dbBefore=ShaFile $db
  Copy-Item -LiteralPath $db -Destination $copyDb -ErrorAction Stop
  if($dbBefore -cne (ShaFile $db) -or $dbBefore -cne (ShaFile $copyDb)){
    Refuse 'Legacy database changed during offline capture.'
  }
  $copiedUploads=CompareAndCopy $uploads (Join-Path $folder 'uploads')
  $copiedDist=CompareAndCopy $dist (Join-Path $folder 'dist')
  $backupSupervisor=Join-Path $folder 'start-secure-test-patched.ps1'
  Copy-Item -LiteralPath $supervisor -Destination $backupSupervisor -ErrorAction Stop
  if((ShaFile $supervisor) -cne (ShaFile $backupSupervisor)){Refuse 'Supervisor backup changed.'}
  CheckSqlite $copyDb
  # Recheck every task/port that could have resumed while copying.
  if((Get-ScheduledTask -TaskName $testName -ErrorAction Stop).State -cne 'Disabled' -or
     (Get-ScheduledTask -TaskName $updaterName -ErrorAction Stop).State -cne 'Disabled' -or
     @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object {$_.LocalPort -in @(13002,13004,13005,13006)}).Count -ne 0){
    Refuse 'Legacy or private TEST process restarted during capture.'
  }
  # Store an independently usable local file-by-file SHA256 inventory; a
  # count-only receipt cannot prove uploaded data was preserved on restore.
  $manifestRows=New-Object 'System.Collections.Generic.List[object]'
  $manifestRows.Add(@{path='calendar.db';sha256=(ShaFile $copyDb)})
  foreach($rootName in @('uploads','dist')){
    $root=Join-Path $folder $rootName
    foreach($file in @(ListFiles $root)){
      $relative=$file.Substring((Normal $root).Length).TrimStart('\')
      $manifestRows.Add(@{path=($rootName+'/'+($relative -replace '\\','/'));sha256=(ShaFile $file)})
    }
  }
  $manifestRows.Add(@{path='start-secure-test-patched.ps1';sha256=(ShaFile $backupSupervisor)})
  $summary=@{
    kind='phase1-offline-legacy-test-snapshot-v1'
    sourceSha=$actual
    capturedAt=(Get-Date -Format o)
    databaseSha256=(ShaFile $copyDb)
    supervisorSha256=(ShaFile $backupSupervisor)
    uploads=$copiedUploads
    dist=$copiedDist
    sqliteIntegrity='ok'
    fileCount=$manifestRows.Count
    files=@($manifestRows.ToArray())
    restoreBootVerified=$false
    coordinatedCentralAndFamilySnapshot=$false
    safeToCutover=$false
    testDeploymentAuthorized=$false
    liveDeploymentAuthorized=$false
  }
  $manifest=Join-Path $folder 'OFFLINE-LEGACY-REVIEW.json'
  [IO.File]::WriteAllText($manifest,($summary|ConvertTo-Json -Depth 4),[Text.UTF8Encoding]::new($false))
  Write-Output ('OFFLINE_LEGACY_TEST_BACKUP=CAPTURED | FOLDER='+$folder+' | UPLOAD_FILES='+$copiedUploads+' | DIST_FILES='+$copiedDist+' | SQLITE=PASS | RESTORE_BOOT_VERIFIED=NO | TEST_CUTOVER_AUTHORIZED=NO | LIVE_UNCHANGED=YES')
}catch{
  if($folder -and [IO.Directory]::Exists($folder)){
    Write-Output ('OFFLINE_LEGACY_TEST_BACKUP=REQUIRES_MANUAL_REVIEW | FOLDER='+$folder+' | DO_NOT_USE_FOR_ROLLBACK=YES | AUTOMATIC_CLEANUP=NO')
  }
  throw
}finally{$guard.Dispose()}
