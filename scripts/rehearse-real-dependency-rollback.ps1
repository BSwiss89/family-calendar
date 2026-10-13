# Exercise the production package switch/restore helpers with real installed npm modules.
# Operates exclusively in a unique disposable Windows temporary directory.
# Does NOT stop or modify any running calendar or deploy packages to live.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'dependency-swap.ps1')

$source = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$manifest = Join-Path $source 'package.json'
$lockfile = Join-Path $source 'package-lock.json'
$checker = Join-Path $PSScriptRoot 'verify-staged-dependencies.mjs'
foreach ($input in @($manifest, $lockfile, $checker)) {
    if (-not (Test-Path -LiteralPath $input -PathType Leaf)) {
        throw "Missing npm dependency test input: $input"
    }
}
$node = (Get-Command node.exe -ErrorAction Stop).Source
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$root = Join-Path ([IO.Path]::GetTempPath()) ('FamilyCalendarRealPackageRollback-' + [guid]::NewGuid().ToString('N'))
$oldSeed = Join-Path $root 'old-install'
$newSeed = Join-Path $root 'candidate-install'
$workspace = Join-Path $root 'application'
$active = Join-Path $workspace 'node_modules'
$stage = Join-Path $root 'staged-node_modules'
$previous = Join-Path $root 'previous-node_modules'
$rejected = Join-Path $root 'rejected-node_modules'
$marker = '.family-calendar-rehearsal-version.txt'

function Assert-Test([bool]$condition, [string]$reason) {
    if (-not $condition) { throw "Real-package rollback test failed: $reason" }
}
function Assert-Marker([string]$folder, [string]$identity) {
    $file = Join-Path $folder $marker
    Assert-Test ((Test-Path -LiteralPath $file -PathType Leaf) -and
        ((Get-Content -LiteralPath $file -Raw) -eq $identity)) "Expected identity $identity at $folder"
}
function Prepare-Install([string]$directory, [string]$identity) {
    New-Item -ItemType Directory -Path $directory -ErrorAction Stop | Out-Null
    Copy-Item -LiteralPath $manifest -Destination (Join-Path $directory 'package.json') -ErrorAction Stop
    Copy-Item -LiteralPath $lockfile -Destination (Join-Path $directory 'package-lock.json') -ErrorAction Stop
    Push-Location $directory
    try {
        & $npm ci --omit=dev --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw "npm ci failed for $identity" }
        & $npm ls --omit=dev --depth=0
        if ($LASTEXITCODE -ne 0) { throw "npm ls failed for $identity" }
    } finally {
        Pop-Location
    }
    & $node $checker $directory
    if ($LASTEXITCODE -ne 0) { throw "Runtime package checks failed for $identity" }
    Set-Content -LiteralPath (Join-Path $directory 'node_modules' $marker) -Value $identity -NoNewline
}

if (Test-Path -LiteralPath $root) { throw 'Unexpected duplicate disposable test folder.' }
New-Item -ItemType Directory -Path $root -ErrorAction Stop | Out-Null
try {
    Write-Host 'Preparing two fully installed, independent real npm production package trees...'
    Prepare-Install $oldSeed 'previous-real-packages'
    Prepare-Install $newSeed 'candidate-real-packages'

    New-Item -ItemType Directory -Path $workspace -ErrorAction Stop | Out-Null
    Copy-Item -LiteralPath $manifest -Destination (Join-Path $workspace 'package.json') -ErrorAction Stop
    Copy-Item -LiteralPath $lockfile -Destination (Join-Path $workspace 'package-lock.json') -ErrorAction Stop
    Move-Item -LiteralPath (Join-Path $oldSeed 'node_modules') -Destination $active -ErrorAction Stop
    Move-Item -LiteralPath (Join-Path $newSeed 'node_modules') -Destination $stage -ErrorAction Stop

    Assert-Marker $active 'previous-real-packages'
    & $node $checker $workspace
    if ($LASTEXITCODE -ne 0) { throw 'Previous package installation was not healthy.' }
    Write-Host '[PASS] Previous real package installation resolves and Sharp processes images.'

    Switch-FamilyCalendarDependencies -Active $active -Staged $stage -Previous $previous
    Assert-Marker $active 'candidate-real-packages'
    Assert-Marker $previous 'previous-real-packages'
    & $node $checker $workspace
    if ($LASTEXITCODE -ne 0) { throw 'Candidate package installation failed after activation.' }
    Write-Host '[PASS] Activated candidate packages work in their final npm module path.'

    # Simulate a corrupt package after activation. This affects only the temp directory.
    Rename-Item -LiteralPath (Join-Path $active 'sharp') -NewName 'sharp-rehearsal-broken' -ErrorAction Stop
    $stdout = Join-Path $root 'expected-failure-out.log'
    $stderr = Join-Path $root 'expected-failure-err.log'
    $broken = Start-Process -FilePath $node -ArgumentList @($checker, $workspace) -Wait -PassThru -NoNewWindow -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    Assert-Test ($broken.ExitCode -ne 0) 'Corrupt candidate installation incorrectly passed the runtime check.'
    Write-Host '[PASS] Deliberately broken real candidate package is rejected by the runtime verifier.'

    Restore-FamilyCalendarDependencies -Active $active -Previous $previous -Rejected $rejected
    Assert-Marker $active 'previous-real-packages'
    Assert-Marker $rejected 'candidate-real-packages'
    & $node $checker $workspace
    if ($LASTEXITCODE -ne 0) { throw 'Previous package installation failed health verification after recovery.' }
    Write-Host '[PASS] Former real npm package installation fully healthy after rollback.'
    Write-Host ''
    Write-Host 'REAL NPM DEPENDENCY ROLLBACK REHEARSAL PASSED'
    Write-Host 'Old/candidate copies use the current lockfile but separate real npm installations.'
    Write-Host 'Only a unique disposable folder was changed; no live processes or data touched.'
} finally {
    if (Test-Path -LiteralPath $root) {
        Remove-Item -LiteralPath $root -Force -Recurse -ErrorAction Stop
    }
}
