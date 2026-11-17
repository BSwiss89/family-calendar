# Change ONLY the existing secure TEST updater's polling interval.
# Read-only by default. Does not install a new task, change accounts or touch LIVE.
[CmdletBinding()]
param([switch]$Apply)

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
function Assert-Task([object]$snapshot,[string]$identity,[switch]$RequireIdle) {
    $task = $snapshot.Task
    $actions = @($task.Actions)
    if ($task.TaskPath -ne '\' -or $actions.Count -ne 1 -or
        -not [string]::Equals([string]$task.Principal.UserId,$identity,[StringComparison]::OrdinalIgnoreCase) -or
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
Assert-Task $before $identity.Name -RequireIdle
$checkedAt = Get-Date -Format o
Write-Host "TEST_POLL_PREFLIGHT=PASS | checked_at=$checkedAt | current=$($before.Interval) | target=PT1M | task_identity=UNCHANGED | changes_made=NONE"
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
    Assert-Task $before $identity.Name -RequireIdle
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
    try {
        $null = & schtasks.exe /Change /TN $taskName /RI 1 2>&1
        if ($LASTEXITCODE -ne 0) { $changeError = "schtasks exit code $LASTEXITCODE" }
    } catch {
        $changeError = 'Windows rejected the task update'
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
    Assert-Task $after $identity.Name
    Write-Host ("TEST_POLL_APPLY=PASS | checked_at=" + (Get-Date -Format o) + " | interval=PT1M | task_identity=UNCHANGED | live_sha=$liveSha | test_sha=$testSha | backup=$backup")
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
