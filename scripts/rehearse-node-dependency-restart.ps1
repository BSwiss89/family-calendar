# Rehearse a real Node HTTP restart across a production npm tree swap and rollback.
# All paths, npm installations, and listener processes are strictly disposable.
# Never stop the live Family Calendar Server task or touch port 3001.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'dependency-swap.ps1')

$source = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$manifest = Join-Path $source 'package.json'
$lockfile = Join-Path $source 'package-lock.json'
$checker = Join-Path $PSScriptRoot 'verify-staged-dependencies.mjs'
$node = (Get-Command node.exe -ErrorAction Stop).Source
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$root = Join-Path ([IO.Path]::GetTempPath()) ('FamilyCalendarRestartRollback-' + [guid]::NewGuid().ToString('N'))
$previousSeed = Join-Path $root 'previous-install'
$candidateSeed = Join-Path $root 'candidate-install'
$app = Join-Path $root 'throwaway-app'
$active = Join-Path $app 'node_modules'
$staged = Join-Path $root 'staged-node_modules'
$previous = Join-Path $root 'previous-node_modules'
$rejected = Join-Path $root 'rejected-node_modules'
$marker = '.calendar-restart-rehearsal.txt'
$server = $null

function Require-Test([bool]$condition, [string]$message) {
    if (-not $condition) { throw "Isolated restart/rollback rehearsal failed: $message" }
}
function Install-ProductionTree([string]$folder, [string]$identity) {
    New-Item -ItemType Directory -Path $folder -ErrorAction Stop | Out-Null
    Copy-Item -LiteralPath $manifest -Destination (Join-Path $folder 'package.json') -ErrorAction Stop
    Copy-Item -LiteralPath $lockfile -Destination (Join-Path $folder 'package-lock.json') -ErrorAction Stop
    Push-Location $folder
    try {
        & $npm ci --omit=dev --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw "npm ci failed in $identity temporary package tree." }
    } finally {
        Pop-Location
    }
    & $node $checker $folder
    if ($LASTEXITCODE -ne 0) { throw "Installed $identity packages failed runtime verification." }
    Set-Content -LiteralPath (Join-Path (Join-Path $folder 'node_modules') $marker) -Value $identity -NoNewline
}
function Start-TestServer([string]$phase) {
    $stdout = Join-Path $root ($phase + '-out.txt')
    $stderr = Join-Path $root ($phase + '-err.txt')
    $priorPort = [Environment]::GetEnvironmentVariable('CALENDAR_RESTART_REHEARSAL_PORT', 'Process')
    try {
        $env:CALENDAR_RESTART_REHEARSAL_PORT = [string]$port
        return Start-Process -FilePath $node -ArgumentList 'rehearsal-server.cjs' -WorkingDirectory $app -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru -ErrorAction Stop
    } finally {
        [Environment]::SetEnvironmentVariable('CALENDAR_RESTART_REHEARSAL_PORT', $priorPort, 'Process')
    }
}
function Wait-Healthy([System.Diagnostics.Process]$process, [string]$identity) {
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        $process.Refresh()
        if ($process.HasExited) { throw "Temporary $identity Node process exited before becoming healthy." }
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 2 -ErrorAction Stop
            if ($health.status -eq 'ok' -and $health.identity -eq $identity -and
                [int]$health.pid -eq $process.Id -and $health.imageOk -eq $true) {
                return
            }
            throw "Temporary server returned unexpected version/PID/Sharp health while testing $identity."
        } catch {
            if ($_.Exception.Message -like 'Temporary server returned unexpected*') { throw }
            Start-Sleep -Milliseconds 250
        }
    }
    throw "Temporary $identity Node process never became healthy."
}
function Stop-TestServer([System.Diagnostics.Process]$process) {
    if ($null -ne $process) {
        $process.Refresh()
        if (-not $process.HasExited) {
            Stop-Process -Id $process.Id -Force -ErrorAction Stop
            $process.WaitForExit(5000) | Out-Null
        }
    }
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        $listeners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
        if ($listeners.Count -eq 0) { return }
        Start-Sleep -Milliseconds 200
    }
    throw 'Temporary Node listener did not release its port; refusing to swap packages.'
}
function Assert-Identity([string]$folder, [string]$identity) {
    $file = Join-Path $folder $marker
    Require-Test (Test-Path -LiteralPath $file -PathType Leaf) "Missing $identity installed package marker."
    Require-Test ((Get-Content -LiteralPath $file -Raw) -eq $identity) "Unexpected installed package identity in $folder."
}

# Use an OS-assigned loopback port, never the public address or live ports.
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = [int]$listener.LocalEndpoint.Port
$listener.Stop()
Require-Test ($port -notin @(3001, 13001, 13002)) 'Temporary port conflicts with a calendar port.'
Require-Test (-not (Test-Path -LiteralPath $root)) 'Temporary folder already exists.'
New-Item -ItemType Directory -Path $root -ErrorAction Stop | Out-Null

try {
    Write-Host "Preparing independently installed npm trees for localhost:$port..."
    Install-ProductionTree $previousSeed 'previous'
    Install-ProductionTree $candidateSeed 'candidate'
    New-Item -ItemType Directory -Path $app -ErrorAction Stop | Out-Null
    Copy-Item -LiteralPath $manifest -Destination (Join-Path $app 'package.json') -ErrorAction Stop
    Copy-Item -LiteralPath $lockfile -Destination (Join-Path $app 'package-lock.json') -ErrorAction Stop
    Move-Item -LiteralPath (Join-Path $previousSeed 'node_modules') -Destination $active -ErrorAction Stop
    Move-Item -LiteralPath (Join-Path $candidateSeed 'node_modules') -Destination $staged -ErrorAction Stop

    # This tiny throwaway server imports actual installed Express and Sharp.
    # It does not import production backend code or create any SQLite database.
    $fixture = @'
const express = require('express')
const sharp = require('sharp')
const fs = require('node:fs')
const path = require('node:path')
const app = express()
app.get('/api/health', async (request, response) => {
  try {
    const bytes = await sharp({
      create: {width: 2, height: 2, channels: 3, background: '#ffffff'}
    }).png().toBuffer()
    response.json({
      status: 'ok',
      identity: fs.readFileSync(path.join(__dirname, 'node_modules', '.calendar-restart-rehearsal.txt'), 'utf8'),
      pid: process.pid,
      imageOk: bytes.length > 8
    })
  } catch (error) {
    response.status(500).json({status: 'error'})
  }
})
app.listen(Number(process.env.CALENDAR_RESTART_REHEARSAL_PORT), '127.0.0.1')
'@
    [IO.File]::WriteAllText((Join-Path $app 'rehearsal-server.cjs'), $fixture)
    Assert-Identity $active 'previous'
    $server = Start-TestServer 'previous-start'
    Wait-Healthy $server 'previous'
    $oldPid = $server.Id
    Write-Host '[PASS] Previous npm installation starts a real loopback Node HTTP service.'
    Stop-TestServer $server
    $server = $null

    Switch-FamilyCalendarDependencies -Active $active -Staged $staged -Previous $previous
    Assert-Identity $active 'candidate'
    Assert-Identity $previous 'previous'
    $server = Start-TestServer 'candidate-start'
    Wait-Healthy $server 'candidate'
    Require-Test ($server.Id -ne $oldPid) 'Candidate server did not restart with a new PID.'
    Write-Host '[PASS] Candidate packages activate and a fresh Node service becomes healthy.'
    Stop-TestServer $server
    $server = $null

    # Break Express only in the disposable candidate tree.
    Rename-Item -LiteralPath (Join-Path $active 'express') -NewName 'express-rehearsal-broken' -ErrorAction Stop
    $server = Start-TestServer 'broken-candidate'
    $server.WaitForExit(10000) | Out-Null
    $server.Refresh()
    Require-Test $server.HasExited 'Broken candidate Node service unexpectedly stayed running.'
    Require-Test ($server.ExitCode -ne 0) 'Broken candidate Node process incorrectly returned success.'
    Stop-TestServer $server
    $server = $null
    Write-Host '[PASS] Damaged candidate is detected as a failed Node restart.'

    Restore-FamilyCalendarDependencies -Active $active -Previous $previous -Rejected $rejected
    Assert-Identity $active 'previous'
    Assert-Identity $rejected 'candidate'
    $server = Start-TestServer 'restored-previous'
    Wait-Healthy $server 'previous'
    Write-Host '[PASS] Previous real npm installation restarts healthy after rejected candidate rollback.'
    Stop-TestServer $server
    $server = $null
    Write-Host ''
    Write-Host 'ISOLATED NODE PROCESS DEPENDENCY RECOVERY PASSED'
    Write-Host 'Real local Node start/stop, package activation, failed restart, rollback and restored health verified.'
    Write-Host 'No live calendar process, port, database, or package directory was touched.'
} finally {
    if ($null -ne $server) {
        try { Stop-TestServer $server } catch { Write-Warning $_.Exception.Message }
    }
    if (Test-Path -LiteralPath $root) {
        Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction Stop
    }
}
