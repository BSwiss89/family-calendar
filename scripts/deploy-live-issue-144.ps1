# User-approved ISSUE #144 LIVE backend release. Default mode is read-only.
# Independent script/release source; never use the frontend-only auto controller.
param([Parameter(Mandatory=$true)][string]$CandidateSha,[Parameter(Mandatory=$true)][string]$CandidatePath,[switch]$Apply)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$from='61397b2b44f5ef6d1595b59ea8149e523c5a3acc'
$expectedTest='181d80befa02ef24dace9212ab140ea3f33e528a'
$stage=(Resolve-Path -LiteralPath $CandidatePath -ErrorAction Stop).Path
$live='C:\Users\bobby\Projects\family-calendar-live-auth-candidate'
$test='C:\Users\bobby\Projects\family-calendar-test-security-stage'
$launcher='C:\ProgramData\FamilyCalendar\SecureLive\start-secure-live-node24.ps1'
$testLauncher='C:\ProgramData\FamilyCalendar\SecureTest\start-secure-test-patched.ps1'
$node='C:\ProgramData\FamilyCalendar\Runtime\node-v24.22.1\node.exe'
$key='C:\ProgramData\FamilyCalendar\SecureLive\PushSecrets\vapid-private.key'
$state='C:\ProgramData\FamilyCalendar\LiveIssue144Release'
$journal=Join-Path $state 'IN-PROGRESS.json'
$taskName='Family Calendar Server'
$auto='Family Calendar Secure LIVE Auto Deploy'
$testAuto='Family Calendar Secure TEST Auto Deploy'
$watchdog='Family Calendar Watchdog'
$tz=[TimeZoneInfo]::FindSystemTimeZoneById('Central Standard Time')
$priorPath=$env:PATH
$liveMutex=[Threading.Mutex]::new($false,'Global\FamilyCalendarSecureLiveAutoDeploy')
$testMutex=[Threading.Mutex]::new($false,'Global\FamilyCalendarSecureTestAutoDeploy')
$liveLocked=$false; $testLocked=$false; $paused=$false; $autoPaused=$false
$touched=$false; $changed=$false; $oldMoved=$false; $opened=$false
$success=$false; $rollbackOk=$false; $backup=$null; $plan=$null
$oldDist=$null; $newDist=$null

function Report([string]$message) {
    $now = [TimeZoneInfo]::ConvertTimeFromUtc([DateTime]::UtcNow,$tz)
    Write-Host "$($now.ToString('yyyy-MM-dd HH:mm:ss')) America/Chicago | $message"
}
function Assert([bool]$ok,[string]$message) { if (-not $ok) { throw $message } }
function Hash([string]$file) { (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash }
function Head([string]$folder) {
    $v = & git -C $folder rev-parse HEAD
    Assert ($LASTEXITCODE -eq 0) 'Cannot read source SHA.'
    return ([string]$v).Trim()
}
function Manifest([string]$folder) {
    Assert (Test-Path -LiteralPath $folder -PathType Container) "Directory missing: $folder"
    # Build relative names from directory entries, independent of Windows short
    # paths, provider normalization and a legitimate root uploads junction.
    $walk = {
        param([string]$dir,[string]$prefix)
        foreach ($item in Get-ChildItem -LiteralPath $dir -Force) {
            Assert (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) 'Nested storage links require review.'
            if ($item.PSIsContainer) { & $walk $item.FullName ($prefix + $item.Name + '\') }
            else { "$prefix$($item.Name)|$(Hash $item.FullName)" }
        }
    }
    return (@(& $walk $folder '' | Sort-Object) -join "`n")
}
function CopyVerified([string]$source,[string]$destination) {
    Assert (-not (Test-Path -LiteralPath $destination)) 'Backup destination already exists.'
    $links=@(Get-ChildItem -LiteralPath $source -Recurse -Force | Where-Object {
        ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
    })
    Assert ($links.Count -eq 0) 'Nested storage links require review.'
    # Source may itself be TEST's uploads junction. Always create a real backup
    # directory and copy its contents, never an alias back to the active uploads.
    New-Item -ItemType Directory -Path $destination -ErrorAction Stop | Out-Null
    foreach ($item in Get-ChildItem -LiteralPath $source -Force) {
        Copy-Item -LiteralPath $item.FullName -Destination $destination -Recurse -ErrorAction Stop
    }
    Assert ((Manifest $source) -ceq (Manifest $destination)) 'Directory backup hash verification failed.'
}
function Status([string]$url) {
    try { return [int](Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 4).StatusCode }
    catch {
        if ($null -ne $_.Exception.Response) { return [int]$_.Exception.Response.StatusCode }
        return 0
    }
}
function Listeners([int]$port) {
    $lookupErrors=@()
    $rows=@(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue -ErrorVariable lookupErrors)
    $unexpected=@($lookupErrors | Where-Object { $_.CategoryInfo.Category -ne 'ObjectNotFound' })
    Assert ($unexpected.Count -eq 0) "TCP ownership lookup failed on port $port."
    return $rows
}
function OwnedProcess([int]$port,[string]$root,[bool]$optional=$false) {
    for ($attempt=0; $attempt -lt 10; $attempt++) {
        $rows = @(Listeners $port)
        if ($optional -and $rows.Count -eq 0) { return $null }
        Assert ($rows.Count -eq 1) "Unexpected listeners on port $port."
        $owner = $rows[0].OwningProcess
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$owner" -ErrorAction Stop
        # A task stop can destroy Node between the TCP and CIM snapshots.
        # Confirm disappearance/ownership again before returning or signalling it.
        $current = @(Listeners $port)
        if ($optional -and $current.Count -eq 0) { return $null }
        Assert ($current.Count -le 1) "Unexpected listeners on port $port."
        if ($current.Count -eq 1 -and $current[0].OwningProcess -eq $owner -and
            $null -ne $proc -and -not [string]::IsNullOrWhiteSpace($proc.ExecutablePath) -and
            -not [string]::IsNullOrWhiteSpace($proc.CommandLine)) {
            $nodeMatch = $proc.ExecutablePath -ieq $node
            $sourceMatch = $proc.CommandLine -like "*$root*"
            Assert ($nodeMatch -and $sourceMatch) "Unexpected process on port $port; PID=$owner; NODE_MATCH=$nodeMatch; SOURCE_MATCH=$sourceMatch."
            return $proc
        }
        Start-Sleep -Milliseconds 200
    }
    throw "Process metadata/ownership did not stabilize on port $port; no process was signalled."
}
function TestStamp {
    $p=OwnedProcess 13002 $test
    return "$($p.ProcessId)|$($p.CreationDate.ToUniversalTime().Ticks)|$(Head $test)|$(Hash $testLauncher)|$(Manifest "$test\dist")"
}
function Healthy {
    $null=OwnedProcess 3001 $live
    foreach ($url in @('http://127.0.0.1:3001/api/health','https://laptop1502.tail3a2e53.ts.net:8443/api/health',
        'https://laptop1502.tail3a2e53.ts.net/api/health')) {
        Assert ((Status $url) -eq 200) "Health failed: $url"
    }
    foreach ($route in @('events','live-event-invitations','live-push/config')) {
        Assert ((Status "https://laptop1502.tail3a2e53.ts.net:8443/api/$route") -eq 401) "LIVE anonymous gate failed: $route"
    }
    Assert ((Status 'https://laptop1502.tail3a2e53.ts.net/api/events') -eq 401) 'TEST anonymous gate failed.'
    $auth=Invoke-RestMethod 'http://127.0.0.1:3001/api/auth/status' -TimeoutSec 5
    Assert ($auth.enabled -eq $true) 'LIVE authentication is not enabled.'
}
function StopLive {
    $null=OwnedProcess 3001 $live $true
    if ((Get-ScheduledTask -TaskName $taskName).State -in @('Running','Queued')) {
        Stop-ScheduledTask -TaskName $taskName -ErrorAction Stop
    }
    for ($i=0;$i -lt 15;$i++) {
        if ((Get-ScheduledTask -TaskName $taskName).State -notin @('Running','Queued')) { break }
        Start-Sleep -Seconds 1
    }
    Assert ((Get-ScheduledTask -TaskName $taskName).State -notin @('Running','Queued')) 'LIVE task did not stop.'
    for ($i=0;$i -lt 20;$i++) {
        if (@(Listeners 3001).Count -eq 0) { return }
        Start-Sleep -Milliseconds 250
    }
    $p=OwnedProcess 3001 $live $true
    if ($null -ne $p) { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop }
    for ($i=0;$i -lt 10;$i++) {
        if ($null -eq (OwnedProcess 3001 $live $true)) { return }
        Start-Sleep -Milliseconds 500
    }
    throw 'LIVE listener did not stop.'
}
function StartLive {
    Assert-SecureLiveLauncherPins $launcher $live
    Enable-ScheduledTask -TaskName $taskName -ErrorAction Stop | Out-Null
    Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
    for ($i=0;$i -lt 30;$i++) {
        Start-Sleep -Seconds 1
        try {
            Healthy
            Assert ((Get-ScheduledTask -TaskName $taskName).State -eq 'Running') 'LIVE task is not running.'
            return
        } catch {}
        if ($i % 5 -eq 4) { Report "LIVE_START_WAIT=$($i+1)" }
    }
    throw 'LIVE startup verification failed.'
}
function SwitchLive([string]$sha) {
    & git -C $live -c advice.detachedHead=false checkout --quiet --detach $sha
    Assert ($LASTEXITCODE -eq 0 -and (Head $live) -eq $sha) 'LIVE source checkout failed.'
}
function WriteJournal($entry) {
    $stream=[IO.File]::Open($journal,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try {
        $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($entry | ConvertTo-Json))
        $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true)
    } finally { $stream.Dispose() }
}
try {
    try { $liveLocked=$liveMutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $liveLocked=$true }
    try { $testLocked=$testMutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $testLocked=$true }
    Assert ($liveLocked -and $testLocked) 'Another deployment holds a site lock.'
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
    Assert (([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) -and
        $identity.Name -ne 'NT AUTHORITY\SYSTEM') 'Use Administrator PowerShell as Bobby.'
    Assert ($CandidateSha -ceq '6683fd722a4fbbecbf5a1207f49bb0409832caf2' -and (Head $stage) -eq $CandidateSha -and
        (Head $live) -eq $from -and (Head $test) -eq $expectedTest) 'Installed or candidate source baseline changed.'
    Assert ($stage -ine $live -and $stage -ine $test -and $stage -ne (Split-Path $PSScriptRoot -Parent)) 'Use isolated candidate source.'
    Assert (-not (Get-Item -LiteralPath $stage -Force).LinkType) 'Candidate checkout must not be a link.'
    Assert (([string](& git -C $stage branch --show-current)).Trim() -eq 'fix/live-profile-photo-normalization-20261104') 'Candidate must be checked out from reviewed LIVE release branch.'
    # Import only after the exact candidate SHA, branch, and isolated path were verified.
    . (Join-Path $stage 'scripts\live-profile-launcher-plan.ps1')
    foreach ($folder in @($stage,$live,$test)) {
        $dirty=@(& git -C $folder status --porcelain --untracked-files=no)
        Assert ($LASTEXITCODE -eq 0 -and $dirty.Count -eq 0) 'Tracked source is dirty.'
    }
    & git -C $stage merge-base --is-ancestor $from $CandidateSha
    Assert ($LASTEXITCODE -eq 0) 'Candidate is not based on installed LIVE.'
    $allowed=@('.github/workflows/build.yml','Server/event-assignment-notifications.mjs',
        'Server/index.mjs','Server/live-event-invitations.mjs','Server/live-household-event-join.mjs',
        'Server/notification-event-mutation-capture.mjs','Server/notification-mutation-attribution.mjs',
        'scripts/test-notification-mutation-attribution.mjs')
    $files=@(& git -C $stage diff --name-only $from $CandidateSha | Sort-Object)
    Assert ($LASTEXITCODE -eq 0 -and ($files -join '|') -ceq (($allowed | Sort-Object) -join '|')) 'Candidate scope differs from the reviewed release.'
    foreach ($path in @('Server\family-auth.mjs','package.json','package-lock.json','public\family-push-sw.js')) {
        Assert ((Hash (Join-Path $stage $path)) -eq (Hash (Join-Path $live $path))) "Protected LIVE feature changed: $path"
    }
    foreach ($path in @($journal,'C:\ProgramData\FamilyCalendar\SecureLiveAutoDeploy\DEPLOYMENT-IN-PROGRESS.json',
        'C:\ProgramData\FamilyCalendar\SecureLiveAutoDeploy\REQUIRES-REVIEW.txt',
        'C:\ProgramData\FamilyCalendar\ProfileMonthTest\IN-PROGRESS.json',
        'C:\ProgramData\FamilyCalendar\ProfilePhotoTest\IN-PROGRESS.json',
        'C:\ProgramData\FamilyCalendar\SecureTestAutoDeploy\IN-PROGRESS.txt',
        'C:\ProgramData\FamilyCalendar\SecureTestAutoDeploy\REQUIRES-REVIEW.txt',
        'C:\ProgramData\FamilyCalendar\LiveProfilesRelease\IN-PROGRESS.json')) {
        Assert (-not (Test-Path -LiteralPath $path)) "Recovery state requires inspection: $path"
    }
    $task=Get-ScheduledTask -TaskName $taskName
    Assert ($task.State -eq 'Running' -and $task.Settings.Enabled) 'LIVE server task is not enabled/running.'
    $actions=($task.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments)" }) -join ' '
    Assert ($actions -like "*$launcher*") 'LIVE task launcher changed.'
    Assert (-not (Get-ScheduledTask -TaskName $testAuto).Settings.Enabled) 'TEST updater must remain disabled.'
    $updater=Get-ScheduledTask -TaskName $auto
    Assert ($updater.Settings.Enabled -and $updater.State -eq 'Ready') 'LIVE updater must be enabled and idle before manual release.'
    $wd=Get-ScheduledTask -TaskName $watchdog
    Assert ($wd.Settings.Enabled -and $wd.State -eq 'Ready') 'Watchdog must be enabled and idle.'
    Assert (-not (Get-Item -LiteralPath "$live\dist" -Force).LinkType) 'LIVE frontend cannot be a link.'
    Assert-SecureLiveLauncherPins $launcher $live
    Healthy
    $testBefore=TestStamp
    $oldManifest=Manifest "$live\dist"
    $launcherHash=Hash $launcher
    $keyHash=Hash $key
    $oldIndex=Hash "$live\Server\index.mjs"
    $oldProcess=OwnedProcess 3001 $live
    $processStamp="$($oldProcess.ProcessId)|$($oldProcess.CreationDate.ToUniversalTime().Ticks)"
    $ci=Invoke-RestMethod 'https://api.github.com/repos/BSwiss89/family-calendar/actions/runs/42395345955' -Headers @{'User-Agent'='FamilyCalendar-Issue144LiveRelease'} -TimeoutSec 25
    Assert ($ci.head_sha -eq $CandidateSha -and $ci.name -eq 'Build Family Calendar' -and
        $ci.status -eq 'completed' -and $ci.conclusion -eq 'success') 'Exact LIVE candidate Windows build failed.'
    # Confirm TEST acceptance target and unchanged dependency manifests.
    foreach ($package in @('package.json','package-lock.json')) {
        Assert ((Hash (Join-Path $stage $package)) -eq (Hash (Join-Path $live $package))) "Protected dependency changed: $package"
    }
    Report 'LIVE_ISSUE144_PREFLIGHT=PASS | EXACT_HEAD_CI=PASS | LIVE_AND_TEST_HEALTH=PASS'
    if (-not $Apply) { Report 'CHANGES_MADE=NONE'; return }
    $env:PATH=(Split-Path $node)+';'+$env:PATH
    Push-Location $stage
    try {
        & npm.cmd ci --no-audit --no-fund
        Assert ($LASTEXITCODE -eq 0) 'Isolated npm ci failed.'
        & $node --test scripts/test-notification-mutation-attribution.mjs scripts/test-person-photo-edit.mjs scripts/test-family-auth.mjs scripts/test-household-profile-selection.mjs scripts/test-live-event-invitations.mjs scripts/test-live-household-event-join.mjs scripts/test-live-informational-push.mjs scripts/test-live-notification-inbox-pilot.mjs
        Assert ($LASTEXITCODE -eq 0) 'Candidate auth/profile/photo/notification tests failed.'
        & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts/test-live-profile-launcher-plan.ps1
        Assert ($LASTEXITCODE -eq 0) 'Launcher activation/rollback fixtures failed.'
        & npm.cmd run build
        Assert ($LASTEXITCODE -eq 0) 'Candidate frontend build failed.'
    } finally { Pop-Location }
    Healthy
    $p=OwnedProcess 3001 $live
    Assert ((Head $live) -eq $from -and (TestStamp) -ceq $testBefore -and (Hash $launcher) -eq $launcherHash -and
        "$($p.ProcessId)|$($p.CreationDate.ToUniversalTime().Ticks)" -ceq $processStamp -and
        (Manifest "$live\dist") -ceq $oldManifest) 'Installed state changed during staging.'
    $tag=(Get-Date -Format 'yyyyMMdd-HHmmss')+'-'+[guid]::NewGuid().ToString('N').Substring(0,6)
    $backup="C:\Users\bobby\CalendarBackups\LiveIssue144\$tag"
    New-Item -ItemType Directory -Path $backup | Out-Null
    & icacls.exe $backup '/inheritance:r' '/grant:r' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' "$($identity.Name):(OI)(CI)F" | Out-Null
    Assert ($LASTEXITCODE -eq 0) 'Cannot restrict recovery directory.'
    foreach ($name in @($taskName,$auto,$watchdog)) {
        Export-ScheduledTask -TaskName $name | Set-Content (Join-Path $backup "$name.xml") -Encoding UTF8
    }
    Copy-Item "$live\Server\index.mjs" "$backup\previous-index.mjs"
    $plan=New-LiveProfileLauncherPlan $launcher $live $stage $backup
    $newIndex=Hash "$stage\Server\index.mjs"
    $newDist=Join-Path $live "dist-profiles-$tag"
    CopyVerified "$stage\dist" $newDist
    foreach ($file in Get-ChildItem "$live\dist\assets" -File) {
        $dest=Join-Path "$newDist\assets" $file.Name
        if (-not (Test-Path -LiteralPath $dest)) { Copy-Item -LiteralPath $file.FullName -Destination $dest }
    }
    $candidateManifest=Manifest $newDist
    $oldDist=Join-Path $backup 'active-dist-before-cutover'
    & git -C $live fetch --quiet $stage $CandidateSha
    Assert ($LASTEXITCODE -eq 0) 'Candidate object transfer failed.'
    New-Item -ItemType Directory -Path $state -Force | Out-Null
    WriteJournal @{from=$from;to=$CandidateSha;backup=$backup;stage=$stage;oldDist=$oldDist;newDist=$newDist;launcher=$launcher;phase='prepared'}
    $opened=$true
    $autoPaused=$true
    Disable-ScheduledTask -TaskName $auto | Out-Null
    $paused=$true
    Disable-ScheduledTask -TaskName $watchdog | Out-Null
    Assert ((Get-ScheduledTask -TaskName $watchdog).State -ne 'Running') 'Watchdog raced staging; abort before LIVE stop.'
    $touched=$true
    Disable-ScheduledTask -TaskName $taskName | Out-Null
    StopLive
    CopyVerified "$live\dist" "$backup\previous-dist"
    & $node --no-warnings "$stage\scripts\live-profile-db-check.mjs" backup "$live\Server\data\calendar.db" $backup "$test\Server\data\calendar.db" "$live\Server\uploads" "$test\Server\uploads"
    Assert ($LASTEXITCODE -eq 0) 'Stopped LIVE database backup/restore verification failed.'
    CopyVerified "$live\Server\uploads" "$backup\uploads"
    $uploadManifest=Manifest "$live\Server\uploads"
    $changed=$true
    SwitchLive $CandidateSha
    Assert ((Hash "$live\Server\index.mjs") -eq $newIndex) 'Installed backend differs from candidate.'
    Move-Item "$live\dist" $oldDist
    $oldMoved=$true
    Move-Item $newDist "$live\dist"
    Set-SecureLiveLauncher $plan.Candidate $launcher
    Assert-SecureLiveLauncherPins $launcher $live
    Report 'LIVE_BACKEND_AND_ALL_FOUR_STARTUP_PINS=PASS'
    StartLive
    & $node --no-warnings "$stage\scripts\live-profile-db-check.mjs" verify "$live\Server\data\calendar.db" $backup "$test\Server\data\calendar.db" "$live\Server\uploads" "$test\Server\uploads"
    Assert ($LASTEXITCODE -eq 0) 'Post-start LIVE data verification failed.'
    Assert ((Head $live) -eq $CandidateSha -and (Manifest "$live\dist") -ceq $candidateManifest -and
        (Manifest "$live\Server\uploads") -ceq $uploadManifest -and (TestStamp) -ceq $testBefore -and
        (Hash $key) -eq $keyHash) 'Post-start source/frontend/uploads/TEST/push-key verification failed.'
    Assert (-not (Get-ScheduledTask -TaskName $auto).Settings.Enabled -and
        -not (Get-ScheduledTask -TaskName $testAuto).Settings.Enabled) 'Unexpected updater state.'
    Enable-ScheduledTask -TaskName $watchdog | Out-Null
    Assert ((Get-ScheduledTask -TaskName $watchdog).Settings.Enabled) 'Watchdog restoration failed.'
    $paused=$false
    Remove-Item -LiteralPath $journal
    $opened=$false; $success=$true
    Report "LIVE_ISSUE144_DEPLOYMENT=PASS | SHA=$CandidateSha"
    Report 'TEST_UNCHANGED=PASS | DATA_AND_UPLOADS_PRESERVED=PASS | LIVE_HEALTH_AND_AUTH=PASS | WATCHDOG=Enabled'
    Report 'LIVE_AUTO_DEPLOY=Disabled | NEXT=Update approved baseline receipt before enabling'
    Report "RECOVERY_FOLDER=$backup"
} catch {
    Report "LIVE_ISSUE144_DEPLOYMENT=FAIL | $($_.Exception.Message)"
    if ($touched) {
        try {
            Disable-ScheduledTask -TaskName $watchdog | Out-Null
            Disable-ScheduledTask -TaskName $taskName | Out-Null
            StopLive
            if ($changed) {
                SwitchLive $from
                [IO.File]::WriteAllBytes("$live\Server\index.mjs",[IO.File]::ReadAllBytes("$backup\previous-index.mjs"))
                Set-SecureLiveLauncher $plan.Previous $launcher
            }
            if ($oldMoved) {
                if (Test-Path "$live\dist") { Move-Item "$live\dist" "$backup\rejected-dist" }
                Move-Item $oldDist "$live\dist"
            }
            Assert ((Head $live) -eq $from -and (Hash "$live\Server\index.mjs") -eq $oldIndex -and
                (Hash $launcher) -eq $launcherHash -and (Manifest "$live\dist") -ceq $oldManifest) 'Rollback baseline verification failed.'
            # Additive attribution table may remain after rollback; preserve the newest LIVE
    # data, events and sessions rather than overwriting with the earlier snapshot.
            StartLive
            Assert ((TestStamp) -ceq $testBefore -and (Hash $key) -eq $keyHash) 'TEST or push key changed during recovery.'
            $rollbackOk=$true
            if ($opened) { Remove-Item -LiteralPath $journal; $opened=$false }
            Report 'LIVE_ISSUE144_ROLLBACK=PASS | DATABASE_AND_UPLOADS_PRESERVED'
        } catch {
            Report "LIVE_PROFILE_ROLLBACK=FAIL | $($_.Exception.Message) | MANUAL_RECOVERY_REQUIRED"
            if ($backup) {
                [IO.File]::WriteAllText('C:\ProgramData\FamilyCalendar\SecureLiveAutoDeploy\REQUIRES-REVIEW.txt',"LIVE issue #144 recovery failed. Review $backup and $journal before clearing hold.")
            }
        }
    } elseif ($opened) { Remove-Item -LiteralPath $journal; $opened=$false }
    if ($backup) { Report "RECOVERY_FOLDER=$backup" }
    throw
} finally {
    if ($paused -and (-not $touched -or $rollbackOk -or $success)) {
        try { Enable-ScheduledTask -TaskName $watchdog | Out-Null; Report 'WATCHDOG_RESTORED=PASS' }
        catch { Report 'WATCHDOG_RESTORED=FAIL' }
    } elseif ($paused) { Report 'WATCHDOG_LEFT_DISABLED=Manual recovery required' }
    if ($autoPaused -and (-not $touched -or $rollbackOk)) {
        try { Enable-ScheduledTask -TaskName $auto | Out-Null; Report 'LIVE_UPDATER_RESTORED=PASS' }
        catch { Report 'LIVE_UPDATER_RESTORED=FAIL' }
    }
    $env:PATH=$priorPath
    if ($testLocked) { $testMutex.ReleaseMutex() }
    if ($liveLocked) { $liveMutex.ReleaseMutex() }
    $testMutex.Dispose(); $liveMutex.Dispose()
}
