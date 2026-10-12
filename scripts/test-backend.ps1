# Starts the TEST backend temporarily on localhost:13001, checks it, and stops it.
# Never starts from the live folder and never touches the live database or port 3001.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$test = Join-Path $env:USERPROFILE 'Projects\family-calendar-test'
$live = Join-Path $env:USERPROFILE 'Projects\family-calendar'
$db = Join-Path $test 'Server\data\calendar.db'
$entry = Join-Path $test 'Server\index.mjs'
$testDist = Join-Path $test 'dist\index.html'
$port = 13001
$logFolder = Join-Path $test 'logs'
$server = $null

if (-not (Test-Path (Join-Path $test '.git'))) { throw 'Testing repository is missing.' }
if (-not (Test-Path $db)) { throw 'Testing database is missing. Do not start the test server.' }
if (-not (Test-Path (Join-Path $live 'Server\data\calendar.db'))) { throw 'Expected live database was not found.' }
if (-not (Test-Path $entry)) { throw 'Testing backend code is missing.' }
if (-not (Test-Path $testDist)) { throw 'Testing frontend build is missing. Run update-test.ps1 first.' }

$resolvedLiveDb = (Resolve-Path (Join-Path $live 'Server\data\calendar.db')).Path
$resolvedTestDb = (Resolve-Path $db).Path
if ($resolvedLiveDb -eq $resolvedTestDb) { throw 'Testing database resolves to the LIVE database; refused.' }

$existing = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($existing) { throw "Port $port is already in use. No processes have been stopped." }

$node = (Get-Command node.exe -ErrorAction Stop).Source
& $node --check $entry
if ($LASTEXITCODE -ne 0) { throw 'Backend syntax check failed. No server was started.' }

New-Item -ItemType Directory -Path $logFolder -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$stdout = Join-Path $logFolder "backend-test-$stamp-out.log"
$stderr = Join-Path $logFolder "backend-test-$stamp-err.log"

$previousPort = [Environment]::GetEnvironmentVariable('FAMILY_CALENDAR_PORT', 'Process')
$previousHost = [Environment]::GetEnvironmentVariable('FAMILY_CALENDAR_HOST', 'Process')

try {
    try {
        $env:FAMILY_CALENDAR_PORT = "$port"
        $env:FAMILY_CALENDAR_HOST = '127.0.0.1'
        $server = Start-Process -FilePath $node -ArgumentList @('Server/index.mjs') -WorkingDirectory $test -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
    } finally {
        [Environment]::SetEnvironmentVariable('FAMILY_CALENDAR_PORT', $previousPort, 'Process')
        [Environment]::SetEnvironmentVariable('FAMILY_CALENDAR_HOST', $previousHost, 'Process')
    }

    $passed = $false
    for ($attempt = 1; $attempt -le 30; $attempt++) {
        $server.Refresh()
        if ($server.HasExited) { throw "Testing server exited early (code $($server.ExitCode))." }

        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 2 -ErrorAction Stop
            if ($health.status -eq 'ok') {
                $passed = $true
                break
            }
        } catch {
            Start-Sleep -Milliseconds 500
        }
    }

    if (-not $passed) { throw 'Testing health endpoint did not become healthy.' }

    $page = Invoke-WebRequest -Uri "http://127.0.0.1:$port/" -UseBasicParsing -TimeoutSec 10
    if ($page.StatusCode -ne 200) { throw 'Test frontend endpoint did not return HTTP 200.' }

    $liveHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:3001/api/health' -TimeoutSec 5
    if ($liveHealth.status -ne 'ok') { throw 'Live calendar health check failed.' }

    Write-Host ''
    Write-Host 'ISOLATED BACKEND TEST PASSED'
    Write-Host "Test server: http://127.0.0.1:$port (temporary, localhost only)"
    Write-Host 'Test health: OK'
    Write-Host 'Test frontend: HTTP 200'
    Write-Host 'Live calendar: HTTP health OK; no restart'
} catch {
    Write-Warning $_.Exception.Message
    if (Test-Path $stderr) {
        Write-Host 'Recent test backend errors (if any):'
        Get-Content -LiteralPath $stderr -Tail 15
    }
    throw
} finally {
    if ($null -ne $server) {
        $server.Refresh()
        if (-not $server.HasExited) {
            Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
            try { $server.WaitForExit(5000) | Out-Null } catch { }
        }
        Write-Host "Stopped isolated test backend PID $($server.Id)."
    }
}
