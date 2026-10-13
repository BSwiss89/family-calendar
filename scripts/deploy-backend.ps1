# Manual backend release; preview is default. -Apply authorizes one controlled restart.
# This release refuses dependency changes and edits to known database migrations.
# No automatic restoration of household SQLite data.

param([switch]$Apply)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$live = Join-Path $env:USERPROFILE 'Projects\family-calendar'
$test = Join-Path $env:USERPROFILE 'Projects\family-calendar-test'
$backups = Join-Path $env:USERPROFILE 'Projects\family-calendar-release-backups'
$taskName = 'Family Calendar Server'
$remote = 'git@github.com:BSwiss89/family-calendar.git'

function Ensure([bool]$ok, [string]$message) {
    if (-not $ok) { throw "Preflight stopped: $message" }
    Write-Host "[PASS] $message"
}
function ListeningPids {
    @(Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
}
function IsHealthy {
    try { return ((Invoke-RestMethod 'http://127.0.0.1:3001/api/health' -TimeoutSec 3).status -eq 'ok') }
    catch { return $false }
}
function AwaitStopped {
    for ($i = 0; $i -lt 15; $i++) {
        if (@(ListeningPids).Count -eq 0) { return $true }
        Start-Sleep -Seconds 2
    }
    return (@(ListeningPids).Count -eq 0)
}
function AwaitHealthy([int]$oldPid) {
    for ($i = 0; $i -lt 45; $i++) {
        $p = @(ListeningPids)
        if ($p.Count -eq 1 -and [int]$p[0] -ne $oldPid -and (IsHealthy)) {
            if ((Get-ScheduledTask -TaskName $taskName).State -eq 'Running') { return [int]$p[0] }
        }
        Start-Sleep -Seconds 2
    }
    return $null
}
function CheckRepo([string]$folder, [string]$label) {
    Ensure (Test-Path (Join-Path $folder '.git')) "$label repository exists"
    $url = (& git -C $folder remote get-url origin).Trim()
    Ensure ($LASTEXITCODE -eq 0 -and $url -eq $remote) "$label origin is approved"
    $branch = (& git -C $folder branch --show-current).Trim()
    Ensure ($LASTEXITCODE -eq 0 -and $branch -eq 'main') "$label is on main"
    $status = @(& git -C $folder status --porcelain)
    Ensure ($LASTEXITCODE -eq 0 -and $status.Count -eq 0) "$label repository is clean"
}
function Migrations([string]$source) {
    $start = $source.IndexOf('const database = new DatabaseSync(databasePath)', [StringComparison]::Ordinal)
    $end = $source.IndexOf('app.use(express.json())', [StringComparison]::Ordinal)
    if ($start -lt 0 -or $end -le $start) { throw 'Could not isolate startup database migrations' }
    return $source.Substring($start, $end - $start)
}
function ReleasePlan {
    CheckRepo $live 'Live'
    CheckRepo $test 'Test'
    $from = (& git -C $live rev-parse HEAD).Trim()
    $to = (& git -C $test rev-parse HEAD).Trim()
    Ensure ($LASTEXITCODE -eq 0) 'Commit IDs available'
    & git -C $test merge-base --is-ancestor $from $to
    Ensure ($LASTEXITCODE -eq 0) 'Live version is ancestor of tested version'
    $changed = @(& git -C $test diff --name-only "$from..$to")
    Ensure ($LASTEXITCODE -eq 0) 'Release file list available'
    $allowed = '^(Server/index\.mjs$|src/|public/|\.github/|scripts/|docs/|index\.html$|README\.md$|\.gitignore$|eslint\.config\.js$|vite\.config\.ts$|tsconfig(?:\.[^/]+)?\.json$)'
    $blocked = @($changed | Where-Object { $_ -notmatch $allowed })
    if ($blocked.Count -gt 0) {
        $blocked | ForEach-Object { Write-Host "BLOCKED: $_" }
        throw 'Dependency/unknown file changes require separate review.'
    }
    if ($changed -contains 'Server/index.mjs') {
        $prior = @(& git -C $live show ($from + ':Server/index.mjs')) -join [Environment]::NewLine
        Ensure ($LASTEXITCODE -eq 0) 'Old backend inspected'
        $candidate = @(& git -C $test show ($to + ':Server/index.mjs')) -join [Environment]::NewLine
        Ensure ($LASTEXITCODE -eq 0) 'New backend inspected'
        Ensure ([string]::Equals((Migrations $prior), (Migrations $candidate), [StringComparison]::Ordinal)) 'Known startup migrations unchanged'
    }
    return [pscustomobject]@{ From = $from; To = $to; Changed = $changed }
}

Write-Host 'FAMILY CALENDAR - GUARDED BACKEND RELEASE'
if (-not $Apply) { Write-Host 'PREVIEW ONLY; no changes will be made.' }
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$admin = ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Ensure ($admin -and $id.Name -ne 'NT AUTHORITY\SYSTEM') 'Interactive administrator'
$launcher = Join-Path $live 'start-calendar-server.cmd'
Ensure (Test-Path $launcher) 'Live launcher exists'
Ensure (Test-Path (Join-Path $live 'Server\data\calendar.db')) 'Live database exists'
Ensure (Test-Path (Join-Path $test 'Server\data\calendar.db')) 'Separate test database exists'
$task = Get-ScheduledTask -TaskName $taskName
Ensure ($task.Principal.UserId -eq 'SYSTEM' -and $task.State -eq 'Running') 'SYSTEM task running'
Ensure (@($task.Actions).Count -eq 1) 'One task action'
Ensure ([string]::Equals($task.Actions[0].Execute.Trim(), $launcher, [StringComparison]::OrdinalIgnoreCase)) 'Expected startup launcher'
$owners = @(ListeningPids)
Ensure ($owners.Count -eq 1) 'Exactly one live listener'
$oldPid = [int]$owners[0]
$p = Get-CimInstance Win32_Process -Filter "ProcessId = $oldPid"
Ensure ($null -ne $p -and $p.Name -eq 'node.exe') 'Listener belongs to Node'
$parent = Get-CimInstance Win32_Process -Filter "ProcessId = $($p.ParentProcessId)"
Ensure ($null -ne $parent -and $parent.Name -eq 'cmd.exe') 'Node parent is cmd'
Ensure (IsHealthy) 'Live API healthy'
$busy = @(Get-ScheduledTask | Where-Object { $_.TaskName -like 'Family Calendar Backup*' -and $_.State -eq 'Running' })
Ensure ($busy.Count -eq 0) 'Backups idle'
$plan = ReleasePlan
Write-Host "Live: $($plan.From.Substring(0,7)); Test: $($plan.To.Substring(0,7))"
$plan.Changed | ForEach-Object { Write-Host "  $_" }
if ($plan.From -eq $plan.To) { Write-Host 'Already deployed.'; return }
if (-not $Apply) {
    Write-Host 'BACKEND PREVIEW PASSED; no live changes.'
    return
}

Write-Host 'Rebuilding and smoke-testing the test copy...'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $test 'scripts\update-test.ps1')
if ($LASTEXITCODE -ne 0) { throw 'Test rebuild failed.' }
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $test 'scripts\test-backend.ps1')
if ($LASTEXITCODE -ne 0) { throw 'Test backend failed.' }
# Execute migration and schema-preservation guards before the live service is stopped.
# This is required even for API-only backend changes; it also verifies startup compatibility.
# Dependency and migration file changes remain blocked in ReleasePlan above.
Write-Host 'Checking database migration safety using disposable SQLite snapshots...'
& node (Join-Path $test 'scripts\preflight-migrations.mjs') --self-test
if ($LASTEXITCODE -ne 0) { throw 'SQLite migration safety fixtures failed. Live calendar unchanged.' }
& node (Join-Path $test 'scripts\preflight-migrations.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Disposable SQLite migration preflight failed. Live calendar unchanged.' }
Write-Host '[PASS] Disposable SQLite migration preflight and synthetic safety fixtures'
# Ensure production npm packages can be installed into a disposable folder,
# and simulate dependency switch/rollback before ever stopping the live calendar.
# This does NOT permit package.json or lockfile changes (ReleasePlan still blocks them).
Write-Host 'Checking runtime dependency staging and rollback safety before live restart...'
& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $test 'scripts\test-dependency-rollback.ps1')
if ($LASTEXITCODE -ne 0) { throw 'Dependency rollback safety fixtures failed. Live calendar unchanged.' }
& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $test 'scripts\stage-dependencies.ps1')
if ($LASTEXITCODE -ne 0) { throw 'Isolated dependency staging failed. Live calendar unchanged.' }
Write-Host '[PASS] Dependency switch/rollback fixtures and isolated npm staging'
$plan = ReleasePlan
Ensure ($plan.From -ne $plan.To) 'Update available'
& git -C $live fetch origin main
if ($LASTEXITCODE -ne 0) { throw 'GitHub fetch failed before server stop.' }
$latest = (& git -C $live rev-parse origin/main).Trim()
Ensure ($LASTEXITCODE -eq 0 -and $latest -eq $plan.To) 'Test version matches approved GitHub main'
$distTest = Join-Path $test 'dist'
$distLive = Join-Path $live 'dist'
Ensure (Test-Path (Join-Path $distTest 'index.html')) 'Test HTML built'
Ensure (Test-Path (Join-Path $distLive 'index.html')) 'Live HTML exists'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$release = Join-Path $backups ("backend-" + $stamp + "-" + $plan.From.Substring(0,7))
$stage = Join-Path $backups ("stage-" + $stamp + "-" + $PID)
$oldDist = Join-Path $release 'previous-dist'
New-Item -ItemType Directory -Path $release -Force | Out-Null
Copy-Item -LiteralPath $distTest -Destination $stage -Recurse -Force
Ensure (Test-Path (Join-Path $stage 'index.html')) 'Frontend staged safely'
Set-Content (Join-Path $release 'previous-commit.txt') $plan.From
$didStop = $false
$didUpdate = $false
$didMove = $false
try {
    $busyBeforeStop = @(Get-ScheduledTask | Where-Object { $_.TaskName -like 'Family Calendar Backup*' -and $_.State -eq 'Running' })
    Ensure ($busyBeforeStop.Count -eq 0) 'No backup process running immediately before restart'
    $didStop = $true
    Stop-ScheduledTask -TaskName $taskName -ErrorAction Stop
    if (-not (AwaitStopped)) { throw 'Old Node still listening; refused to modify code.' }

    $snapDir = Join-Path $backups 'sqlite'
    $existing = @(Get-ChildItem $snapDir -Filter 'calendar-*.db' -File -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName)
    & node (Join-Path $test 'scripts\verify-sqlite-recovery.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Offline SQLite recovery test failed.' }
    $new = @(Get-ChildItem $snapDir -Filter 'calendar-*.db' -File | Where-Object { $existing -notcontains $_.FullName })
    if ($new.Count -ne 1) { throw 'Could not verify exactly one new backup.' }
    Set-Content (Join-Path $release 'snapshot-path.txt') $new[0].FullName

    $uploads = Join-Path $live 'Server\uploads'
    if (Test-Path $uploads) { Copy-Item -LiteralPath $uploads -Destination (Join-Path $release 'uploads') -Recurse -Force }
    & git -C $live merge --ff-only origin/main
    if ($LASTEXITCODE -ne 0) { throw 'Git fast-forward failed.' }
    $didUpdate = $true
    $head = (& git -C $live rev-parse HEAD).Trim()
    if ($head -ne $plan.To) { throw 'Unexpected Git commit after update.' }
    Move-Item -LiteralPath $distLive -Destination $oldDist
    $didMove = $true
    Move-Item -LiteralPath $stage -Destination $distLive
    & node --check (Join-Path $live 'Server\index.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Live backend syntax failed.' }

    Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
    $newPid = AwaitHealthy $oldPid
    if ($null -eq $newPid) { throw 'New server failed health validation.' }
    $page = Invoke-WebRequest 'http://127.0.0.1:3001/' -UseBasicParsing -TimeoutSec 10
    if ($page.StatusCode -ne 200 -or $page.Content.Trim() -ne ([IO.File]::ReadAllText((Join-Path $distLive 'index.html'))).Trim()) {
        throw 'New frontend failed verification.'
    }
    Write-Host 'BACKEND DEPLOYMENT PASSED'
    Write-Host "New Node PID: $newPid; New commit: $($plan.To.Substring(0,7))"
    Write-Host "Backup folder: $release"
    Write-Host "Database recovery snapshot: $($new[0].FullName)"
} catch {
    $reason = $_.Exception.Message
    Write-Warning "Deployment failed: $reason"
    $problems = [System.Collections.Generic.List[string]]::new()
    if ($didUpdate -or $didMove) {
        try {
            Stop-ScheduledTask -TaskName $taskName -ErrorAction Stop
            if (-not (AwaitStopped)) { throw 'Port still occupied; cannot safely replace files.' }
        } catch { $problems.Add("Stop new code: $($_.Exception.Message)") }
    }
    if ($problems.Count -eq 0) {
        if ($didMove) {
            try {
                if (Test-Path $distLive) { Move-Item $distLive (Join-Path $release 'failed-dist') }
                Move-Item $oldDist $distLive
            } catch { $problems.Add("Restore frontend: $($_.Exception.Message)") }
        }
        if ($didUpdate) {
            try {
                $head = (& git -C $live rev-parse HEAD).Trim()
                $dirty = @(& git -C $live status --porcelain)
                if ($head -ne $plan.To -or $dirty.Count -ne 0) { throw 'Live Git changed unexpectedly.' }
                & git -C $live reset --hard $plan.From
                if ($LASTEXITCODE -ne 0) { throw 'Could not reset old commit.' }
            } catch { $problems.Add("Restore backend: $($_.Exception.Message)") }
        }
    }
    if ($didStop -and @(ListeningPids).Count -eq 0) {
        try {
            Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
            $recovered = AwaitHealthy $oldPid
            if ($null -eq $recovered) { throw 'Server did not return to health.' }
            Write-Host "Server recovered under PID $recovered."
        } catch { $problems.Add("Recover calendar: $($_.Exception.Message)") }
    }
    Write-Warning 'SQLite NOT restored automatically; protecting household events created after backup.'
    if ($problems.Count -gt 0) { throw "RECOVERY INCOMPLETE: $reason; $($problems -join '; ')" }
    throw "Deployment failed and previous code restoration attempted: $reason"
} finally {
    if (Test-Path $stage) { Remove-Item -LiteralPath $stage -Force -Recurse -ErrorAction SilentlyContinue }
}
