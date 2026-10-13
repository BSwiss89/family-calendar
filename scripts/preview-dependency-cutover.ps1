# READ-ONLY prospective npm cutover gate; deliberately cannot apply a release.
# Existing release.ps1/deploy-backend.ps1 continue rejecting package/lockfile edits.
# No Git fetch, install, write, task control, package swap, or database migration.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$authorizedHome = 'C:\Users\bobby'
$live = Join-Path $authorizedHome 'Projects\family-calendar'
$test = Join-Path $authorizedHome 'Projects\family-calendar-test'
$backups = Join-Path $authorizedHome 'Projects\family-calendar-release-backups'
$remote = 'git@github.com:BSwiss89/family-calendar.git'

function Require-Preview([bool]$ok, [string]$message) {
    if (-not $ok) { throw "Dependency cutover preview refused: $message" }
    Write-Host "[PASS] $message"
}

Write-Host 'FAMILY CALENDAR - READ-ONLY PRODUCTION DEPENDENCY CUTOVER PREVIEW'
Write-Host 'This command NEVER authorizes or applies a package update.'

Require-Preview ([string]::Equals($env:USERPROFILE, $authorizedHome, [StringComparison]::OrdinalIgnoreCase)) 'Authorized laptop user profile'
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
Require-Preview ($id.Name -ne 'NT AUTHORITY\SYSTEM') 'Interactive session, not SYSTEM'

foreach ($folder in @($live, $test)) {
    Require-Preview (Test-Path -LiteralPath (Join-Path $folder '.git')) "Git checkout present: $folder"
    $origin = (& git -C $folder remote get-url origin).Trim()
    Require-Preview ($LASTEXITCODE -eq 0 -and $origin -eq $remote) 'Approved GitHub origin'
    $branch = (& git -C $folder branch --show-current).Trim()
    Require-Preview ($LASTEXITCODE -eq 0 -and $branch -eq 'main') 'Main branch checked out'
    $dirty = @(& git -C $folder status --porcelain)
    Require-Preview ($LASTEXITCODE -eq 0 -and $dirty.Count -eq 0) 'Clean Git checkout'
}

$from = (& git -C $live rev-parse HEAD).Trim()
Require-Preview ($LASTEXITCODE -eq 0 -and $from -match '^[a-f0-9]{40}$') 'Full live commit identified'
$to = (& git -C $test rev-parse HEAD).Trim()
Require-Preview ($LASTEXITCODE -eq 0 -and $to -match '^[a-f0-9]{40}$' -and $from -ne $to) 'Distinct candidate commit identified'

$node = (Get-Command node.exe -ErrorAction Stop).Source
$scope = Join-Path $test 'scripts\check-dependency-change-scope.mjs'
$verifier = Join-Path $test 'scripts\verify-commit-dependencies.mjs'
$runtime = Join-Path $test 'scripts\verify-staged-dependencies.mjs'
foreach ($script in @($scope, $verifier, $runtime)) {
    Require-Preview (Test-Path -LiteralPath $script -PathType Leaf) "Required verifier exists"
}
& $node $scope --check $live $test
if ($LASTEXITCODE -ne 0) { throw 'Cutover scope or migration policy rejected this release.' }

# The independent verifier checks the candidate's full SHA, current remote
# GitHub main, exact source hashes, prepared-not-applied metadata and imports.
& $node $verifier --commit $to
if ($LASTEXITCODE -ne 0) { throw 'Exact approved GitHub commit candidate failed verification.' }

Require-Preview (Test-Path -LiteralPath (Join-Path $live 'node_modules') -PathType Container) 'Current live npm tree exists'
& $node $runtime $live
if ($LASTEXITCODE -ne 0) { throw 'Current live npm dependencies did not pass the read-only smoke check.' }

$liveDb = Join-Path $live 'Server\data\calendar.db'
$testDb = Join-Path $test 'Server\data\calendar.db'
Require-Preview (Test-Path -LiteralPath $liveDb -PathType Leaf) 'Production SQLite database exists'
Require-Preview (Test-Path -LiteralPath $testDb -PathType Leaf) 'Separate test SQLite database exists'
Require-Preview (-not [string]::Equals(
    (Resolve-Path -LiteralPath $liveDb).Path,
    (Resolve-Path -LiteralPath $testDb).Path,
    [StringComparison]::OrdinalIgnoreCase
)) 'Test and production SQLite databases are different'

Require-Preview (Test-Path -LiteralPath (Join-Path $live 'dist\index.html') -PathType Leaf) 'Previous frontend exists'
Require-Preview (Test-Path -LiteralPath (Join-Path $test 'dist\index.html') -PathType Leaf) 'Built candidate frontend exists'
Require-Preview (Test-Path -LiteralPath $backups -PathType Container) 'Recovery backup parent exists'
$health = Invoke-RestMethod 'http://127.0.0.1:3001/api/health' -TimeoutSec 5 -ErrorAction Stop
Require-Preview ($health.status -eq 'ok') 'Existing live calendar API is healthy'

Write-Host ''
Write-Host 'READ-ONLY DEPENDENCY CUTOVER PREVIEW PASSED'
Write-Host "Previous commit: $from"
Write-Host "Approved candidate: $to"
Write-Host 'NO packages, databases, Git refs, scheduled tasks or live server were changed.'
Write-Host 'Automatic and manual package-changing releases are STILL BLOCKED.'
