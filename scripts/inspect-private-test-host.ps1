# READ-ONLY Windows laptop inspection for a FUTURE private household TEST pilot.
# Run interactively in an isolated reviewed checkout. This script DOES NOT:
# register/modify/run/stop tasks; install services; access SQLite; change
# Git refs; touch LIVE/TEST; query Tailscale; read credentials; deploy code.
# Output includes only sanitized task names/settings and Git revision/clean flags.
param([switch]$SnapshotOnly)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projects = Join-Path $env:USERPROFILE 'Projects'
$livePath = Join-Path $projects 'family-calendar'
$testPath = Join-Path $projects 'family-calendar-test'
$liveFull = [IO.Path]::GetFullPath($livePath).TrimEnd('\')
$trial = [IO.Path]::GetFullPath($testPath).TrimEnd('\')
$distinct = -not [string]::Equals($liveFull, $trial,
    [StringComparison]::OrdinalIgnoreCase)

function Read-Checkout {
    param([Parameter(Mandatory=$true)][string]$Directory)
    $item = Get-Item -LiteralPath $Directory -Force -ErrorAction SilentlyContinue
    if ($null -eq $item -or -not $item.PSIsContainer) {
        return @{ exists = $false; gitRepo = $false
          trackedAndUntrackedClean = $false; reparsePoint = $false; headSha = $null }
    }
    $symlink = [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
    $isGit = $false
    $clean = $false
    $head = $null
    if (-not $symlink -and (Test-Path -LiteralPath (Join-Path $Directory '.git'))) {
        $inside = @(& git -C $Directory rev-parse --is-inside-work-tree 2>$null)
        if ($LASTEXITCODE -eq 0 -and $inside.Count -eq 1 -and $inside[0] -eq 'true') {
            $isGit = $true
            $revision = @(& git -C $Directory rev-parse HEAD 2>$null)
            if ($LASTEXITCODE -eq 0 -and $revision.Count -eq 1 -and
                $revision[0] -cmatch '^[a-f0-9]{40}$') {
                $head = $revision[0]
                # No fetch, pull, checkout, staging, or refresh. This is
                # a read-only check including untracked files.
                $changes = @(& git -C $Directory status --porcelain 2>$null)
                if ($LASTEXITCODE -eq 0) {
                    $clean = ($changes.Count -eq 0)
                }
            }
        }
    }
    return @{ exists = $true; gitRepo = $isGit
      trackedAndUntrackedClean = $clean; reparsePoint = $symlink; headSha = $head }
}

$tasksKnown = $false
$taskInventory = @()
try {
    $all = @(Get-ScheduledTask -ErrorAction Stop)
    $tasksKnown = $true
    foreach ($task in $all) {
        # Never extract task actions, command arguments, user names, passwords,
        # service credentials, or task XML.
        if ($task.TaskName -notmatch '(?i)family[ -]?calendar') { continue }
        $restart = $task.Settings.RestartCount
        $taskInventory += @{
            name = [string]$task.TaskName
            enabled = ([string]$task.State -ne 'Disabled')
            restartCount = if ($null -eq $restart) { -1 } else { [int]$restart }
            multipleInstances = [string]$task.Settings.MultipleInstances
            triggerCount = @($task.Triggers).Count
        }
    }
} catch {
    # Permission or scheduler unavailability is UNKNOWN, never a pass.
    $tasksKnown = $false
    $taskInventory = @()
}

$inventory = @{
    schemaVersion = 1
    platform = if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) { 'win32' } else { 'unsupported' }
    distinctCheckouts = $distinct
    taskEnumerationSucceeded = $tasksKnown
    tasks = @($taskInventory)
    checkouts = @{
        live = Read-Checkout -Directory $livePath
        test = Read-Checkout -Directory $testPath
    }
}
$json = ConvertTo-Json -InputObject $inventory -Depth 8 -Compress
if ($SnapshotOnly) {
    $json
    return
}
$json | & node (Join-Path $PSScriptRoot 'assess-private-test-host-readiness.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Read-only private TEST host inventory could not be evaluated.' }
