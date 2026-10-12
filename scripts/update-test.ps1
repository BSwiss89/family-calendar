# Updates and builds the separate TEST copy only.
# This script does not change the live calendar, stop the server, or touch the database.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([Security.Principal.WindowsIdentity]::GetCurrent().Name -eq 'NT AUTHORITY\SYSTEM') {
    throw 'Run this script in your interactive Bobby PowerShell session, not as SYSTEM.'
}

$testFolder = Join-Path $env:USERPROFILE 'Projects\family-calendar-test'
$gitFolder = Join-Path $testFolder '.git'

if (-not (Test-Path -LiteralPath $gitFolder)) {
    throw "Test repository not found: $testFolder"
}

$origin = (& git -C $testFolder remote get-url origin).Trim()
if ($LASTEXITCODE -ne 0 -or $origin -ne 'git@github.com:BSwiss89/family-calendar.git') {
    throw "Unexpected GitHub remote: $origin"
}

$branch = (& git -C $testFolder branch --show-current).Trim()
if ($LASTEXITCODE -ne 0 -or $branch -ne 'main') {
    throw "Expected the test copy to be on main; found: $branch"
}

$uncommitted = @(& git -C $testFolder status --porcelain)
if ($LASTEXITCODE -ne 0) {
    throw 'Could not check working tree status.'
}
if ($uncommitted.Count -gt 0) {
    throw 'Test copy has local changes. Review them before updating.'
}

Write-Host 'Fetching approved GitHub code into the testing copy...'
& git -C $testFolder fetch origin main
if ($LASTEXITCODE -ne 0) {
    throw 'Git fetch failed. Live calendar is untouched.'
}

& git -C $testFolder merge --ff-only origin/main
if ($LASTEXITCODE -ne 0) {
    throw 'Git update could not fast-forward. Live calendar is untouched.'
}

Push-Location $testFolder
try {
    Write-Host 'Installing test dependencies...'
    & npm.cmd ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) {
        throw 'Test dependency installation failed. Live calendar is untouched.'
    }

    Write-Host 'Building test frontend...'
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) {
        throw 'Test build failed. Live calendar is untouched.'
    }

    Write-Host ''
    Write-Host 'TEST BUILD PASSED. No changes were made to the live calendar.'
    & git log -1 --format='%h %s'
} finally {
    Pop-Location
}
