# Rehearse one coordinated Git-backend/frontend/npm rollback with a live test Node process.
# ALL modifications happen inside a unique disposable Windows Temp folder.
# Never invoke a production task, listener, Git repository or household database.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'dependency-swap.ps1')

$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$sourceManifest = Join-Path $repo 'package.json'
$sourceLock = Join-Path $repo 'package-lock.json'
$checker = Join-Path $PSScriptRoot 'verify-staged-dependencies.mjs'
$node = (Get-Command node.exe -ErrorAction Stop).Source
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$git = (Get-Command git.exe -ErrorAction Stop).Source
$root = Join-Path ([IO.Path]::GetTempPath()) ('CalendarCombinedRollback-' + [guid]::NewGuid().ToString('N'))
$app = Join-Path $root 'throwaway-git-checkout'
$serverFile = Join-Path $app 'Server\index.cjs'
$activePackages = Join-Path $app 'node_modules'
$activeDist = Join-Path $app 'dist'
$oldSeed = Join-Path $root 'previous-package-install'
$newSeed = Join-Path $root 'candidate-package-install'
$stagedPackages = Join-Path $root 'staged-node_modules'
$stagedDist = Join-Path $root 'staged-dist'
$recovery = Join-Path $root 'recovery-artifacts'
$previousPackages = Join-Path $recovery 'previous-node_modules'
$rejectedPackages = Join-Path $recovery 'rejected-node_modules'
$previousDist = Join-Path $recovery 'previous-dist'
$rejectedDist = Join-Path $recovery 'rejected-dist'
$server = $null

function Require-Test([bool]$ok, [string]$message) {
    if (-not $ok) { throw "Combined release/rollback rehearsal failed: $message" }
}
function Check-Git([string]$label) {
    if ($LASTEXITCODE -ne 0) { throw "Temporary Git operation failed: $label" }
}
function Build-Packages([string]$folder) {
    New-Item -ItemType Directory -Path $folder -ErrorAction Stop | Out-Null
    Copy-Item -LiteralPath $sourceManifest -Destination (Join-Path $folder 'package.json') -ErrorAction Stop
    Copy-Item -LiteralPath $sourceLock -Destination (Join-Path $folder 'package-lock.json') -ErrorAction Stop
    Push-Location $folder
    try {
        & $npm ci --omit=dev --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'Disposable npm installation failed.' }
    } finally { Pop-Location }
    & $node $checker $folder
    if ($LASTEXITCODE -ne 0) { throw 'Disposable npm runtime smoke test failed.' }
}
function Start-RehearsalServer([string]$name) {
    $stdout = Join-Path $root ($name + '-out.log')
    $stderr = Join-Path $root ($name + '-err.log')
    $prior = [Environment]::GetEnvironmentVariable('CALENDAR_COMBINED_REHEARSAL_PORT', 'Process')
    try {
        $env:CALENDAR_COMBINED_REHEARSAL_PORT = [string]$port
        return Start-Process -FilePath $node -ArgumentList 'Server/index.cjs' -WorkingDirectory $app -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr -ErrorAction Stop
    } finally {
        [Environment]::SetEnvironmentVariable('CALENDAR_COMBINED_REHEARSAL_PORT', $prior, 'Process')
    }
}
function Wait-OldHealthy([System.Diagnostics.Process]$process) {
    for ($i = 0; $i -lt 45; $i++) {
        $process.Refresh()
        if ($process.HasExited) { throw 'Original temporary server exited unexpectedly.' }
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 2 -ErrorAction Stop
            if ($health.status -eq 'ok' -and $health.version -eq 'previous' -and
                $health.imageOk -eq $true -and [int]$health.pid -eq $process.Id) {
                $page = Invoke-WebRequest -Uri "http://127.0.0.1:$port/" -TimeoutSec 3 -UseBasicParsing
                Require-Test ($page.StatusCode -eq 200 -and $page.Content.Trim() -eq '<html>previous frontend</html>') 'Original frontend was not restored.'
                return
            }
            throw 'Unexpected temporary health response while checking previous version.'
        } catch {
            if ($_.Exception.Message -like 'Unexpected temporary health*' -or
                $_.Exception.Message -like 'Combined release/rollback rehearsal failed*') { throw }
            Start-Sleep -Milliseconds 250
        }
    }
    throw 'Original temporary backend did not recover HTTP health.'
}
function Stop-RehearsalServer([System.Diagnostics.Process]$process) {
    if ($null -ne $process) {
        $process.Refresh()
        if (-not $process.HasExited) {
            Stop-Process -Id $process.Id -Force -ErrorAction Stop
            $process.WaitForExit(5000) | Out-Null
        }
    }
    for ($i = 0; $i -lt 30; $i++) {
        if (@(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue).Count -eq 0) { return }
        Start-Sleep -Milliseconds 200
    }
    throw 'Temporary server port not released; refusing to switch any files.'
}

$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = [int]$listener.LocalEndpoint.Port
$listener.Stop()
Require-Test ($port -notin @(3001, 13001, 13002)) 'Isolated test port overlaps a calendar port.'
Require-Test (-not (Test-Path -LiteralPath $root)) 'Unique disposable directory collision.'
New-Item -ItemType Directory -Path $root -ErrorAction Stop | Out-Null

try {
    Build-Packages $oldSeed
    Build-Packages $newSeed
    New-Item -ItemType Directory -Path (Join-Path $app 'Server') -Force -ErrorAction Stop | Out-Null
    New-Item -ItemType Directory -Path $activeDist -ErrorAction Stop | Out-Null
    New-Item -ItemType Directory -Path $stagedDist -ErrorAction Stop | Out-Null
    New-Item -ItemType Directory -Path $recovery -ErrorAction Stop | Out-Null
    Copy-Item -LiteralPath $sourceManifest -Destination (Join-Path $app 'package.json') -ErrorAction Stop
    Copy-Item -LiteralPath $sourceLock -Destination (Join-Path $app 'package-lock.json') -ErrorAction Stop
    Move-Item -LiteralPath (Join-Path $oldSeed 'node_modules') -Destination $activePackages -ErrorAction Stop
    Move-Item -LiteralPath (Join-Path $newSeed 'node_modules') -Destination $stagedPackages -ErrorAction Stop
    [IO.File]::WriteAllText((Join-Path $activeDist 'index.html'), '<html>previous frontend</html>')
    [IO.File]::WriteAllText((Join-Path $stagedDist 'index.html'), '<html>candidate frontend</html>')

    # This is ONLY a toy health server. Production Server/index.mjs is not executed.
    $oldCode = @'
const express = require('express')
const sharp = require('sharp')
const path = require('node:path')
const app = express()
app.get('/api/health', async (req, res) => {
  try {
    const bytes = await sharp({create: {
      width: 2, height: 2, channels: 3, background: '#ffffff'
    }}).png().toBuffer()
    res.json({status: 'ok', version: 'previous', pid: process.pid, imageOk: bytes.length > 8})
  } catch (error) {
    res.status(500).json({status: 'error'})
  }
})
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'dist', 'index.html')))
app.listen(Number(process.env.CALENDAR_COMBINED_REHEARSAL_PORT), '127.0.0.1')
'@
    [IO.File]::WriteAllText($serverFile, $oldCode)
    # These are release artifacts, not Git-tracked contents of the toy Server file.
    [IO.File]::WriteAllText((Join-Path $app '.gitignore'), "node_modules/`ndist/`n")
    & $git init -b main $app | Out-Null
    Check-Git 'init'
    & $git -C $app config user.name 'Calendar Release Safety Test'
    Check-Git 'set user name'
    & $git -C $app config user.email 'test@localhost.invalid'
    Check-Git 'set user email'
    & $git -C $app add Server/index.cjs package.json package-lock.json .gitignore
    Check-Git 'stage old backend and approved manifests'
    & $git -C $app commit -m 'Previous working backend' | Out-Null
    Check-Git 'record previous backend'
    $oldCommit = (& $git -C $app rev-parse HEAD).Trim()
    Check-Git 'identify old commit'

    [IO.File]::WriteAllText($serverFile, "throw new Error('Injected candidate startup failure')" + [Environment]::NewLine)
    & $git -C $app add Server/index.cjs
    Check-Git 'stage failing backend'
    & $git -C $app commit -m 'Candidate intentionally fails startup' | Out-Null
    Check-Git 'record failing backend'
    $newCommit = (& $git -C $app rev-parse HEAD).Trim()
    Check-Git 'identify candidate commit'
    & $git -C $app branch approved-candidate $newCommit
    Check-Git 'mark candidate ref'
    & $git -C $app reset --hard $oldCommit | Out-Null
    Check-Git 'reset disposable checkout to previous version'

    $server = Start-RehearsalServer 'working-before-release'
    Wait-OldHealthy $server
    $oldPid = $server.Id
    Write-Host '[PASS] Previous backend Git commit, frontend HTML, Express and Sharp are healthy.'
    Stop-RehearsalServer $server
    $server = $null

    # Mirror the production transaction order after successful safe preflights.
    Switch-FamilyCalendarDependencies -Active $activePackages -Staged $stagedPackages -Previous $previousPackages
    & $git -C $app merge --ff-only approved-candidate | Out-Null
    Check-Git 'fast-forward simulated release'
    Move-Item -LiteralPath $activeDist -Destination $previousDist -ErrorAction Stop
    Move-Item -LiteralPath $stagedDist -Destination $activeDist -ErrorAction Stop
    $head = (& $git -C $app rev-parse HEAD).Trim()
    Check-Git 'identify activated commit'
    Require-Test ($head -eq $newCommit) 'Candidate backend commit not activated.'
    Require-Test ((Get-Content -LiteralPath (Join-Path $activeDist 'index.html') -Raw) -eq '<html>candidate frontend</html>') 'Candidate frontend not activated.'
    Write-Host '[PASS] Backend Git commit, frontend HTML and real npm candidate activated together.'

    $server = Start-RehearsalServer 'expected-startup-failure'
    $server.WaitForExit(10000) | Out-Null
    $server.Refresh()
    Require-Test $server.HasExited 'Broken backend startup was not detected.'
    Require-Test ($server.ExitCode -ne 0) 'Broken backend falsely returned success.'
    Stop-RehearsalServer $server
    $server = $null
    Write-Host '[PASS] Deliberate candidate backend process failure detected after whole-release activation.'

    # Roll back all three release assets while the throwaway server is stopped.
    Restore-FamilyCalendarDependencies -Active $activePackages -Previous $previousPackages -Rejected $rejectedPackages
    Move-Item -LiteralPath $activeDist -Destination $rejectedDist -ErrorAction Stop
    Move-Item -LiteralPath $previousDist -Destination $activeDist -ErrorAction Stop
    & $git -C $app reset --hard $oldCommit | Out-Null
    Check-Git 'restore previous backend commit'
    $restored = (& $git -C $app rev-parse HEAD).Trim()
    Check-Git 'inspect restored commit'
    Require-Test ($restored -eq $oldCommit) 'Backend Git did not roll back.'
    Require-Test ((Test-Path -LiteralPath $rejectedPackages -PathType Container)) 'Rejected npm packages not preserved.'
    Require-Test ((Test-Path -LiteralPath $rejectedDist -PathType Container)) 'Rejected frontend not preserved.'
    $gitStatus = @(& $git -C $app status --porcelain)
    Check-Git 'inspect final Git checkout'
    Require-Test ($gitStatus.Count -eq 0) 'Backend Git checkout is dirty after rollback.'
    $server = Start-RehearsalServer 'recovered-after-rejected-release'
    Wait-OldHealthy $server
    Require-Test ($server.Id -ne $oldPid) 'Restored backend did not start in a new Node process.'
    Write-Host '[PASS] Restored previous backend Git commit, HTML, real npm dependencies and HTTP health.'
    Stop-RehearsalServer $server
    $server = $null

    Write-Host ''
    Write-Host 'COMBINED BACKEND FRONTEND DEPENDENCY ROLLBACK PASSED'
    Write-Host 'All Git, npm, Node and frontend changes were isolated to a disposable temporary folder.'
    Write-Host 'No live calendar task, data, repository, listener, or packages were touched.'
} finally {
    if ($null -ne $server) {
        try { Stop-RehearsalServer $server } catch { Write-Warning $_.Exception.Message }
    }
    if (Test-Path -LiteralPath $root) {
        Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction Stop
    }
}
