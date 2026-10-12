# Interactive PR preview. Uses third checkout, separate test DB, port 13002 on Tailscale only.
# No changes to live code/database or port 3001.
param([ValidateRange(0,1000000)][int]$PullRequest=0, [switch]$Stop)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$test = Join-Path $env:USERPROFILE 'Projects\family-calendar-test'
$live = Join-Path $env:USERPROFILE 'Projects\family-calendar'
$preview = Join-Path $env:USERPROFILE 'Projects\family-calendar-preview'
$entry = Join-Path $preview 'Server\index.mjs'
$pidFile = Join-Path $preview 'logs\preview-node-pid.txt'
$origin = 'git@github.com:BSwiss89/family-calendar.git'
$port = 13002

function Assert-Repo([string]$folder, [string]$label) {
    if (-not (Test-Path (Join-Path $folder '.git'))) { throw "$label Git checkout missing." }
    $url = (& git -C $folder remote get-url origin).Trim()
    if ($LASTEXITCODE -ne 0 -or $url -ne $origin) { throw "$label Git remote not approved." }
    $dirty = @(& git -C $folder status --porcelain)
    if ($LASTEXITCODE -ne 0 -or $dirty.Count -ne 0) { throw "$label checkout has uncommitted changes." }
}
function Listener { @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique) }
function Stop-Preview {
    $owners = @(Listener)
    if ($owners.Count -eq 0) { return }
    if ($owners.Count -ne 1 -or -not (Test-Path $pidFile)) { throw 'Unknown preview port owner; refusing to stop process.' }
    $ownerPid = [int]$owners[0]
    $recorded = (Get-Content -LiteralPath $pidFile -Raw).Trim()
    $p = Get-CimInstance Win32_Process -Filter "ProcessId = $ownerPid"
    if ($recorded -ne [string]$ownerPid -or $null -eq $p -or $p.Name -ne 'node.exe' -or -not $p.CommandLine.Contains($entry)) {
        throw 'Preview PID or command line does not match; refusing to stop process.'
    }
    Stop-Process -Id $ownerPid -Force -ErrorAction Stop
    for ($i=0; $i -lt 20 -and @(Listener).Count -ne 0; $i++) { Start-Sleep -Milliseconds 300 }
    if (@(Listener).Count -ne 0) { throw 'Preview port not released.' }
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    Write-Host 'Previous preview stopped. Live Node untouched.'
}

if ($Stop) {
    Stop-Preview
    Write-Host 'Preview stopped; live untouched.'
    return
}
if ($PullRequest -lt 1) { throw 'Specify -PullRequest followed by the GitHub pull request number.' }
Assert-Repo $test 'Test'
Assert-Repo $live 'Live'
$testDb = Join-Path $test 'Server\data\calendar.db'
if (-not (Test-Path $testDb)) { throw 'Separate test database missing; refusing to use live data.' }

Write-Host "ISOLATED FRONTEND + BACKEND PREVIEW FOR PR #$PullRequest"
if (-not (Test-Path (Join-Path $preview '.git'))) {
    if (Test-Path $preview) { throw 'Preview directory exists without Git checkout; refused to overwrite.' }
    & git clone --no-hardlinks $test $preview
    if ($LASTEXITCODE -ne 0) { throw 'Local preview clone failed.' }
    & git -C $preview remote set-url origin $origin
    if ($LASTEXITCODE -ne 0) { throw 'Could not set approved preview origin.' }
    & git -C $preview config core.sshCommand 'ssh -i C:/Users/bobby/.ssh/id_ed25519_github -o IdentitiesOnly=yes'
    if ($LASTEXITCODE -ne 0) { throw 'Could not configure existing interactive GitHub key.' }
}
Assert-Repo $preview 'Preview'
Write-Host 'Fetching GitHub pull request...'
& git -C $preview fetch origin "refs/pull/$PullRequest/head"
if ($LASTEXITCODE -ne 0) { throw 'PR fetch failed. Verify PR number and GitHub SSH login.' }
$commit = (& git -C $preview rev-parse FETCH_HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Unable to identify the PR commit.' }

Stop-Preview
& git -C $preview checkout -B "preview-pr-$PullRequest" FETCH_HEAD
if ($LASTEXITCODE -ne 0) { throw 'PR checkout failed.' }
Assert-Repo $preview 'Preview'

$node = (Get-Command node.exe -ErrorAction Stop).Source
$previewDb = Join-Path $preview 'Server\data\calendar.db'
$helper = Join-Path $test 'scripts\create-preview-db.mjs'
if (-not (Test-Path $helper)) { throw 'Approved preview database helper missing.' }
& $node $helper $testDb $previewDb
if ($LASTEXITCODE -ne 0) { throw 'Independent preview DB creation failed.' }
New-Item -ItemType Directory -Path (Join-Path $preview 'Server\uploads') -Force | Out-Null

Write-Host 'Building candidate frontend and checking backend...'
& npm.cmd --prefix $preview ci --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw 'Preview npm ci failed.' }
Push-Location $preview
try {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Preview frontend build failed.' }
} finally { Pop-Location }
& $node --check $entry
if ($LASTEXITCODE -ne 0) { throw 'Preview backend syntax failed.' }

$tailscale = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
if (-not (Test-Path $tailscale)) { throw 'Tailscale executable missing. Will not expose preview on LAN.' }
$ips = @(& $tailscale ip -4)
if ($LASTEXITCODE -ne 0 -or $ips.Count -ne 1 -or $ips[0] -notmatch '^100\.(?:[6-9][0-9]|1[0-1][0-9]|12[0-7])\.\d{1,3}\.\d{1,3}$') {
    throw 'Could not resolve one Tailscale IPv4 address. No preview started.'
}
$hostIp = [string]$ips[0]
if (@(Listener).Count -ne 0) { throw 'Preview port occupied by another process.' }

$logs = Join-Path $preview 'logs'
New-Item -ItemType Directory -Path $logs -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$stdout = Join-Path $logs "preview-$stamp-out.log"
$stderr = Join-Path $logs "preview-$stamp-err.log"
$priorPort = [Environment]::GetEnvironmentVariable('FAMILY_CALENDAR_PORT','Process')
$priorHost = [Environment]::GetEnvironmentVariable('FAMILY_CALENDAR_HOST','Process')
try {
    $env:FAMILY_CALENDAR_PORT = [string]$port
    $env:FAMILY_CALENDAR_HOST = $hostIp
    $process = Start-Process -FilePath $node -ArgumentList @($entry) -WorkingDirectory $preview -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr
} finally {
    [Environment]::SetEnvironmentVariable('FAMILY_CALENDAR_PORT',$priorPort,'Process')
    [Environment]::SetEnvironmentVariable('FAMILY_CALENDAR_HOST',$priorHost,'Process')
}
try {
    Set-Content -LiteralPath $pidFile -Value $process.Id -NoNewline
    $healthy = $false
    for ($i=0; $i -lt 40; $i++) {
        $process.Refresh()
        if ($process.HasExited) { throw 'Preview server exited early.' }
        try {
            $health = Invoke-RestMethod -Uri "http://$($hostIp):$port/api/health" -TimeoutSec 2
            if ($health.status -eq 'ok') { $healthy = $true; break }
        } catch { }
        Start-Sleep -Milliseconds 500
    }
    if (-not $healthy) { throw 'Preview backend failed health check.' }
    $page = Invoke-WebRequest -Uri "http://$($hostIp):$port/" -UseBasicParsing -TimeoutSec 5
    if ($page.StatusCode -ne 200) { throw 'Preview frontend failed HTTP check.' }
    Write-Host ''
    Write-Host 'FULL-STACK PREVIEW PASSED'
    Write-Host "PR #$PullRequest at commit $($commit.Substring(0,7))"
    Write-Host "Tailscale preview URL: http://$($hostIp):$port"
    Write-Host 'All calendar changes here use the separate preview DB; live remains on port 3001.'
    Write-Host 'Preview uploads are separate; images not in preview may be missing.'
} catch {
    Write-Warning "Preview failed: $($_.Exception.Message)"
    try { Stop-Preview } catch { Write-Warning $_.Exception.Message }
    if (Test-Path $stderr) { Get-Content -LiteralPath $stderr -Tail 15 }
    throw
}
