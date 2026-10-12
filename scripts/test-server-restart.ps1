# Controlled restart test for the existing SYSTEM-owned Family Calendar scheduled task.
# PREVIEW ONLY by default. Pass -Run to briefly stop/start the live calendar server.
# Does not reboot Windows, deploy code, or write to SQLite.

param([switch]$Run)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$live = Join-Path $env:USERPROFILE 'Projects\family-calendar'
$test = Join-Path $env:USERPROFILE 'Projects\family-calendar-test'
$taskName = 'Family Calendar Server'
$expectedStartup = Join-Path $live 'start-calendar-server.cmd'
$recoveryFolder = Join-Path $env:USERPROFILE 'Projects\family-calendar-release-backups\sqlite'
$port = 3001
$healthUrl = 'http://127.0.0.1:3001/api/health'

function Assert-Ready([bool]$condition, [string]$description) {
    if (-not $condition) { throw "Preflight failed: $description" }
    Write-Host "[PASS] $description"
}

function Get-ServerPids {
    @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -Unique)
}

function Test-ServerHealthy {
    try {
        $value = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 3 -ErrorAction Stop
        return ($value.status -eq 'ok')
    } catch {
        return $false
    }
}

function Wait-ForHealthyServer([int]$previousPid, [int]$seconds) {
    $deadline = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $deadline) {
        $owners = @(Get-ServerPids)
        if ($owners.Count -eq 1 -and [int]$owners[0] -ne $previousPid) {
            if ((Get-ScheduledTask -TaskName $taskName).State -eq 'Running' -and
                (Test-ServerHealthy)) {
                return [int]$owners[0]
            }
        }
        Start-Sleep -Seconds 2
    }
    return $null
}

Write-Host 'FAMILY CALENDAR — CONTROLLED SERVER RESTART CHECK'
if (-not $Run) { Write-Host 'PREVIEW ONLY: no server stop/start will occur.' }
Write-Host ''

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$admin = ([Security.Principal.WindowsPrincipal]$identity).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
)
Assert-Ready ($admin -and $identity.Name -ne 'NT AUTHORITY\SYSTEM') 'Interactive administrator (not SYSTEM)'
Assert-Ready (Test-Path -LiteralPath $expectedStartup) 'Live calendar startup script exists'
Assert-Ready (Test-Path -LiteralPath (Join-Path $live '.git')) 'Live repository exists'
Assert-Ready (Test-Path -LiteralPath (Join-Path $test '.git')) 'Test repository exists'
Assert-Ready (Test-Path -LiteralPath (Join-Path $live 'Server\data\calendar.db')) 'Live SQLite database exists'

$task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
Assert-Ready ($task.Principal.UserId -eq 'SYSTEM') 'Calendar task belongs to SYSTEM'
Assert-Ready ($task.State -eq 'Running') 'Calendar scheduled task is running'
Assert-Ready (@($task.Actions).Count -eq 1) 'Calendar task has one startup action'
Assert-Ready (
    [string]::Equals(
        $task.Actions[0].Execute.Trim(),
        $expectedStartup,
        [StringComparison]::OrdinalIgnoreCase
    )
) 'Task points to known startup script'
Assert-Ready ($task.Settings.RestartCount -ge 1) 'Scheduled task has restart recovery configured'

$owners = @(Get-ServerPids)
Assert-Ready ($owners.Count -eq 1) 'Exactly one process owns live calendar port'
$oldPid = [int]$owners[0]
$node = Get-CimInstance Win32_Process -Filter "ProcessId = $oldPid"
Assert-Ready ($null -ne $node -and $node.Name -eq 'node.exe') 'Live listener is node.exe'
$parent = Get-CimInstance Win32_Process -Filter "ProcessId = $($node.ParentProcessId)"
Assert-Ready ($null -ne $parent -and $parent.Name -eq 'cmd.exe') 'Live node.exe parent is cmd.exe'
Assert-Ready (Test-ServerHealthy) 'Live health endpoint responds OK'

foreach ($item in @(@{ Label = 'Live'; Folder = $live }, @{ Label = 'Test'; Folder = $test })) {
    $branch = (& git -C $item.Folder branch --show-current).Trim()
    Assert-Ready ($LASTEXITCODE -eq 0 -and $branch -eq 'main') "$($item.Label) repository is on main"
    $changes = @(& git -C $item.Folder status --porcelain)
    Assert-Ready ($LASTEXITCODE -eq 0 -and $changes.Count -eq 0) "$($item.Label) working tree is clean"
}

$backups = @(
    Get-ChildItem -LiteralPath $recoveryFolder -Filter 'calendar-*.db' -File -ErrorAction SilentlyContinue |
      Where-Object { $_.Length -gt 0 -and $_.LastWriteTime -gt (Get-Date).AddHours(-24) }
)
Assert-Ready ($backups.Count -gt 0) 'Recent independent SQLite recovery snapshot exists'

$busyBackups = @(Get-ScheduledTask | Where-Object {
    $_.TaskName -like 'Family Calendar Backup*' -and $_.State -eq 'Running'
})
Assert-Ready ($busyBackups.Count -eq 0) 'No backup task currently running'

Write-Host ''
Write-Host "Current calendar Node PID: $oldPid"
Write-Host "Recent recovery snapshot: $($backups | Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName)"
Write-Host 'No laptop reboot, Git update, or database modification is included.'
if (-not $Run) {
    Write-Host ''
    Write-Host 'PREVIEW PASSED. No changes were made.'
    Write-Host 'Run this script with -Run only when a brief calendar interruption is acceptable.'
    return
}

Write-Host ''
Write-Host 'Stopping only the Family Calendar scheduled task...'
$stopRequested = $false

try {
    $stopRequested = $true
    Stop-ScheduledTask -TaskName $taskName -ErrorAction Stop

    $deadline = (Get-Date).AddSeconds(30)
    do {
        $listeners = @(Get-ServerPids)
        if ($listeners.Count -eq 0) { break }
        Start-Sleep -Seconds 2
    } while ((Get-Date) -lt $deadline)

    if ($listeners.Count -gt 0) {
        throw 'Calendar port remained occupied after stopping its task. Refusing to start a duplicate server.'
    }

    Write-Host 'Calendar port released. Starting the existing scheduled task...'
    Start-ScheduledTask -TaskName $taskName -ErrorAction Stop

    $newPid = Wait-ForHealthyServer -previousPid $oldPid -seconds 90
    if ($null -eq $newPid) {
        throw 'A new healthy calendar process was not detected after task start.'
    }

    Write-Host ''
    Write-Host 'CONTROLLED SERVER RESTART TEST PASSED'
    Write-Host "Previous Node PID: $oldPid"
    Write-Host "New Node PID: $newPid"
    Write-Host 'Calendar API: Healthy'
    Write-Host 'Live database and Git source: Not modified by this script'
} catch {
    $failure = $_.Exception.Message
    Write-Warning "Restart test encountered a problem: $failure"

    if ($stopRequested) {
        $currentOwners = @(Get-ServerPids)
        if ($currentOwners.Count -eq 0) {
            Write-Warning 'Calendar port is empty. Attempting to start the original scheduled task again.'
            try {
                Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
                $recoveredPid = Wait-ForHealthyServer -previousPid $oldPid -seconds 90
                if ($null -ne $recoveredPid) {
                    Write-Host "RECOVERY SUCCEEDED: Calendar healthy under Node PID $recoveredPid."
                } else {
                    Write-Warning 'Automatic recovery could not verify a healthy new server. Check the scheduled task and startup logs.'
                }
            } catch {
                Write-Warning "Automatic recovery attempt failed: $($_.Exception.Message)"
            }
        } elseif (Test-ServerHealthy) {
            Write-Host 'Calendar remains healthy on the original listener; no duplicate process was started.'
        } else {
            Write-Warning 'Port 3001 is occupied but health failed. Investigate the existing Node process before restarting again.'
        }
    }

    throw "Controlled restart test did not pass: $failure"
}
