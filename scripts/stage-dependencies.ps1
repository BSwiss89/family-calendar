# Prepares and smoke-tests production npm dependencies in an isolated folder.
# Safe to run on the laptop before a dependency-change deployment.
# Does NOT install into live, restart services, or modify SQLite.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$homePath = 'C:\Users\bobby'
$test = Join-Path $homePath 'Projects\family-calendar-test'
$live = Join-Path $homePath 'Projects\family-calendar'
$expectedOrigin = 'git@github.com:BSwiss89/family-calendar.git'
if (-not [string]::Equals($env:USERPROFILE, $homePath, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'This preflight must run under the authorized laptop user.'
}
if ([Security.Principal.WindowsIdentity]::GetCurrent().Name -eq 'NT AUTHORITY\SYSTEM') {
    throw 'Do not run this preflight as SYSTEM.'
}
if (-not (Test-Path (Join-Path $live 'Server\data\calendar.db'))) {
    throw 'Live database path missing; no dependency staging attempted.'
}
if (-not (Test-Path (Join-Path $test '.git'))) { throw 'Test repository missing.' }
$origin = (& git -C $test remote get-url origin).Trim()
if ($LASTEXITCODE -ne 0 -or $origin -ne $expectedOrigin) {
    throw 'Test GitHub origin is unexpected.'
}
$branch = (& git -C $test branch --show-current).Trim()
if ($LASTEXITCODE -ne 0 -or $branch -ne 'main') {
    throw 'Test checkout must be on approved main.'
}
$dirty = @(& git -C $test status --porcelain)
if ($LASTEXITCODE -ne 0 -or $dirty.Count -ne 0) {
    throw 'Test checkout has local changes; refusing preflight.'
}

$manifest = Join-Path $test 'package.json'
$lock = Join-Path $test 'package-lock.json'
$checker = Join-Path $test 'scripts\verify-staged-dependencies.mjs'
foreach ($required in @($manifest, $lock, $checker)) {
    if (-not (Test-Path -LiteralPath $required)) { throw "Missing dependency preflight input: $required" }
}
$manifestHash = (Get-FileHash -LiteralPath $manifest -Algorithm SHA256).Hash
$lockHash = (Get-FileHash -LiteralPath $lock -Algorithm SHA256).Hash

$folder = Join-Path $test ('logs\dependency-preflight-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $folder -Force -ErrorAction Stop | Out-Null
try {
    Copy-Item -LiteralPath $manifest -Destination (Join-Path $folder 'package.json') -ErrorAction Stop
    Copy-Item -LiteralPath $lock -Destination (Join-Path $folder 'package-lock.json') -ErrorAction Stop
    Push-Location $folder
    try {
        Write-Host 'Installing exact production npm dependency versions into disposable staging folder...'
        & npm.cmd ci --omit=dev --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'Staged npm ci failed; live packages untouched.' }

        & npm.cmd ls --omit=dev --depth=0
        if ($LASTEXITCODE -ne 0) { throw 'Staged npm dependency tree failed validation.' }
    } finally {
        Pop-Location
    }

    & node $checker $folder
    if ($LASTEXITCODE -ne 0) { throw 'Staged production dependency smoke test failed.' }
    if ((Get-FileHash -LiteralPath (Join-Path $folder 'package.json') -Algorithm SHA256).Hash -ne $manifestHash -or
        (Get-FileHash -LiteralPath (Join-Path $folder 'package-lock.json') -Algorithm SHA256).Hash -ne $lockHash) {
        throw 'Installed dependency staging modified an approved package manifest or lockfile.'
    }
    Write-Host ''
    Write-Host 'ISOLATED DEPENDENCY STAGING PASSED'
    Write-Host 'No packages were installed into the live calendar.'
    Write-Host 'No service, database, or test Git checkout was modified.'
} finally {
    if (Test-Path -LiteralPath $folder) {
        Remove-Item -LiteralPath $folder -Force -Recurse -ErrorAction Stop
    }
}
