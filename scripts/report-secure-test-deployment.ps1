# Read-only one-line report for the existing secure TEST auto-deploy task.
# Does not contact GitHub or change tasks, files, checkout state or LIVE.
[CmdletBinding()]
param(
    [ValidatePattern('^[a-fA-F0-9]{40}$')][string]$ExpectedTestSha,
    [ValidatePattern('^[a-fA-F0-9]{40}$')][string]$ExpectedLiveSha
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$homePath = 'C:\Users\bobby'
$state = 'C:\ProgramData\FamilyCalendar\SecureTestAutoDeploy'
$test = Join-Path $homePath 'Projects\family-calendar-test-security-stage'
$live = Join-Path $homePath 'Projects\family-calendar-live-auth-candidate'
$problems = [System.Collections.Generic.List[string]]::new()
$checkedAt = Get-Date -Format o
$testSha = 'UNKNOWN'
$liveSha = 'UNKNOWN'
$lastSuccessSha = 'UNKNOWN'
$lastSuccessAt = 'UNKNOWN'
$lastBackup = 'UNKNOWN'
$interval = 'UNKNOWN'
$authResult = 'FAIL'

function Git-Head([string]$path) {
    $value = (& git -C $path rev-parse HEAD)
    if ($LASTEXITCODE -ne 0 -or $value -notmatch '^[a-f0-9]{40}$') {
        throw 'Git commit identity unavailable.'
    }
    return $value.Trim()
}
try { $testSha = Git-Head $test }
catch { $problems.Add('test_sha') }
try { $liveSha = Git-Head $live }
catch { $problems.Add('live_sha') }
if ($ExpectedTestSha -and $testSha -ine $ExpectedTestSha) {
    $problems.Add('test_sha_mismatch')
}
if ($ExpectedLiveSha -and $liveSha -ine $ExpectedLiveSha) {
    $problems.Add('live_sha_mismatch')
}
if (Test-Path -LiteralPath (Join-Path $state 'REQUIRES-REVIEW.txt')) {
    $problems.Add('review_hold')
}
if (Test-Path -LiteralPath (Join-Path $state 'IN-PROGRESS.txt')) {
    $problems.Add('deployment_in_progress')
}
try {
    $task = Get-ScheduledTask -TaskName 'Family Calendar Secure TEST Auto Deploy' -ErrorAction Stop
    [xml]$xml = Export-ScheduledTask -TaskName 'Family Calendar Secure TEST Auto Deploy' -ErrorAction Stop
    $matches = @($xml.SelectNodes("//*[local-name()='TimeTrigger']/*[local-name()='Repetition']/*[local-name()='Interval']"))
    if ($matches.Count -eq 1) { $interval = $matches[0].InnerText }
    if ($task.State.ToString() -notin @('Ready','Running') -or
        $task.Settings.MultipleInstances.ToString() -ne 'IgnoreNew' -or
        $interval -notin @('PT1M','PT15M')) {
        $problems.Add('updater_task')
    }
} catch { $problems.Add('updater_task_unreadable') }

# The receipt is from the pinned installer transcript, not from a GitHub build.
$logFile = Join-Path $state 'auto-test-deploy.log'
if (!(Test-Path -LiteralPath $logFile)) {
    $problems.Add('deployment_log_missing')
} else {
    try {
        # Read historical successes even after thousands of later no-op
        # polling checks. The verified backup path is checked below.
        $parser = Join-Path $PSScriptRoot 'read-secure-test-success-receipt.ps1'
        . $parser
        $receipt = Read-SecureTestLastSuccessReceipt -LogFile $logFile
        $lastSuccessSha = $receipt.LastSuccessSha
        $lastSuccessAt = $receipt.LastSuccessAt
        $lastBackup = $receipt.LastBackup
    } catch { $problems.Add('deployment_log_unreadable') }
    if ($lastSuccessSha -eq 'UNKNOWN' -or $lastSuccessSha -ne $testSha) {
        $problems.Add('installed_sha_not_receipted')
    }
    $backupsRoot = Join-Path $state 'backups'
    if ($lastBackup -eq 'UNKNOWN' -or
        -not $lastBackup.StartsWith($backupsRoot + '\',[StringComparison]::OrdinalIgnoreCase) -or
        !(Test-Path -LiteralPath $lastBackup -PathType Container)) {
        $problems.Add('last_backup_unverified')
    }
}
try {
    $listeners = @(Get-NetTCPConnection -LocalPort 13002 -State Listen -ErrorAction Stop)
    if ($listeners.Count -ne 1 -or $listeners[0].LocalAddress -notmatch '^100\.') {
        throw 'Unexpected TEST listener.'
    }
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $($listeners[0].OwningProcess)" -ErrorAction Stop
    if (!$proc -or $proc.CommandLine -notlike '*family-calendar-test-security-stage*') {
        throw 'Unexpected TEST process.'
    }
    $base = "http://$($listeners[0].LocalAddress):13002"
    $h = Invoke-RestMethod -Uri "$base/api/health" -TimeoutSec 5
    $a = Invoke-RestMethod -Uri "$base/api/auth/status" -TimeoutSec 5
    if ($h.status -ne 'ok' -or $a.enabled -ne $true) { throw 'TEST health/auth failure.' }
    try {
        $null = Invoke-WebRequest -Uri "$base/api/events" -TimeoutSec 5 -UseBasicParsing
        throw 'Anonymous calendar was accessible.'
    } catch {
        if (!$_.Exception.Response -or [int]$_.Exception.Response.StatusCode -ne 401) {
            throw
        }
    }
    $authResult = 'PASS'
} catch { $problems.Add('test_health_or_auth') }
$status = if ($problems.Count -eq 0) { 'PASS' } else { 'FAIL' }
$reasons = if ($problems.Count -eq 0) { 'none' } else { ($problems -join ',') }
Write-Host "TEST_DEPLOY_REPORT=$status | checked_at=$checkedAt | installed_sha=$testSha | last_success_sha=$lastSuccessSha | last_success_at=$lastSuccessAt | polling=$interval | health_auth=$authResult | backup=$(if($lastBackup -eq 'UNKNOWN'){'UNKNOWN'}elseif(Test-Path -LiteralPath $lastBackup){'PRESENT'}else{'MISSING'}) | live_sha=$liveSha | issues=$reasons"
if ($problems.Count -gt 0) { exit 1 }
