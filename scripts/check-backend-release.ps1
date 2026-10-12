# Read-only backend deployment readiness check.
# Does not restart processes, change scheduled tasks, or write to live data.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$live = Join-Path $env:USERPROFILE 'Projects\family-calendar'
$test = Join-Path $env:USERPROFILE 'Projects\family-calendar-test'
$liveDb = Join-Path $live 'Server\data\calendar.db'
$testDb = Join-Path $test 'Server\data\calendar.db'
$expectedLauncher = Join-Path $live 'start-calendar-server.cmd'
$warnings = [System.Collections.Generic.List[string]]::new()
$failures = [System.Collections.Generic.List[string]]::new()

function Check([bool]$condition, [string]$description) {
    if ($condition) { Write-Host "[PASS] $description" }
    else {
        Write-Host "[FAIL] $description"
        $script:failures.Add($description)
    }
}

function Warn([string]$description) {
    Write-Host "[NOTE] $description"
    $script:warnings.Add($description)
}

Write-Host 'FAMILY CALENDAR — BACKEND DEPLOYMENT PREFLIGHT'
Write-Host 'Read-only diagnostic. No files, processes, or tasks are modified.'
Write-Host ''

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$admin = ([Security.Principal.WindowsPrincipal]$identity).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
)
Check ($identity.Name -ne 'NT AUTHORITY\SYSTEM' -and $admin) 'Interactive administrator session (not SYSTEM)'
Check (Test-Path -LiteralPath (Join-Path $live '.git')) 'Live Git repository exists'
Check (Test-Path -LiteralPath (Join-Path $test '.git')) 'Separate test Git repository exists'
Check (Test-Path -LiteralPath $liveDb) 'Live SQLite database exists'
Check (Test-Path -LiteralPath $testDb) 'Test SQLite database exists'
Check (Test-Path -LiteralPath $expectedLauncher) 'Existing live startup script exists'

if ((Test-Path $liveDb) -and (Test-Path $testDb)) {
    $livePath = (Resolve-Path -LiteralPath $liveDb).Path
    $testPath = (Resolve-Path -LiteralPath $testDb).Path
    Check (-not [string]::Equals($livePath, $testPath, [StringComparison]::OrdinalIgnoreCase)) 'Test DB path differs from live DB path'
}

$task = Get-ScheduledTask -TaskName 'Family Calendar Server' -ErrorAction Stop
$taskAction = @($task.Actions)
Check ($task.Principal.UserId -eq 'SYSTEM') 'Calendar task runs as SYSTEM'
Check ($task.State -eq 'Running') 'Calendar scheduled task is running'
Check ($taskAction.Count -eq 1) 'Calendar scheduled task has one startup action'
if ($taskAction.Count -eq 1) {
    Check ([string]::Equals($taskAction[0].Execute.Trim(), $expectedLauncher, [StringComparison]::OrdinalIgnoreCase)) 'Startup task points to expected live launch script'
}

Write-Host ''
Write-Host 'LIVE SERVER PROCESS'
$connections = @(Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue)
$processIds = @($connections | Select-Object -ExpandProperty OwningProcess -Unique)
Check ($processIds.Count -eq 1) 'Exactly one process owns live port 3001'
if ($processIds.Count -eq 1) {
    $nodeProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $($processIds[0])"
    Check ($null -ne $nodeProcess -and $nodeProcess.Name -eq 'node.exe') 'Live port belongs to node.exe'
    if ($null -ne $nodeProcess) {
        $parent = Get-CimInstance Win32_Process -Filter "ProcessId = $($nodeProcess.ParentProcessId)"
        Check ($null -ne $parent -and $parent.Name -eq 'cmd.exe') 'Node process is launched by cmd.exe'
        Write-Host "Node PID: $($nodeProcess.ProcessId)"
        Write-Host "Parent PID: $($nodeProcess.ParentProcessId)"
    }
}

try {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:3001/api/health' -TimeoutSec 5
    Check ($health.status -eq 'ok') 'Live HTTP health endpoint responds OK'
} catch {
    Check $false 'Live HTTP health endpoint responds OK'
}

Write-Host ''
Write-Host 'SOURCE CHECKS'
foreach ($entry in @(@{ name='Live'; folder=$live }, @{ name='Test'; folder=$test })) {
    if (-not (Test-Path (Join-Path $entry.folder '.git'))) { continue }
    $branch = (& git -C $entry.folder branch --show-current).Trim()
    Check ($LASTEXITCODE -eq 0 -and $branch -eq 'main') "$($entry.name) repository is on main"
    $changes = @(& git -C $entry.folder status --porcelain)
    Check ($LASTEXITCODE -eq 0 -and $changes.Count -eq 0) "$($entry.name) Git working tree is clean"
    $commit = (& git -C $entry.folder rev-parse --short HEAD).Trim()
    if ($LASTEXITCODE -eq 0) { Write-Host "$($entry.name) commit: $commit" }
}

Write-Host ''
Write-Host 'BACKUP TASK STATUS (informational; not a restoration test)'
$backupTasks = @(Get-ScheduledTask | Where-Object { $_.TaskName -like 'Family Calendar Backup*' })
if ($backupTasks.Count -eq 0) {
    Warn 'No Family Calendar backup tasks found'
} else {
    foreach ($item in $backupTasks) {
        $info = Get-ScheduledTaskInfo -TaskName $item.TaskName -TaskPath $item.TaskPath
        Write-Host "$($item.TaskName): last result $($info.LastTaskResult), last run $($info.LastRunTime)"
        if ($info.LastTaskResult -ne 0) {
            Warn "$($item.TaskName) last result is not success"
        }
    }
}

Write-Host ''
Write-Host 'NEXT SAFETY GATES'
Write-Host '- Verify a fresh SQLite backup can be restored independently.'
Write-Host '- Validate stop/start of the existing scheduled task with a controlled recovery test.'
Write-Host '- Test backend release rollback, including how database migrations are handled.'
Write-Host '- No live backend deployment is authorized or performed by this check.'

Write-Host ''
if ($failures.Count -gt 0) {
    Write-Host "PREFLIGHT FAILED: $($failures.Count) required check(s)."
    exit 1
}
Write-Host 'PREFLIGHT PASSED: observed task/process/source configuration is compatible with planning.'
Write-Host 'This is NOT authorization to restart or deploy the backend.'
