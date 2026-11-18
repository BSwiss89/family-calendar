# Change ONLY the existing secure TEST updater's polling interval.
# Read-only by default. Does not install a new task, change accounts or touch LIVE.
[CmdletBinding()]
param([switch]$Apply,[switch]$SelfTestPrincipal)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$taskName = 'Family Calendar Secure TEST Auto Deploy'
$state = 'C:\ProgramData\FamilyCalendar\SecureTestAutoDeploy'
$runner = Join-Path $state 'auto-test-deploy.ps1'
$hold = Join-Path $state 'REQUIRES-REVIEW.txt'
$journal = Join-Path $state 'IN-PROGRESS.txt'
$homePath = 'C:\Users\bobby'
$test = Join-Path $homePath 'Projects\family-calendar-test-security-stage'
$live = Join-Path $homePath 'Projects\family-calendar-live-auth-candidate'

function Get-Head([string]$path) {
    $head = (& git -C $path rev-parse HEAD)
    if ($LASTEXITCODE -ne 0 -or $head -notmatch '^[a-f0-9]{40}$') {
        throw "Cannot verify protected checkout HEAD: $path"
    }
    return $head.Trim()
}
function Get-TaskSnapshot {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
    $xmlText = Export-ScheduledTask -TaskName $taskName -ErrorAction Stop
    [xml]$xml = $xmlText
    $intervals = @($xml.SelectNodes("//*[local-name()='TimeTrigger']/*[local-name()='Repetition']/*[local-name()='Interval']"))
    $triggers = @($xml.SelectNodes("//*[local-name()='Triggers']/*"))
    if ($triggers.Count -ne 1 -or $intervals.Count -ne 1) {
        throw 'Unexpected task trigger layout; refusing schedule changes.'
    }
    return [pscustomobject]@{ Task=$task; Xml=$xml; XmlText=$xmlText; Interval=$intervals[0].InnerText; IntervalNode=$intervals[0] }
}
# Windows may display the same task owner as "bobby" or "LAPTOP1502\bobby".
# Compare the SID. An unresolvable principal must fail closed.
function Test-TaskPrincipalIsCurrentUser([string]$taskUser) {
    if ([string]::IsNullOrWhiteSpace($taskUser)) { throw 'Scheduled-task principal is missing.' }
    try {
        if ($taskUser -match '^S-\d+-\d+(?:-\d+)+$') {
            $taskSid = [Security.Principal.SecurityIdentifier]::new($taskUser)
        } else {
            $taskSid = ([Security.Principal.NTAccount]::new($taskUser)).Translate([Security.Principal.SecurityIdentifier])
        }
        $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
        if ($null -eq $currentSid) { throw 'Current Windows SID unavailable.' }
        return [string]::Equals($taskSid.Value,$currentSid.Value,[StringComparison]::Ordinal)
    } catch {
        throw 'Could not independently verify the scheduled-task account SID.'
    }
}

# Isolated CI regression; no access to installed Calendar services.
if ($SelfTestPrincipal) {
    if ($Apply) { throw 'Principal self-test cannot be combined with -Apply.' }
    $current = [Security.Principal.WindowsIdentity]::GetCurrent()
    $shortName = ($current.Name -split '\\')[-1]
    if (!(Test-TaskPrincipalIsCurrentUser $current.Name) -or
        !(Test-TaskPrincipalIsCurrentUser $shortName) -or
        !(Test-TaskPrincipalIsCurrentUser $current.User.Value) -or
        (Test-TaskPrincipalIsCurrentUser 'S-1-5-21-0-0-0-1234567')) {
        throw 'Windows principal SID matching regression failed.'
    }
    $rejected = $false
    try { $null = Test-TaskPrincipalIsCurrentUser 'NonexistentCalendarUser_123456_987654' }
    catch { $rejected = $true }
    if (!$rejected) { throw 'Unresolvable account was not rejected.' }
    Write-Host 'TEST_TASK_PRINCIPAL_SID_SELFTEST=PASS | qualified=PASS | short_name=PASS | sid=PASS | wrong_sid=BLOCKED | unknown_user=BLOCKED | changes_made=NONE'
    return
}
function Assert-Task([object]$snapshot,[switch]$RequireIdle) {
    $task = $snapshot.Task
    $actions = @($task.Actions)
    if ($task.TaskPath -ne '\' -or $actions.Count -ne 1 -or
        -not (Test-TaskPrincipalIsCurrentUser ([string]$task.Principal.UserId)) -or
        $task.Principal.LogonType.ToString() -ne 'Password' -or
        $task.Principal.RunLevel.ToString() -ne 'Highest' -or
        $task.Settings.MultipleInstances.ToString() -ne 'IgnoreNew' -or
        $task.State.ToString() -notin @('Ready','Running') -or
        ($RequireIdle -and $task.State.ToString() -ne 'Ready') -or
        $actions[0].Execute -notlike '*\powershell.exe' -or
        $actions[0].Arguments -notlike ('*-File "' + $runner + '"*') -or
        -not [string]::Equals([string]$actions[0].WorkingDirectory,$state,[StringComparison]::OrdinalIgnoreCase)) {
        throw 'The existing TEST updater identity/action/settings/state are unexpected.'
    }
    if ($snapshot.Interval -notin @('PT15M','PT1M')) {
        throw "Unexpected TEST polling interval: $($snapshot.Interval)"
    }
}
function Same-ExceptInterval([object]$old,[object]$new) {
    # The only allowed XML difference is PT15M -> PT1M in the existing trigger.
    $new.IntervalNode.InnerText = $old.Interval
    return $old.Xml.OuterXml -ceq $new.Xml.OuterXml
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if ($identity.Name -eq 'NT AUTHORITY\SYSTEM' -or
    -not [string]::Equals($env:USERPROFILE,$homePath,[StringComparison]::OrdinalIgnoreCase) -or
    -not ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Use elevated PowerShell as the existing authorized laptop user, never SYSTEM.'
}
if ((Test-Path -LiteralPath $hold) -or (Test-Path -LiteralPath $journal)) {
    throw 'Secure TEST updater review/in-progress marker exists. No schedule changes.'
}
if (!(Test-Path -LiteralPath $runner) -or
    !(Test-Path -LiteralPath (Join-Path $state 'secure-test-source-pins.ps1'))) {
    throw 'Trusted installed TEST updater files missing.'
}
$secureTest = Get-ScheduledTask -TaskName 'Family Calendar Secure TEST' -ErrorAction Stop
if ($secureTest.State.ToString() -ne 'Running') {
    throw 'Secure TEST server is not running. No schedule change.'
}
foreach ($oldName in @('Family Calendar Auto Preview','Family Calendar Auto Deploy')) {
    $oldTask = Get-ScheduledTask -TaskName $oldName -ErrorAction SilentlyContinue
    if ($oldTask -and $oldTask.State.ToString() -ne 'Disabled') {
        throw "Legacy updater unexpectedly active: $oldName"
    }
}
$before = Get-TaskSnapshot
Assert-Task $before -RequireIdle
$checkedAt = Get-Date -Format o
Write-Host "TEST_POLL_PREFLIGHT=PASS | checked_at=$checkedAt | current=$($before.Interval) | target=PT1M | task_identity=UNCHANGED | changes_made=NONE"
# Faster polling must not accelerate an unreviewed direct push to an unprotected branch.
# GitHub's public branch snapshot must expose an enforced Windows build check.
if ($Apply -and $before.Interval -ne 'PT1M') {
    $uri = 'https://api.github.com/repos/BSwiss89/family-calendar/branches/test-release'
    try {
        $branchState = Invoke-RestMethod -Uri $uri -Headers @{ 'User-Agent'='FamilyCalendar-SafePolling-Preflight'; 'Accept'='application/vnd.github+json' } -TimeoutSec 15
    } catch {
        throw 'Cannot verify GitHub TEST branch protection. No schedule change.'
    }
    $requiredContexts = @($branchState.protection.required_status_checks.contexts)
    $requiredContexts += @($branchState.protection.required_status_checks.checks | ForEach-Object { $_.context })
    if ($branchState.name -ne 'test-release' -or $branchState.protected -ne $true -or
        -not ($requiredContexts -contains 'frontend-build')) {
        throw 'GitHub test-release lacks verified branch protection and the required Windows build check. No faster polling.'
    }
}
if (!$Apply -or $before.Interval -eq 'PT1M') {
    if ($Apply -and $before.Interval -eq 'PT1M') {
        Write-Host "TEST_POLL_APPLY=ALREADY_CONFIGURED | checked_at=$checkedAt | interval=PT1M"
    }
    return
}

# The existing updater uses this same global mutex. Never edit its task during a deployment.
$mutex = [System.Threading.Mutex]::new($false,'Global\FamilyCalendarSecureTestAutoDeploy')
$locked = $false
try {
    try { $locked = $mutex.WaitOne(0) }
    catch [System.Threading.AbandonedMutexException] {
        throw 'An updater may have crashed while holding the deployment mutex; review first.'
    }
    if (!$locked) { throw 'Secure TEST updater is active; retry after it finishes.' }
    if ((Test-Path -LiteralPath $hold) -or (Test-Path -LiteralPath $journal)) {
        throw 'Secure TEST deployment started or is on hold; refusing schedule change.'
    }
    $before = Get-TaskSnapshot
    Assert-Task $before -RequireIdle
    if ($before.Interval -ne 'PT15M') { throw 'Polling interval changed during preflight.' }
    $runnerHash = (Get-FileHash -LiteralPath $runner -Algorithm SHA256).Hash
    $testSha = Get-Head $test
    $liveSha = Get-Head $live
    $folder = Join-Path $state 'polling-task-backups'
    New-Item -ItemType Directory -Path $folder -Force | Out-Null
    $backup = Join-Path $folder ("before-one-minute-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + ".xml")
    if (Test-Path -LiteralPath $backup) { throw 'Task backup name collision.' }
    [System.IO.File]::WriteAllText($backup,$before.XmlText,[System.Text.UTF8Encoding]::new($false))
    # schtasks /change /ri changes an existing repetition interval without replacing its principal.
    # Never supply credentials, a different principal, a new action, or task registration.
    $changeError = $null
    # Windows PowerShell 5.1 can convert a native program's stderr into a
    # terminating ErrorRecord when the caller sets ErrorActionPreference=Stop.
    # Capture schtasks output and exit code without suppressing the diagnostic.
    # This temporary preference applies ONLY to the original guarded change.
    $originalErrorAction = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $changeOutput = @(& schtasks.exe /Change /TN $taskName /RI 1 2>&1)
        $changeExitCode = $LASTEXITCODE
        if ($changeExitCode -ne 0) {
            $changeDetails = (($changeOutput | ForEach-Object { $_.ToString() }) -join ' ').Trim()
            if ($changeDetails.Length -gt 800) { $changeDetails = $changeDetails.Substring(0,800) }
            $changeError = "schtasks exit code $changeExitCode; Windows says: $changeDetails"
        }
    } catch {
        $changeError = "schtasks invocation failed: $($_.Exception.Message)"
    } finally {
        $ErrorActionPreference = $originalErrorAction
    }
    $after = Get-TaskSnapshot
    $safe = Same-ExceptInterval $before $after
    if ($changeError -and $after.Interval -eq 'PT1M') {
        if (!(Test-Path -LiteralPath $hold)) {
            Set-Content -LiteralPath $hold -Value "Windows reported schedule update failure even though it now polls every minute. Inspect task and backup $backup before resuming releases." -Encoding UTF8
        }
        throw 'POLLING_CHANGE_HOLD: Ambiguous Windows update result requires manual review.'
    }
    if ($changeError -or !$safe -or
        $after.Interval -notin @('PT15M','PT1M') -or
        (Get-FileHash -LiteralPath $runner -Algorithm SHA256).Hash -ne $runnerHash -or
        (Get-Head $test) -ne $testSha -or (Get-Head $live) -ne $liveSha) {
        if (!$safe -or $after.Interval -notin @('PT15M','PT1M') -or
            (Get-FileHash -LiteralPath $runner -Algorithm SHA256).Hash -ne $runnerHash -or
            (Get-Head $test) -ne $testSha -or (Get-Head $live) -ne $liveSha) {
            # Existing fail-closed marker blocks new TEST releases until reviewed.
            if (!(Test-Path -LiteralPath $hold)) {
                Set-Content -LiteralPath $hold -Value "TEST polling task unexpectedly changed; inspect backup $backup and the task manually. Do not clear without review." -Encoding UTF8
            }
            throw 'POLLING_CHANGE_HOLD: Unexpected task/runtime drift. Manual review required.'
        }
        throw "POLLING_CHANGE_NOT_APPLIED: $changeError. Task remains at $($after.Interval). Original task XML: $backup"
    }
    if ($after.Interval -ne 'PT1M') {
        throw "POLLING_CHANGE_NOT_APPLIED: Windows retained $($after.Interval); original task XML: $backup"
    }
    Assert-Task $after
    Write-Host ("TEST_POLL_APPLY=PASS | checked_at=" + (Get-Date -Format o) + " | interval=PT1M | task_identity=UNCHANGED | live_sha=$liveSha | test_sha=$testSha | backup=$backup")
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
