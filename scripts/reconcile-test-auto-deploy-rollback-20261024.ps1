# One-time repair after the verified 2026-10-24 rollback.
# Changes only the scheduled TEST auto-deploy runner and its trusted pin helper.
# It does not restart either application or clear unverified recovery state.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$home='C:\Users\bobby'
$test=Join-Path $home 'Projects\family-calendar-test-security-stage'
$live=Join-Path $home 'Projects\family-calendar-live-auth-candidate'
$expected='5b25639ece34c4ec706ea35822877c5300c1ea0b'
$failed='0f55d51666c12eeed1bb8646b53b6bf843146df0'
$supervisor='C:\ProgramData\FamilyCalendar\SecureTest\start-secure-test-patched.ps1'
$node='C:\ProgramData\FamilyCalendar\Runtime\node-v24.22.1\node.exe'
$state='C:\ProgramData\FamilyCalendar\SecureTestAutoDeploy'
$taskName='Family Calendar Secure TEST Auto Deploy'
$hold=Join-Path $state 'REQUIRES-REVIEW.txt'
$journal=Join-Path $state 'IN-PROGRESS.txt'
$runner=Join-Path $state 'auto-test-deploy.ps1'
$helper=Join-Path $state 'secure-test-source-pins.ps1'
$newRunner=Join-Path $PSScriptRoot 'secure-test-auto-deploy.ps1'
$newHelper=Join-Path $PSScriptRoot 'secure-test-source-pins.ps1'
$backup=Join-Path $state 'backups\20261024-112903-5b25639'
$id=[Security.Principal.WindowsIdentity]::GetCurrent()
if ($id.Name -eq 'NT AUTHORITY\SYSTEM' -or
    -not [string]::Equals($env:USERPROFILE,$home,[StringComparison]::OrdinalIgnoreCase) -or
    -not ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run as the elevated laptop user, not SYSTEM.'
}
$shaTest=(& git -C $test rev-parse HEAD).Trim()
$shaLive=(& git -C $live rev-parse HEAD).Trim()
if ($shaTest -ne $expected -or $shaLive -ne $expected) {
    throw 'TEST/LIVE versions no longer match the known-good rollback state.'
}
foreach ($p in @($test,$live)) {
    if (@(& git -C $p status --porcelain --untracked-files=no | Where-Object { $_ }).Count -gt 0) {
        throw 'Tracked application code changed after rollback.'
    }
}
foreach ($item in @(
    @{name='data'; expected=(Join-Path $home 'Projects\family-calendar-preview\Server\data')},
    @{name='uploads'; expected=(Join-Path $home 'Projects\family-calendar-preview\Server\uploads')}
)) {
    $actual=Get-Item -LiteralPath (Join-Path $test "Server\$($item.name)") -Force
    if ($actual.LinkType -ne 'Junction' -or
        -not [string]::Equals([string](@($actual.Target)[0]),$item.expected,[StringComparison]::OrdinalIgnoreCase)) {
        throw "TEST $($item.name) storage mapping changed."
    }
}
if (!(Test-Path -LiteralPath $hold) -or !(Test-Path -LiteralPath $journal)) {
    throw 'Expected review hold and interrupted transaction record are missing.'
}
$holdText=Get-Content -LiteralPath $hold -Raw
$journalText=Get-Content -LiteralPath $journal -Raw
foreach ($needle in @('rollbackHealthy=True',"Old=$expected","target=$failed","backup=$backup")) {
    if (!$holdText.Contains($needle)) { throw "Rollback hold missing confirmation: $needle" }
}
foreach ($needle in @("from $expected","to $failed","backup $backup")) {
    if (!$journalText.Contains($needle)) { throw "Transaction journal missing confirmation: $needle" }
}
foreach ($file in @(
    (Join-Path $backup 'data\calendar.db'),
    (Join-Path $backup 'dist\index.html'),
    $supervisor, $runner, $newRunner, $newHelper
)) {
    if (!(Test-Path -LiteralPath $file)) { throw "Expected recovery or installer file missing: $file" }
}
& $node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1],{readOnly:true});const result=d.prepare('PRAGMA quick_check').get();d.close();if(result.quick_check!=='ok')process.exit(2)" (Join-Path $backup 'data\calendar.db')
if ($LASTEXITCODE -ne 0) { throw 'Stopped TEST backup failed SQLite integrity check.' }
. $newHelper
Assert-SecureTestSourcePins $supervisor $test
$active=Get-NetTCPConnection -State Listen -LocalPort 13002 -ErrorAction Stop | Select-Object -First 1
$p=Get-CimInstance Win32_Process -Filter "ProcessId = $($active.OwningProcess)"
if ($null -eq $p -or -not [string]::Equals($p.ExecutablePath,$node,[StringComparison]::OrdinalIgnoreCase) -or
    $p.CommandLine -notlike '*family-calendar-test-security-stage*') { throw 'Active TEST listener does not match secured rollback.' }
$base="http://$($active.LocalAddress):13002"
$health=Invoke-RestMethod "$base/api/health" -TimeoutSec 5
$auth=Invoke-RestMethod "$base/api/auth/status" -TimeoutSec 5
if ($health.status -ne 'ok' -or $auth.enabled -ne $true) { throw 'TEST security/health verification failed.' }
try {
    $null=Invoke-WebRequest "$base/api/events" -TimeoutSec 5 -UseBasicParsing
    throw 'Anonymous TEST calendar access was allowed.'
} catch {
    if (!$_.Exception.Response -or [int]$_.Exception.Response.StatusCode -ne 401) { throw }
}
foreach ($file in @($newRunner,$newHelper)) {
    $tokens=$null
    $errors=$null
    [System.Management.Automation.Language.Parser]::ParseFile($file,[ref]$tokens,[ref]$errors) | Out-Null
    if ($errors -and $errors.Count -gt 0) { throw "Repair file has a PowerShell syntax error: $file" }
}
$autoTask=Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
if (@($autoTask.Actions | Where-Object { $_.Arguments -like '*SecureTestAutoDeploy\auto-test-deploy.ps1*' }).Count -ne 1) {
    throw 'Existing auto-deployer task points to an unexpected script.'
}
if ($autoTask.State -eq 'Running') { throw 'Automatic deploy check is still running; retry when it finishes.' }
foreach ($name in @('Family Calendar Auto Preview','Family Calendar Auto Deploy')) {
    $oldTask=Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if ($oldTask -and $oldTask.State -ne 'Disabled') { throw "Legacy automation task $name unexpectedly active." }
}
Write-Host 'PASS: known-good rollback, supervisor pins, authentication and SQLite backup verified.'
Disable-ScheduledTask -TaskName $taskName -ErrorAction Stop | Out-Null
$archive=Join-Path $state ('reviewed-rollback-'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
try {
    $task=Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
    if ($task.State -eq 'Running') { throw 'Updater was running. Retry after it finishes.' }
    New-Item -ItemType Directory -Path $archive -Force | Out-Null
    Copy-Item -LiteralPath $runner -Destination (Join-Path $archive 'old-auto-test-deploy.ps1') -ErrorAction Stop
    if (Test-Path -LiteralPath $helper) {
        Copy-Item -LiteralPath $helper -Destination (Join-Path $archive 'old-secure-test-source-pins.ps1') -ErrorAction Stop
    }
    Copy-Item -LiteralPath $newRunner -Destination $runner -Force -ErrorAction Stop
    Copy-Item -LiteralPath $newHelper -Destination $helper -Force -ErrorAction Stop
    foreach ($pair in @(
        @{installed=$runner;source=$newRunner},
        @{installed=$helper;source=$newHelper}
    )) {
        if ((Get-FileHash $pair.installed).Hash -ne (Get-FileHash $pair.source).Hash) {
            throw 'Updater file copy verification failed.'
        }
    }
    Move-Item -LiteralPath $hold -Destination (Join-Path $archive 'REQUIRES-REVIEW.txt') -ErrorAction Stop
    Move-Item -LiteralPath $journal -Destination (Join-Path $archive 'IN-PROGRESS.txt') -ErrorAction Stop
    Write-Host 'PASS: prior rollback holds archived, not deleted.'
    Write-Host "Recovery archive: $archive"
} catch {
    Write-Warning ('Repair stopped: '+$_.Exception.Message)
    # Preserve/reinstate a review hold when the repair cannot complete.
    if (!(Test-Path -LiteralPath $hold)) {
        Set-Content -LiteralPath $hold -Value ('Repair incomplete at '+(Get-Date -Format o)+'. Inspect '+$archive) -Encoding UTF8
    }
    throw
} finally {
    Enable-ScheduledTask -TaskName $taskName -ErrorAction Stop | Out-Null
}
Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
Write-Host 'TEST AUTO DEPLOY REPAIR INSTALLED. First post-recovery check requested.'
Write-Host 'Neither Calendar application nor its HTTPS routing was restarted by this repair.'
