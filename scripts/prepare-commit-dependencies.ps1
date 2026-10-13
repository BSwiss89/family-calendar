# Prepare an exact-GitHub-commit production npm tree outside the application.
# Deliberately does NOT touch live node_modules, start/stop services, or modify DBs.
# This is preparatory work; existing automated dependency-change block is unchanged.
param([string]$Commit = '')

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$homePath = 'C:\Users\bobby'
$test = Join-Path $homePath 'Projects\family-calendar-test'
$live = Join-Path $homePath 'Projects\family-calendar'
$parent = Join-Path $homePath 'Projects\family-calendar-release-backups\dependency-candidates'
$origin = 'git@github.com:BSwiss89/family-calendar.git'

if (-not [string]::Equals($env:USERPROFILE, $homePath, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Only the authorized laptop profile may stage dependencies.'
}
if ([Security.Principal.WindowsIdentity]::GetCurrent().Name -eq 'NT AUTHORITY\SYSTEM') {
    throw 'Dependency staging must not run as SYSTEM.'
}
foreach ($repo in @($test, $live)) {
    if (-not (Test-Path -LiteralPath (Join-Path $repo '.git'))) { throw "Missing checkout: $repo" }
    $url = (& git -C $repo remote get-url origin).Trim()
    if ($LASTEXITCODE -ne 0 -or $url -ne $origin) { throw "Unexpected GitHub origin: $repo" }
    $dirty = @(& git -C $repo status --porcelain)
    if ($LASTEXITCODE -ne 0 -or $dirty.Count -ne 0) { throw "Dirty Git working tree: $repo" }
}
$branch = (& git -C $test branch --show-current).Trim()
if ($LASTEXITCODE -ne 0 -or $branch -ne 'main') {
    throw 'Only the test checkout on main may stage a dependency release.'
}
$head = (& git -C $test rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $head -notmatch '^[a-f0-9]{40}$') {
    throw 'Could not identify the tested commit.'
}
if ($Commit -ne '' -and $Commit -ne $head) {
    throw 'Requested commit does not match the tested checkout. No packages installed.'
}

# Require an actual bounded GitHub main query rather than trusting a stale
# local origin/main tracking ref or an arbitrary unreviewed test checkout.
. (Join-Path $test 'scripts\get-github-refs.ps1')
$refs = @(Get-FamilyCalendarGitHubRefs -Repository $test -Type Main)
if ($refs.Count -ne 1) {
    throw 'Expected exactly one current GitHub main ref.'
}
$refLine = [string]$refs[0]
if ($refLine -notmatch '^[a-f0-9]{40}\s+refs/heads/main$') {
    throw 'Could not verify current GitHub main commit.'
}
$approved = ($refLine -split '\s+')[0]
if ($approved -ne $head) {
    throw 'Test checkout is not at approved GitHub main. No packages installed.'
}

$manifest = Join-Path $test 'package.json'
$lockfile = Join-Path $test 'package-lock.json'
$checker = Join-Path $test 'scripts\verify-staged-dependencies.mjs'
foreach ($file in @($manifest, $lockfile, $checker)) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
        throw "Required dependency staging file missing: $file"
    }
}
$manifestHash = (Get-FileHash -LiteralPath $manifest -Algorithm SHA256).Hash
$lockHash = (Get-FileHash -LiteralPath $lockfile -Algorithm SHA256).Hash
$node = (Get-Command node.exe -ErrorAction Stop).Source
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$final = Join-Path $parent $head
if (Test-Path -LiteralPath $final) {
    throw "Candidate folder already exists. Review or clear it manually: $final"
}
New-Item -ItemType Directory -Path $parent -Force -ErrorAction Stop | Out-Null
$working = Join-Path $parent ('.building-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $working -ErrorAction Stop | Out-Null

try {
    Copy-Item -LiteralPath $manifest -Destination (Join-Path $working 'package.json') -ErrorAction Stop
    Copy-Item -LiteralPath $lockfile -Destination (Join-Path $working 'package-lock.json') -ErrorAction Stop
    Write-Host "Preparing exact approved GitHub commit $($head.Substring(0,7))"
    Push-Location $working
    try {
        & $npm ci --omit=dev --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'npm ci failed in disposable candidate; live untouched.' }
        & $npm ls --omit=dev --depth=0
        if ($LASTEXITCODE -ne 0) { throw 'Installed npm production dependency tree failed.' }
    } finally {
        Pop-Location
    }

    & $node $checker $working
    if ($LASTEXITCODE -ne 0) { throw 'Runtime dependencies failed verification.' }
    if (-not (Test-Path -LiteralPath (Join-Path $working 'node_modules') -PathType Container)) {
        throw 'Candidate node_modules directory missing after npm ci.'
    }
    if ((Get-FileHash -LiteralPath (Join-Path $working 'package.json') -Algorithm SHA256).Hash -ne $manifestHash -or
        (Get-FileHash -LiteralPath (Join-Path $working 'package-lock.json') -Algorithm SHA256).Hash -ne $lockHash) {
        throw 'Candidate package manifest or lockfile changed during staging.'
    }

    $metadata = [ordered]@{
        approvedCommit = $head
        manifestSha256 = $manifestHash
        lockfileSha256 = $lockHash
        createdAt = (Get-Date).ToUniversalTime().ToString('o')
        status = 'prepared-not-applied'
    }
    $metadata | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $working 'candidate.json') -Encoding UTF8
    # Rename only a candidate directory under the backup parent, never live files.
    [IO.Directory]::Move($working, $final)
    # Reopen the preserved tree and independently recheck SHA binding and imports.
    & $node (Join-Path $test 'scripts\verify-commit-dependencies.mjs') --commit $head
    if ($LASTEXITCODE -ne 0) {
        throw 'Preserved commit candidate verification failed. Inspect existing candidate before retrying.'
    }
    Write-Host ''
    Write-Host 'COMMIT-PINNED DEPENDENCY CANDIDATE PASSED'
    Write-Host "Commit: $head"
    Write-Host "Candidate package tree: $final"
    Write-Host "Package manifest hash: $manifestHash"
    Write-Host "Lockfile hash: $lockHash"
    Write-Host 'Preserved outside live and test; NO LIVE PACKAGE SWITCH PERFORMED.'
} finally {
    if (Test-Path -LiteralPath $working) {
        Remove-Item -LiteralPath $working -Recurse -Force -ErrorAction Stop
    }
}
