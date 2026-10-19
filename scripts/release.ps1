# One-command release entrypoint for approved GitHub main changes.
# Default: update and build the isolated TEST copy, then preview the correct guarded deployer.
# -Apply: explicitly authorize the selected deployer to deploy after its own safety checks.
# Never upload SQLite data or personal files to GitHub.

param([switch]$Apply)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$test = Join-Path $env:USERPROFILE 'Projects\family-calendar-test'
$live = Join-Path $env:USERPROFILE 'Projects\family-calendar'
$expectedOrigin = 'git@github.com:BSwiss89/family-calendar.git'

function Assert-Repository([string]$folder, [string]$label) {
    if (-not (Test-Path -LiteralPath (Join-Path $folder '.git'))) {
        throw "$label Git checkout not found: $folder"
    }

    $actualOrigin = (& git -C $folder remote get-url origin).Trim()
    if ($LASTEXITCODE -ne 0 -or $actualOrigin -ne $expectedOrigin) {
        throw "$label has an unexpected Git remote. No deployment attempted."
    }

    $branch = (& git -C $folder branch --show-current).Trim()
    if ($LASTEXITCODE -ne 0 -or $branch -ne 'main') {
        throw "$label must be on main. No deployment attempted."
    }

    $worktree = @(& git -C $folder status --porcelain)
    if ($LASTEXITCODE -ne 0 -or $worktree.Count -ne 0) {
        throw "$label working tree is not clean. No deployment attempted."
    }
}

Write-Host 'FAMILY CALENDAR - GITHUB RELEASE'
if (-not $Apply) {
    Write-Host 'PREVIEW: the test copy will be updated and built; live will not be changed.'
} else {
    Write-Host 'APPLY REQUESTED: a guarded deployer will validate the release before changing live.'
}

Assert-Repository $test 'Test'
Assert-Repository $live 'Live'

$updateTest = Join-Path $test 'scripts\update-test.ps1'
if (-not (Test-Path -LiteralPath $updateTest)) {
    throw 'Missing test updater. Nothing deployed.'
}

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $updateTest
if ($LASTEXITCODE -ne 0) {
    throw 'Test update/build failed. Live calendar unchanged.'
}

Assert-Repository $test 'Test'
Assert-Repository $live 'Live'

$from = (& git -C $live rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Could not read live commit.' }
$to = (& git -C $test rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Could not read tested commit.' }

& git -C $test merge-base --is-ancestor $from $to
if ($LASTEXITCODE -ne 0) {
    throw 'Live and test history are incompatible. No deployment attempted.'
}

if ($from -eq $to) {
    Write-Host 'ALREADY UP TO DATE: live matches GitHub main.'
    return
}

$changed = @(& git -C $test diff --name-only "$from..$to")
if ($LASTEXITCODE -ne 0 -or $changed.Count -eq 0) {
    throw 'Could not determine the proposed release files.'
}

$previewGate = Join-Path $test 'scripts\check-private-preview-release-scope.mjs'
if (-not (Test-Path -LiteralPath $previewGate)) {
    throw 'PRIVATE MULTI-FAMILY PREVIEW RELEASE BLOCKED: release guard is missing.'
}
& node $previewGate @changed | Out-Host
if ($LASTEXITCODE -ne 0) {
    throw 'PRIVATE MULTI-FAMILY PREVIEW RELEASE BLOCKED: draft-only household files need a separate reviewed release.'
}

$frontendAllowed = '^(src/|public/|\.github/|scripts/|docs/|index\.html$|README\.md$|\.gitignore$|eslint\.config\.js$|vite\.config\.ts$|tsconfig(?:\.[^/]+)?\.json$)'
$notFrontend = @($changed | Where-Object { $_ -notmatch $frontendAllowed })
if ($changed -contains 'package.json') {
    & node (Join-Path $test 'scripts\check-pwa-prebuild-only.mjs') $test $from $to | Out-Host
    if ($LASTEXITCODE -eq 0) {
        $notFrontend = @($notFrontend | Where-Object { $_ -ne 'package.json' })
    } else {
        Write-Host 'package.json requires strict dependency review.'
    }
}
$mode = if ($notFrontend.Count -eq 0) { 'frontend' } else { 'backend' }
$releaseScript = Join-Path $test ("scripts\deploy-$mode.ps1")

Write-Host ''
Write-Host "Live: $($from.Substring(0,7))"
Write-Host "Approved test: $($to.Substring(0,7))"
Write-Host 'Changed files:'
$changed | ForEach-Object { Write-Host "  $_" }
Write-Host "Selected guarded release: $mode"
if ($mode -eq 'backend') {
    Write-Host 'Backend/unknown changes require the existing strict backend review and may cause a short calendar restart.'
} else {
    Write-Host 'Frontend-only changes do not require a server restart.'
}

if (-not (Test-Path -LiteralPath $releaseScript)) {
    throw "Required guarded deployer missing: $releaseScript"
}

if ($Apply) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $releaseScript -Apply
} else {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $releaseScript
}
if ($LASTEXITCODE -ne 0) {
    throw "The guarded $mode deployment stopped or failed. Inspect its output; do not retry an incomplete rollback."
}

if (-not $Apply) {
    Write-Host ''
    Write-Host 'GITHUB RELEASE PREVIEW PASSED; live calendar unchanged.'
    Write-Host 'Review the changed files before running this same command with -Apply.'
}
