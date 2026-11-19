# Secure LIVE notification release from tested, isolated source.
# Preview by default. -Apply is required for the guarded LIVE cutover.
# Only reviewed notification UI, backend helpers and regression tests may change.
# Additive SQLite field migration requires independent backups and verification.
param([switch]$Apply)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$homeDir = $env:USERPROFILE
$live = Join-Path $homeDir 'Projects\family-calendar-live-auth-candidate'
$stage = Join-Path $homeDir 'Projects\family-calendar-live-notice-stage'
$baseline = '6e6713deced633f54f45c99d9bcd2e10342df4cd'
$branch = 'ops/live-event-notice-deploy-20261119'
$launcher = 'C:\ProgramData\FamilyCalendar\SecureLive\start-secure-live-node24.ps1'
$taskName = 'Family Calendar Server'
$autoTaskName = 'Family Calendar Secure LIVE Auto Deploy'
$watchdogName = 'Family Calendar Watchdog'
$backupRoot = Join-Path $homeDir 'CalendarBackups\LiveEventNotices'
$guardFile = Join-Path $backupRoot 'RELEASE-IN-PROGRESS.txt'
$oldDistPath = Join-Path $live 'dist'
$stageDistPath = Join-Path $stage 'dist'
$originalPath = $env:PATH
$env:PATH = 'C:\ProgramData\FamilyCalendar\Runtime\node-v24.22.1;' + $env:PATH

function Assert([bool]$condition,[string]$message) {
    if (-not $condition) { throw "STOP: $message" }
    Write-Host "PASS: $message"
}
function GitHead([string]$folder) {
    $sha = & git -C $folder rev-parse HEAD
    if ($LASTEXITCODE -ne 0 -or @($sha).Count -ne 1) { throw "Cannot resolve Git HEAD: $folder" }
    return ([string]$sha).Trim()
}
function GitBranch([string]$folder) {
    # An intentional detached checkout returns HEAD (rather than null).
    $name = @(& git -C $folder rev-parse --abbrev-ref HEAD)
    if ($LASTEXITCODE -ne 0 -or $name.Count -ne 1 -or [string]::IsNullOrWhiteSpace([string]$name[0])) {
        throw "Cannot resolve Git checkout type: $folder"
    }
    return ([string]$name[0]).Trim()
}
function Digest([string]$file) { return (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash }
function StatusCode([string]$url) {
    try { return [int](Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5).StatusCode }
    catch {
        if ($null -ne $_.Exception.Response) { return [int]$_.Exception.Response.StatusCode }
        return 0
    }
}
function ListenerPid {
    $owners = @(Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique)
    if ($owners.Count -ne 1) { throw "Expected one LIVE listener, got $($owners.Count)" }
    return [int]$owners[0]
}
function WaitStopped {
    for ($i=0; $i -lt 40; $i++) {
        $owners = @(Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty OwningProcess -Unique)
        if ($owners.Count -eq 0) { return }
        Start-Sleep -Milliseconds 500
    }
    throw 'LIVE did not stop. No source cutover attempted.'
}
function ValidateLive([bool]$newPidRequired,[int]$previousPid) {
    $pidNumber = ListenerPid
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $pidNumber"
    if ($null -eq $process -or $process.Name -ne 'node.exe' -or
        $process.CommandLine -notlike "*$live*Server*index.mjs*" -or
        $process.ExecutablePath -ine 'C:\ProgramData\FamilyCalendar\Runtime\node-v24.22.1\node.exe') {
        throw 'Port 3001 is not owned by the expected secure LIVE Node process.'
    }
    if ($newPidRequired -and $pidNumber -eq $previousPid) { throw 'New LIVE process was not started.' }
    $parent = Get-CimInstance Win32_Process -Filter "ProcessId = $($process.ParentProcessId)"
    if ($null -eq $parent -or $parent.Name -ne 'powershell.exe' -or
        $parent.CommandLine -notlike '*start-secure-live-node24.ps1*') {
        throw 'LIVE Node parent is not the secure PowerShell launcher.'
    }
    if ((StatusCode 'http://127.0.0.1:3001/api/health') -ne 200 -or
        (StatusCode 'http://127.0.0.1:3001/api/events') -ne 401 -or
        (StatusCode 'http://127.0.0.1:3001/') -ne 200) {
        throw 'LIVE health or anonymous-access protection failed.'
    }
    $auth = Invoke-RestMethod 'http://127.0.0.1:3001/api/auth/status' -TimeoutSec 5
    if ($auth.enabled -ne $true) { throw 'LIVE authentication is not enabled.' }
    if ((Get-ScheduledTask -TaskName $taskName).State -ne 'Running') {
        throw 'LIVE server task is not Running.'
    }
    return $pidNumber
}
function WaitHealthy([int]$oldPid) {
    for ($i=0; $i -lt 50; $i++) {
        Start-Sleep -Seconds 1
        try { return (ValidateLive $true $oldPid) } catch { if ($i -eq 49) { throw } }
    }
}
function DistManifest([string]$folder) {
    if (-not (Test-Path -LiteralPath (Join-Path $folder 'index.html'))) { throw "Missing dist/index.html: $folder" }
    $records = @()
    $rootPath = (Get-Item -LiteralPath $folder).FullName.TrimEnd('\') + '\'
    foreach ($file in @(Get-ChildItem -LiteralPath $folder -File -Recurse -Force)) {
        if (($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Linked asset is not allowed: $($file.FullName)"
        }
        $records += ($file.FullName.Substring($rootPath.Length) + '|' + (Digest $file.FullName))
    }
    return ($records | Sort-Object) -join "`n"
}

# A dedicated lock prevents concurrent secure LIVE/TEST release procedures.
$liveMutex = [Threading.Mutex]::new($false,'Global\FamilyCalendarSecureLiveAutoDeploy')
$testMutex = [Threading.Mutex]::new($false,'Global\FamilyCalendarSecureTestAutoDeploy')
$gotLiveLock = $false; $gotTestLock = $false
$autoPaused = $false; $watchdogPaused = $false; $serverTouched = $false
$gitChanged = $false; $distMoved = $false; $launcherChanged = $false
$oldPid = 0; $candidateSha = ''; $runBackup = ''; $oldDistBackup = ''
$plan = $null; $oldLauncherHash = ''; $oldHtmlHash = ''
$success = $false; $recovered = $false; $originalAutoEnabled = $false; $originalWatchdogEnabled = $false
try {
    try { $gotLiveLock = $liveMutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $gotLiveLock = $true }
    try { $gotTestLock = $testMutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $gotTestLock = $true }
    Assert ($gotLiveLock -and $gotTestLock) 'No simultaneous LIVE/TEST deployment lock'

    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $isAdmin = ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    Assert ($isAdmin -and $identity.Name -ne 'NT AUTHORITY\SYSTEM') 'Interactive administrator session'
    Assert ((Test-Path -LiteralPath (Join-Path $live '.git')) -and (Test-Path -LiteralPath (Join-Path $stage '.git'))) 'Secure LIVE and candidate worktrees exist'
    Assert ((GitHead $live) -ceq $baseline -and (GitBranch $live) -ceq 'HEAD') 'Running secure LIVE baseline is unchanged and detached'
    Assert ((GitBranch $stage) -ceq $branch) 'Correct isolated Lists staging branch'
    # Deploy only the exact CI-tested LIVE notification code; tooling is a separate commit.
    $candidateSha = '6e6713deced633f54f45c99d9bcd2e10342df4cd'
    $scriptHead = GitHead $stage
    Assert ($scriptHead -cmatch '^[a-f0-9]{40}$' -and $scriptHead -cne $candidateSha) 'GitHub deployment tool commit exists'
    & git -C $stage merge-base --is-ancestor $candidateSha $scriptHead
    Assert ($LASTEXITCODE -eq 0) 'Deployment tooling descends from exact tested UI commit'
    & git -C $stage merge-base --is-ancestor $baseline $candidateSha
    Assert ($LASTEXITCODE -eq 0) 'Notification candidate descends from installed secure LIVE'
    $toolDiff = @(& git -C $stage diff --name-only $candidateSha $scriptHead)
    Assert ($LASTEXITCODE -eq 0 -and ($toolDiff -join '|') -ceq 'scripts/deploy-live-event-notices.ps1') 'Only deployment tooling was added after candidate'
    $liveStatus = @(& git -C $live status --porcelain)
    Assert ($LASTEXITCODE -eq 0 -and $liveStatus.Count -eq 0) 'Secure LIVE checkout is clean'
    $stageStatus = @(& git -C $stage status --porcelain)
    Assert ($LASTEXITCODE -eq 0 -and $stageStatus.Count -eq 0) 'Candidate worktree is committed and clean'
    $changed = @(& git -C $stage diff --name-only $baseline $candidateSha | Sort-Object)
    Assert ($LASTEXITCODE -eq 0 -and ($changed -join '|') -ceq 'Server/event-assignment-notifications.mjs|Server/live-notification-inbox.mjs|Server/notification-event-mutation-capture.mjs|scripts/test-arney-planning.mjs|scripts/test-family-daily-notes.mjs|scripts/test-live-notification-inbox-pilot.mjs|scripts/test-notification-mutation-attribution.mjs|src/App.tsx|src/LiveInvitations.css|src/LiveInvitations.tsx|src/useAssignmentInbox.ts') 'Only reviewed LIVE notification and test files changed'

    $app = [IO.File]::ReadAllText((Join-Path $stage 'src\App.tsx'))
    $notices = [IO.File]::ReadAllText((Join-Path $stage 'src\LiveInvitations.tsx'))
    Assert ($app.Contains("suppressed={page === 'invitations' || showEventModal}") -and
        $notices.Contains('Changed:') -and $notices.Contains('Ask Again Later') -and
        $notices.Contains('setRemindLater(true)') -and $notices.Contains('props.onView(id)')) 'Approved compact reminder and View Event handoff exist'
    foreach ($path in @('Server\index.mjs','Server\family-auth.mjs','package.json','package-lock.json')) {
        Assert ((Digest (Join-Path $stage $path)) -ceq (Digest (Join-Path $live $path))) "Protected unchanged: $path"
    }
    Assert ((DistManifest $stageDistPath).Length -gt 0 -and (DistManifest $oldDistPath).Length -gt 0) 'Candidate and current frontend assets exist'
    Assert ((Digest (Join-Path $stageDistPath 'index.html')) -cne (Digest (Join-Path $oldDistPath 'index.html'))) 'Candidate frontend differs from installed frontend'

    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
    Assert ($task.Principal.UserId -eq 'SYSTEM' -and @($task.Actions).Count -eq 1 -and
        $task.Actions[0].Arguments -like '*start-secure-live-node24.ps1*') 'Secure LIVE SYSTEM task and launcher still configured'
    $auto = Get-ScheduledTask -TaskName $autoTaskName -ErrorAction Stop
    $watchdog = Get-ScheduledTask -TaskName $watchdogName -ErrorAction Stop
    Assert ($auto.State -notin @('Running','Queued') -and $watchdog.State -notin @('Running','Queued')) 'LIVE updater and watchdog idle'
    $originalAutoEnabled = [bool]$auto.Settings.Enabled
    $originalWatchdogEnabled = [bool]$watchdog.Settings.Enabled
    foreach ($file in @($guardFile,
        'C:\ProgramData\FamilyCalendar\SecureLiveAutoDeploy\DEPLOYMENT-IN-PROGRESS.json',
        'C:\ProgramData\FamilyCalendar\SecureLiveAutoDeploy\REQUIRES-REVIEW.txt',
        'C:\ProgramData\FamilyCalendar\LiveProfilesRelease\IN-PROGRESS.json')) {
        Assert (-not (Test-Path -LiteralPath $file)) "No unresolved release marker: $file"
    }
    $pendingBackups = @(Get-ScheduledTask | Where-Object { $_.TaskName -like 'Family Calendar Backup*' -and $_.State -eq 'Running' })
    Assert ($pendingBackups.Count -eq 0) 'No backup job currently running'
    . (Join-Path $stage 'scripts\secure-live-launcher-pins.ps1')
    Assert-SecureLiveLauncherPins $launcher $live
    # GitHub PR build must have succeeded for the exact release candidate SHA.
    $ciUrl = "https://api.github.com/repos/BSwiss89/family-calendar/actions/runs?head_sha=$candidateSha&per_page=100"
    $runs = Invoke-RestMethod -Uri $ciUrl -Headers @{ 'User-Agent'='FamilyCalendar-LiveNoticeRelease'; 'Accept'='application/vnd.github+json' } -TimeoutSec 20
    $matching = @($runs.workflow_runs | Where-Object {
        $_.name -eq 'Build Family Calendar' -and $_.head_sha -ceq $candidateSha -and
        $_.event -eq 'pull_request'
    } | Sort-Object id -Descending)
    Assert ($matching.Count -ge 1 -and $matching[0].status -eq 'completed' -and
        $matching[0].conclusion -eq 'success') 'Exact candidate Windows CI passed'
    $pinnedTest = '3fe30d0d418006b0cc521c676439b14ce93e860c'
    $testRoot = Join-Path $homeDir 'Projects\family-calendar-test-security-stage'
    Assert ((GitHead $testRoot) -ceq $pinnedTest) 'Accepted TEST revision remains installed'
    Assert ((Invoke-RestMethod 'http://127.0.0.1:13002/api/health' -TimeoutSec 5).status -eq 'ok') 'TEST remains healthy'
    $oldLauncherHash = Digest $launcher
    $oldHtmlHash = Digest (Join-Path $oldDistPath 'index.html')
    $oldPid = ValidateLive $false 0
    Write-Host "PASS: Secure LIVE authenticated and healthy (Node PID $oldPid)"
    Write-Host "Candidate SHA: $candidateSha"
    if (-not $Apply) {
        Write-Host 'LIVE_NOTICES_PREVIEW=PASS; LIVE_AND_TEST_UNCHANGED'
        return
    }

    # Reproduce output from committed source, and re-run regression tests before stopping LIVE.
    Push-Location $stage
    try {
        & node --test scripts/test-live-notification-inbox-pilot.mjs scripts/test-notification-mutation-attribution.mjs scripts/test-arney-planning.mjs scripts/test-family-daily-notes.mjs scripts/test-live-event-invitations.mjs scripts/test-family-auth.mjs scripts/test-household-profile-selection.mjs
        if ($LASTEXITCODE -ne 0) { throw 'Candidate LIVE notification, privacy and regression tests failed' }
        & npm.cmd run build
        if ($LASTEXITCODE -ne 0) { throw 'Candidate frontend build failed' }
    } finally { Pop-Location }
    Assert ((GitHead $stage) -ceq $scriptHead -and @(& git -C $stage status --porcelain).Count -eq 0) 'Candidate source unchanged after build'
    $candidateManifest = DistManifest $stageDistPath
    Assert ($candidateManifest.Length -gt 0) 'Candidate frontend manifest ready'
    Assert ((Digest (Join-Path $stageDistPath 'index.html')) -cne $oldHtmlHash) 'Candidate frontend hash differs from prior LIVE'

    # A verified consistent SQLite snapshot and recoverability test (no writes to LIVE DB).
    & node (Join-Path $homeDir 'Projects\family-calendar\scripts\verify-sqlite-recovery.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'SQLite snapshot and recovery verification failed' }
    Assert ((ValidateLive $false 0) -eq $oldPid) 'LIVE stayed healthy during preflight'
    Assert ((GitHead $live) -ceq $baseline -and (Digest $launcher) -ceq $oldLauncherHash) 'LIVE baseline unchanged before cutover'

    New-Item -ItemType Directory -Path $backupRoot -Force -ErrorAction Stop | Out-Null
    $runBackup = Join-Path $backupRoot ((Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0,8))
    New-Item -ItemType Directory -Path $runBackup -ErrorAction Stop | Out-Null
    & icacls.exe $runBackup '/inheritance:r' '/grant:r' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' "$($identity.Name):(OI)(CI)F" | Out-Null
    Assert ($LASTEXITCODE -eq 0) 'Recovery directory ACL restricted'
    $preparedDist = Join-Path $runBackup 'candidate-dist'
    $oldDistBackup = Join-Path $runBackup 'previous-dist'
    Copy-Item -LiteralPath $stageDistPath -Destination $preparedDist -Recurse -ErrorAction Stop
    Assert ((DistManifest $preparedDist) -ceq $candidateManifest) 'Staged frontend copied and verified'
    $plan = New-SecureLiveLauncherPlan $launcher $live $stage $preparedDist $runBackup
    Set-Content -LiteralPath (Join-Path $runBackup 'from.txt') -Value $baseline -Encoding Ascii
    Set-Content -LiteralPath (Join-Path $runBackup 'to.txt') -Value $candidateSha -Encoding Ascii
    New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
    Set-Content -LiteralPath $guardFile -Value "Cutover begun. Previous=$baseline Candidate=$candidateSha Recovery=$runBackup" -Encoding Ascii -ErrorAction Stop

    # Verified online SQLite backup before any service changes.
    $node = 'C:\ProgramData\FamilyCalendar\Runtime\node-v24.22.1\node.exe'
    $online = Join-Path $runBackup 'online-sqlite'
    New-Item -ItemType Directory -Path $online -ErrorAction Stop | Out-Null
    & $node (Join-Path $stage 'scripts\live-profile-db-check.mjs') backup (Join-Path $live 'Server\data\calendar.db') $online (Join-Path $testRoot 'Server\data\calendar.db') (Join-Path $live 'Server\uploads') (Join-Path $testRoot 'Server\uploads')
    Assert ($LASTEXITCODE -eq 0) 'Pre-cutover LIVE SQLite backup, integrity and isolated restore passed'
    # Fetch exact candidate code before stopping the running LIVE task.
    & git -C $live fetch --no-tags $stage $candidateSha
    Assert ($LASTEXITCODE -eq 0 -and (GitHead $live) -ceq $baseline) 'Exact source fetched; running LIVE unchanged'
    Assert (([string](& git -C $live rev-parse FETCH_HEAD)).Trim() -ceq $candidateSha) 'Fetched exact CI-tested SHA'

    Disable-ScheduledTask -TaskName $autoTaskName -ErrorAction Stop | Out-Null
    $autoPaused = $true
    Disable-ScheduledTask -TaskName $watchdogName -ErrorAction Stop | Out-Null
    $watchdogPaused = $true
    Assert ((Get-ScheduledTask -TaskName $watchdogName).State -ne 'Running') 'Watchdog paused before cutover'
    Disable-ScheduledTask -TaskName $taskName -ErrorAction Stop | Out-Null
    $serverTouched = $true
    Stop-ScheduledTask -TaskName $taskName -ErrorAction Stop
    WaitStopped
    Write-Host 'PASS: Previous LIVE listener safely stopped'
    # Cold backup includes all committed LIVE database activity up to shutdown.
    $cold = Join-Path $runBackup 'cold-sqlite'
    New-Item -ItemType Directory -Path $cold -ErrorAction Stop | Out-Null
    & $node (Join-Path $stage 'scripts\live-profile-db-check.mjs') backup (Join-Path $live 'Server\data\calendar.db') $cold (Join-Path $testRoot 'Server\data\calendar.db') (Join-Path $live 'Server\uploads') (Join-Path $testRoot 'Server\uploads')
    Assert ($LASTEXITCODE -eq 0) 'Cold LIVE SQLite backup and independent restore passed'
    $uploads = Join-Path $live 'Server\uploads'
    $savedUploads = Join-Path $runBackup 'uploads'
    New-Item -ItemType Directory -Path $savedUploads -ErrorAction Stop | Out-Null
    $nestedLinks = @(Get-ChildItem -LiteralPath $uploads -Recurse -Force -ErrorAction Stop | Where-Object {
        ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
    })
    Assert ($nestedLinks.Count -eq 0) 'No nested LIVE upload links'
    foreach ($item in @(Get-ChildItem -LiteralPath $uploads -Force -ErrorAction Stop)) {
        Copy-Item -LiteralPath $item.FullName -Destination $savedUploads -Recurse -ErrorAction Stop
    }
    $sourceFiles = @(Get-ChildItem -LiteralPath $uploads -Recurse -File -Force)
    $backupFiles = @(Get-ChildItem -LiteralPath $savedUploads -Recurse -File -Force)
    Assert ($sourceFiles.Count -eq $backupFiles.Count) 'All LIVE uploads backed up'
    foreach ($file in $sourceFiles) {
        $relative = $file.FullName.Substring($uploads.Length).TrimStart([char]'\')
        $copy = Join-Path $savedUploads $relative
        Assert ((Test-Path -LiteralPath $copy) -and (Digest $file.FullName) -ceq (Digest $copy)) 'LIVE upload backup hash verified'
    }

    # Switch reviewed frontend and backend helpers; preserve all existing LIVE data.
    & git -C $live -c advice.detachedHead=false checkout --quiet --detach $candidateSha
    if ($LASTEXITCODE -ne 0) { throw 'Could not switch secure LIVE notification source' }
    $gitChanged = $true
    Assert ((GitHead $live) -ceq $candidateSha) 'Secure LIVE source switched to CI-tested notification candidate'
    Move-Item -LiteralPath $oldDistPath -Destination $oldDistBackup -ErrorAction Stop
    $distMoved = $true
    Move-Item -LiteralPath $preparedDist -Destination $oldDistPath -ErrorAction Stop
    Assert ((DistManifest $oldDistPath) -ceq $candidateManifest) 'Approved frontend installed with exact asset hashes'
    Set-SecureLiveLauncher $plan.Candidate $launcher
    $launcherChanged = $true
    Assert-SecureLiveLauncherPins $launcher $live
    Enable-ScheduledTask -TaskName $taskName -ErrorAction Stop | Out-Null
    Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
    $newPid = WaitHealthy $oldPid
    & $node (Join-Path $stage 'scripts\live-profile-db-check.mjs') verify (Join-Path $live 'Server\data\calendar.db') $cold (Join-Path $testRoot 'Server\data\calendar.db') (Join-Path $live 'Server\uploads') (Join-Path $testRoot 'Server\uploads')
    Assert ($LASTEXITCODE -eq 0) 'LIVE SQLite integrity and prior row counts preserved'
    Assert ((GitHead $testRoot) -ceq $pinnedTest) 'TEST checkout remains unchanged'
    Assert ((GitHead $live) -ceq $candidateSha -and (DistManifest $oldDistPath) -ceq $candidateManifest) 'Secure LIVE source and frontend match approved release'
    Assert ((Get-ScheduledTask -TaskName $taskName).State -eq 'Running') 'Secure LIVE SYSTEM task running'
    if ($originalWatchdogEnabled) { Enable-ScheduledTask -TaskName $watchdogName -ErrorAction Stop | Out-Null }
    $watchdogPaused = $false
    # Do not automatically re-enable LIVE auto-deploy against an outdated approval baseline.
    Remove-Item -LiteralPath $guardFile -ErrorAction Stop
    $success = $true
    Write-Host "LIVE_NOTICES_LIVE_DEPLOYMENT=PASS | SHA=$candidateSha | PID=$newPid"
    Write-Host 'AUTHENTICATION=PASS | SQLITE_BACKUP_AND_VERIFY=PASS | UPLOADS_BACKED_UP=PASS | TEST_UNCHANGED=PASS'
    Write-Host "RECOVERY_FOLDER=$runBackup"
    Write-Host 'LIVE_AUTO_DEPLOY=DISABLED; approval baseline must be updated before re-enabling.'
} catch {
    $failure = $_.Exception.Message
    Write-Warning "LIVE_NOTICES_RELEASE_FAILED: $failure"
    if ($serverTouched) {
        try {
            $portOwners = @(Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue |
                Select-Object -ExpandProperty OwningProcess -Unique)
            if ($portOwners.Count -gt 0) {
                if ($portOwners.Count -ne 1) { throw 'Unexpected listeners; cannot safely roll back' }
                $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($portOwners[0])"
                if ($null -eq $process -or $process.CommandLine -notlike "*$live*Server*index.mjs*") {
                    throw 'Unexpected port owner; cannot safely stop it for rollback'
                }
                Stop-ScheduledTask -TaskName $taskName -ErrorAction Stop
                WaitStopped
            }
            if ($gitChanged) {
                & git -C $live -c advice.detachedHead=false checkout --quiet --detach $baseline
                if ($LASTEXITCODE -ne 0 -or (GitHead $live) -cne $baseline) { throw 'Git rollback failed' }
            }
            if ($distMoved) {
                if (Test-Path -LiteralPath $oldDistPath) {
                    Move-Item -LiteralPath $oldDistPath -Destination (Join-Path $runBackup 'failed-dist') -ErrorAction Stop
                }
                Move-Item -LiteralPath $oldDistBackup -Destination $oldDistPath -ErrorAction Stop
            }
            if ($null -ne $plan) { Set-SecureLiveLauncher $plan.Previous $launcher }
            Assert ((GitHead $live) -ceq $baseline -and (Digest $launcher) -ceq $oldLauncherHash -and
                (Digest (Join-Path $oldDistPath 'index.html')) -ceq $oldHtmlHash) 'Previous code, launcher and frontend recovered'
            Assert-SecureLiveLauncherPins $launcher $live
            Enable-ScheduledTask -TaskName $taskName -ErrorAction Stop | Out-Null
            $stillListening = @(Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue |
                Select-Object -ExpandProperty OwningProcess -Unique)
            if ($stillListening.Count -eq 0) { Start-ScheduledTask -TaskName $taskName -ErrorAction Stop }
            $newPid = WaitHealthy $oldPid
            $recovered = $true
            Write-Warning "ROLLBACK=PASS | previous secure LIVE recovered under PID $newPid"
        } catch {
            Write-Warning "ROLLBACK=INCOMPLETE | $($_.Exception.Message) | KEEP AUTO DEPLOY DISABLED"
        }
    }
    if ($recovered -or -not $serverTouched) {
        if ($watchdogPaused -and $originalWatchdogEnabled) {
            try { Enable-ScheduledTask -TaskName $watchdogName -ErrorAction Stop | Out-Null } catch { Write-Warning 'Watchdog needs manual re-enable' }
        }
        if ($autoPaused -and $originalAutoEnabled) {
            try { Enable-ScheduledTask -TaskName $autoTaskName -ErrorAction Stop | Out-Null } catch { Write-Warning 'LIVE auto deploy needs manual re-enable' }
        }
        if (Test-Path -LiteralPath $guardFile) { Remove-Item -LiteralPath $guardFile -ErrorAction SilentlyContinue }
    } else {
        Write-Warning "RECOVERY_HOLD=$guardFile"
    }
    throw "Secure LIVE notification release failed. $failure"
} finally {
    if ($gotTestLock) { $testMutex.ReleaseMutex() }
    if ($gotLiveLock) { $liveMutex.ReleaseMutex() }
    $testMutex.Dispose(); $liveMutex.Dispose()
    $env:PATH = $originalPath
}