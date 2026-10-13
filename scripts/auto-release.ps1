# Approved GitHub main -> guarded live release.
# Intended for a Windows Scheduled Task running as the laptop's administrator user.
# A successful pull-request merge is the authorization to deploy. No phone/desktop needed.
# Requires an SSH-agent credential that works with BatchMode=yes, without passphrase prompts.
# Failures during testing/deployment disable retries until a human investigates.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$homePath = 'C:\Users\bobby'
$test = Join-Path $homePath 'Projects\family-calendar-test'
$live = Join-Path $homePath 'Projects\family-calendar'
$release = Join-Path $test 'scripts\release.ps1'
$state = Join-Path $homePath 'AppData\Local\FamilyCalendar\auto-release'
$holdFile = Join-Path $state 'REQUIRES-REVIEW.txt'
$inProgressFile = Join-Path $state 'DEPLOYMENT-IN-PROGRESS.txt'
$logFile = Join-Path $state 'auto-release.log'
$sshKey = Join-Path $homePath '.ssh\id_ed25519_github'

if (-not [string]::Equals($env:USERPROFILE, $homePath, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Unexpected task profile. Automatic deployment requires the bobby user, not SYSTEM.'
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$admin = ([Security.Principal.WindowsPrincipal]$identity).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
)
if (-not $admin -or $identity.Name -eq 'NT AUTHORITY\SYSTEM') {
    throw 'Automatic release must run elevated as the authorized laptop user, not SYSTEM.'
}

New-Item -ItemType Directory -Path $state -Force | Out-Null

$mutex = [System.Threading.Mutex]::new($false, 'Global\FamilyCalendarAutoRelease')
$locked = $false
$transcribing = $false
try {
    try {
        $locked = $mutex.WaitOne(0)
    } catch [System.Threading.AbandonedMutexException] {
        $locked = $true
    }
    if (-not $locked) { return }
    Start-Transcript -LiteralPath $logFile -Append -ErrorAction Stop | Out-Null
    $transcribing = $true
    Write-Host ("AUTOMATIC FAMILY CALENDAR CHECK " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))

    if (Test-Path -LiteralPath $holdFile) {
        Write-Host 'AUTO DEPLOYMENT PAUSED due to prior failure. Review REQUIRES-REVIEW.txt; nothing changed.'
        return
    }
    if (Test-Path -LiteralPath $inProgressFile) {
        Write-Warning 'A previous deployment was interrupted. DEPLOYMENT-IN-PROGRESS.txt exists; no automatic retry.'
        return
    }
    foreach ($folder in @($live, $test)) {
        if (-not (Test-Path (Join-Path $folder '.git'))) { throw "Git repository missing: $folder" }
        $status = @(& git -C $folder status --porcelain)
        if ($LASTEXITCODE -ne 0 -or $status.Count -ne 0) {
            throw "Git checkout has uncommitted changes: $folder"
        }
        $url = (& git -C $folder remote get-url origin).Trim()
        if ($LASTEXITCODE -ne 0 -or $url -ne 'git@github.com:BSwiss89/family-calendar.git') {
            throw "Unexpected GitHub remote: $folder"
        }
    }

    if (-not (Test-Path -LiteralPath $sshKey)) { throw 'Configured GitHub SSH key missing.' }
    # Avoid overriding the SSH configuration that already works with git pull.
    # The read-only remote check has a timeout and never contacts the live database.
    . (Join-Path $test 'scripts\get-github-refs.ps1')
    try {
        $remote = @(Get-FamilyCalendarGitHubRefs -Repository $test -Type Main)
    } catch {
        Write-Warning "GitHub temporarily unavailable: $($_.Exception.Message). No changes; retry next scheduled run."
        return
    }
    if ($remote.Count -ne 1) {
        throw 'GitHub returned an unexpected main reference count.'
    }
    $approved = ($remote[0] -split '\s+')[0]
    if ($approved -notmatch '^[a-f0-9]{40}$') {
        throw 'GitHub returned an invalid main SHA.'
    }
    $current = (& git -C $live rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the live commit.' }
    if ($current -eq $approved) {
        Write-Host "Live already matches GitHub main $($approved.Substring(0,7))."
        return
    }

    if (-not (Test-Path -LiteralPath $release)) {
        throw 'Approved release script missing from test checkout.'
    }
    Write-Host "New approved version $($approved.Substring(0,7)); current $($current.Substring(0,7))."
    Write-Host 'Running existing guarded frontend/backend release and recovery checks...'
    $busyBackup = @(Get-ScheduledTask | Where-Object { $_.TaskName -like 'Family Calendar Backup*' -and $_.State -eq 'Running' })
    if ($busyBackup.Count -gt 0) {
        Write-Host 'Backup task is still running; defer deployment until the next scheduled check.'
        return
    }
    Set-Content -LiteralPath $inProgressFile -Value "Started $(Get-Date -Format o); current $current; approved $approved" -Encoding UTF8

    $exitCode = 1
    try {
        & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $release -Apply
        $exitCode = $LASTEXITCODE
    } catch {
        Write-Warning "Guarded release threw: $($_.Exception.Message)"
    }
    if ($exitCode -ne 0) {
        $msg = @(
            "Automatic deployment requires manual investigation."
            "Time: $(Get-Date -Format o)"
            "Previous live: $current"
            "GitHub main: $approved"
            "Guarded release exit code: $exitCode"
            "No automatic retries will occur until this file is reviewed and removed manually."
            "Check: $logFile"
            "Do not delete this hold if the guarded release reported incomplete rollback."
        ) -join [Environment]::NewLine
        Set-Content -LiteralPath $holdFile -Value $msg -Encoding UTF8
        throw 'Release failed; automatic retries are now disabled.'
    }
    $deployed = (& git -C $live rev-parse HEAD).Trim()
    $tested = (& git -C $test rev-parse HEAD).Trim()
    $health = Invoke-RestMethod 'http://127.0.0.1:3001/api/health' -TimeoutSec 10
    if ($deployed -ne $tested -or $health.status -ne 'ok') {
        $msg = "Post-release validation failed at $(Get-Date -Format o). Live: $deployed; tested version: $tested. Check $logFile."
        Set-Content -LiteralPath $holdFile -Value $msg -Encoding UTF8
        throw 'Post-release check failed; further automatic releases disabled.'
    }
    Remove-Item -LiteralPath $inProgressFile -Force
    Write-Host "AUTOMATIC DEPLOYMENT PASSED: $($deployed.Substring(0,7))"
} catch {
    # Task Scheduler records failure and the log preserves diagnostics.
    Write-Warning ("AUTO RELEASE ERROR: " + $_.Exception.Message)
    throw
} finally {
    if ($transcribing) { Stop-Transcript | Out-Null }
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
