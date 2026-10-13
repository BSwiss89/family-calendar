# Rehearse one coordinated Git-backend/frontend/npm rollback with a live test Node process.
# ALL modifications happen inside a unique disposable Windows Temp folder.
# Never invoke a production task, listener, Git repository or household database.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'release-bundle-rollback.ps1')

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

    # Make this a real package upgrade/downgrade rehearsal, not two identical
    # node_modules trees. Change ONLY disposable candidate manifest + lockfile.
    $previousExpress = (Get-Content -LiteralPath (Join-Path $oldSeed 'node_modules\express\package.json') -Raw | ConvertFrom-Json).version
    $alternateExpress = if ($previousExpress -eq '5.1.0') { '5.2.1' } else { '5.1.0' }
    Push-Location $newSeed
    try {
        & $npm install ('express@' + $alternateExpress) --save-exact --package-lock-only --ignore-scripts --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'Disposable candidate manifest/lockfile change failed.' }
        & $npm ci --omit=dev --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'Changed candidate npm installation failed.' }
    } finally { Pop-Location }
    & $node $checker $newSeed
    if ($LASTEXITCODE -ne 0) { throw 'Changed candidate npm dependency verification failed.' }
    $candidateExpress = (Get-Content -LiteralPath (Join-Path $newSeed 'node_modules\express\package.json') -Raw | ConvertFrom-Json).version
    Require-Test ($candidateExpress -eq $alternateExpress -and $candidateExpress -ne $previousExpress) 'Candidate must have a different installed Express version.'
    $originalManifestHash = (Get-FileHash -LiteralPath $sourceManifest -Algorithm SHA256).Hash
    $originalLockHash = (Get-FileHash -LiteralPath $sourceLock -Algorithm SHA256).Hash
    Require-Test ((Get-FileHash -LiteralPath (Join-Path $newSeed 'package.json') -Algorithm SHA256).Hash -ne $originalManifestHash) 'Candidate package.json must differ from original.'
    Require-Test ((Get-FileHash -LiteralPath (Join-Path $newSeed 'package-lock.json') -Algorithm SHA256).Hash -ne $originalLockHash) 'Candidate lockfile must differ from original.'
    Write-Host "[PASS] Real npm dependency difference: Express $previousExpress -> $candidateExpress; manifest and lockfile both changed."
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
    Copy-Item -LiteralPath (Join-Path $newSeed 'package.json') -Destination (Join-Path $app 'package.json') -Force -ErrorAction Stop
    Copy-Item -LiteralPath (Join-Path $newSeed 'package-lock.json') -Destination (Join-Path $app 'package-lock.json') -Force -ErrorAction Stop
    & $git -C $app add Server/index.cjs package.json package-lock.json
    Check-Git 'stage failing backend and changed npm manifest/lockfile'
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

    # A pre-existing rejected-assets location must block recovery before any
    # package, dist, or Git mutation. Remove only our disposable collision.
    New-Item -ItemType Directory -Path $rejectedDist -ErrorAction Stop | Out-Null
    $refusedCollision = $false
    try {
        Restore-FamilyCalendarReleaseBundle -Repository $app `
            -PreviousCommit $oldCommit -CandidateCommit $newCommit `
            -ActiveFrontend $activeDist -PreviousFrontend $previousDist -RejectedFrontend $rejectedDist `
            -ActiveDependencies $activePackages -PreviousDependencies $previousPackages -RejectedDependencies $rejectedPackages
    } catch {
        $refusedCollision = $true
    }
    Require-Test $refusedCollision 'Existing recovery destination should refuse the restore.'
    $headAfterRefusal = (& $git -C $app rev-parse HEAD).Trim()
    Check-Git 'inspect Git after refused recovery'
    Require-Test ($headAfterRefusal -eq $newCommit -and
        (Test-Path -LiteralPath $previousPackages -PathType Container) -and
        (Test-Path -LiteralPath $previousDist -PathType Container)) 'Refused recovery modified a source or candidate.'
    Remove-Item -LiteralPath $rejectedDist -Force -ErrorAction Stop
    Write-Host '[PASS] Existing rejected-asset collision blocks recovery without changes.'

    $server = Start-RehearsalServer 'expected-startup-failure'
    $server.WaitForExit(10000) | Out-Null
    $server.Refresh()
    Require-Test $server.HasExited 'Broken backend startup was not detected.'
    Require-Test ($server.ExitCode -ne 0) 'Broken backend falsely returned success.'
    Stop-RehearsalServer $server
    $server = $null
    Write-Host '[PASS] Deliberate candidate backend process failure detected after whole-release activation.'

    # Reuse the same rollback primitive intended for guarded production.
    # The throwaway Node process is stopped before this function is invoked.
    Restore-FamilyCalendarReleaseBundle -Repository $app `
        -PreviousCommit $oldCommit -CandidateCommit $newCommit `
        -ActiveFrontend $activeDist -PreviousFrontend $previousDist -RejectedFrontend $rejectedDist `
        -ActiveDependencies $activePackages -PreviousDependencies $previousPackages -RejectedDependencies $rejectedPackages
    $restored = (& $git -C $app rev-parse HEAD).Trim()
    Check-Git 'inspect restored commit'
    Require-Test ($restored -eq $oldCommit) 'Backend Git did not roll back.'
    Require-Test ((Test-Path -LiteralPath $rejectedPackages -PathType Container)) 'Rejected npm packages not preserved.'
    Require-Test ((Test-Path -LiteralPath $rejectedDist -PathType Container)) 'Rejected frontend not preserved.'
    $restoredExpress = (Get-Content -LiteralPath (Join-Path $activePackages 'express\package.json') -Raw | ConvertFrom-Json).version
    $rejectedExpress = (Get-Content -LiteralPath (Join-Path $rejectedPackages 'express\package.json') -Raw | ConvertFrom-Json).version
    Require-Test ($restoredExpress -eq $previousExpress -and $rejectedExpress -eq $candidateExpress) 'Rollback failed to recover original npm version or retain changed candidate.'
    Require-Test ((Get-FileHash -LiteralPath (Join-Path $app 'package.json') -Algorithm SHA256).Hash -eq $originalManifestHash) 'Rollback did not restore original package manifest.'
    Require-Test ((Get-FileHash -LiteralPath (Join-Path $app 'package-lock.json') -Algorithm SHA256).Hash -eq $originalLockHash) 'Rollback did not restore original package lockfile.'
    Write-Host '[PASS] Previous Express version, original manifest and lockfile restored; different candidate packages preserved.'
    $gitStatus = @(& $git -C $app status --porcelain)
    Check-Git 'inspect final Git checkout'
    Require-Test ($gitStatus.Count -eq 0) 'Backend Git checkout is dirty after rollback.'
    $server = Start-RehearsalServer 'recovered-after-rejected-release'
    Wait-OldHealthy $server
    Require-Test ($server.Id -ne $oldPid) 'Restored backend did not start in a new Node process.'
    Write-Host '[PASS] Restored previous backend Git commit, HTML, real npm dependencies and HTTP health.'
    Stop-RehearsalServer $server
    $server = $null

    # Create a DIFFERENT candidate commit from original code, without any
    # package changes, to match the guarded production code-only release policy.
    [IO.File]::WriteAllText($serverFile, "throw new Error('Injected code-only startup failure')" + [Environment]::NewLine)
    & $git -C $app add Server/index.cjs
    Check-Git 'stage separate code-only candidate'
    & $git -C $app commit -m 'Different candidate with only backend code changed' | Out-Null
    Check-Git 'commit code-only candidate'
    $codeOnlyCommit = (& $git -C $app rev-parse HEAD).Trim()
    Check-Git 'read code-only commit'
    & $git -C $app branch approved-code-only $codeOnlyCommit
    Check-Git 'mark separate code-only ref'
    & $git -C $app reset --hard $oldCommit | Out-Null
    Check-Git 'reset temporary checkout before code-only rehearsal'
    $unchangedModule = Join-Path $activePackages 'express/package.json'
    $beforeModules = (Get-FileHash -LiteralPath $unchangedModule -Algorithm SHA256).Hash
    & $git -C $app merge --ff-only approved-code-only | Out-Null
    Check-Git 'activate separate code-only failing candidate'
    $previousDistOnly = Join-Path $recovery 'previous-code-only-dist'
    $rejectedDistOnly = Join-Path $recovery 'rejected-code-only-dist'
    Move-Item -LiteralPath $activeDist -Destination $previousDistOnly -ErrorAction Stop
    New-Item -ItemType Directory -Path $activeDist -ErrorAction Stop | Out-Null
    [IO.File]::WriteAllText((Join-Path $activeDist 'index.html'), '<html>failing code-only frontend</html>')

    # Refuse a collision before moving frontend or resetting Git.
    New-Item -ItemType Directory -Path $rejectedDistOnly -ErrorAction Stop | Out-Null
    $codeOnlyRestore = @{
        Repository = $app
        PreviousCommit = $oldCommit
        CandidateCommit = $codeOnlyCommit
        ActiveFrontend = $activeDist
        PreviousFrontend = $previousDistOnly
        RejectedFrontend = $rejectedDistOnly
    }
    $collisionRefused = $false
    try {
        Restore-FamilyCalendarCodeAndFrontend @codeOnlyRestore
    } catch {
        $collisionRefused = $true
    }
    Require-Test $collisionRefused 'Code-only recovery must refuse backup destination collision.'
    $collidedHead = (& $git -C $app rev-parse HEAD).Trim()
    Check-Git 'inspect refused code-only recovery'
    Require-Test ($collidedHead -eq $codeOnlyCommit -and
        (Test-Path -LiteralPath $previousDistOnly -PathType Container) -and
        (Test-Path -LiteralPath $activeDist -PathType Container)) 'Refused code-only restore modified checkout or frontend.'
    Remove-Item -LiteralPath $rejectedDistOnly -Force -ErrorAction Stop
    Write-Host '[PASS] Code-only restore rejects a recovery collision before making changes.'

    $server = Start-RehearsalServer 'code-only-expected-failure'
    $server.WaitForExit(10000) | Out-Null
    $server.Refresh()
    Require-Test ($server.HasExited -and $server.ExitCode -ne 0) 'Deliberately broken code-only server did not fail startup.'
    Stop-RehearsalServer $server
    $server = $null
    Restore-FamilyCalendarCodeAndFrontend @codeOnlyRestore
    $afterModules = (Get-FileHash -LiteralPath $unchangedModule -Algorithm SHA256).Hash
    Require-Test ($beforeModules -eq $afterModules) 'Code/frontend rollback unexpectedly changed npm modules.'
    $server = Start-RehearsalServer 'code-only-recovered'
    Wait-OldHealthy $server
    Stop-RehearsalServer $server
    $server = $null
    Write-Host '[PASS] Code/frontend-only failure recovered with unchanged npm packages and healthy Node HTTP response.'

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
