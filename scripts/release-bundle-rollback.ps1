# Reusable, fail-closed release bundle rollback primitive.
# Import by dot-sourcing. Import itself never touches a server or package directory.
# Caller MUST first stop and positively identify its own Node service, and MUST NOT
# restart that service unless this function returns successfully and health is tested.
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'dependency-swap.ps1')

function Restore-FamilyCalendarReleaseBundle {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Repository,
        [Parameter(Mandatory)][string]$PreviousCommit,
        [Parameter(Mandatory)][string]$CandidateCommit,
        [Parameter(Mandatory)][string]$ActiveFrontend,
        [Parameter(Mandatory)][string]$PreviousFrontend,
        [Parameter(Mandatory)][string]$RejectedFrontend,
        [Parameter(Mandatory)][string]$ActiveDependencies,
        [Parameter(Mandatory)][string]$PreviousDependencies,
        [Parameter(Mandatory)][string]$RejectedDependencies
    )

    # Check the entire recovery bundle BEFORE changing anything. A missing backup,
    # collision, unexpected Git state, or overlapping tree must stop restoration.
    if ($PreviousCommit -notmatch '^[a-f0-9]{40}$' -or
        $CandidateCommit -notmatch '^[a-f0-9]{40}$' -or
        $PreviousCommit -eq $CandidateCommit) {
        throw 'Rollback requires two distinct full Git commit SHAs.'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $Repository '.git'))) {
        throw 'Rollback Git repository is missing.'
    }
    Assert-IndependentDependencyPaths @($ActiveDependencies, $PreviousDependencies, $RejectedDependencies)
    Assert-IndependentDependencyPaths @($ActiveFrontend, $PreviousFrontend, $RejectedFrontend)
    foreach ($path in @($ActiveDependencies, $PreviousDependencies, $ActiveFrontend, $PreviousFrontend)) {
        if (-not (Test-Path -LiteralPath $path -PathType Container)) {
            throw "Rollback source missing: $path"
        }
    }
    foreach ($path in @($RejectedDependencies, $RejectedFrontend)) {
        if (Test-Path -LiteralPath $path) {
            throw "Rollback rejection destination already exists: $path"
        }
        if (-not (Test-Path -LiteralPath (Split-Path -Path $path -Parent) -PathType Container)) {
            throw "Rollback rejection parent is missing: $path"
        }
    }
    $branch = (& git -C $Repository branch --show-current).Trim()
    if ($LASTEXITCODE -ne 0 -or $branch -ne 'main') {
        throw 'Rollback requires the expected main branch.'
    }
    $head = (& git -C $Repository rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $head -ne $CandidateCommit) {
        throw 'Rollback refused: deployed Git HEAD differs from the candidate.'
    }
    $gitStatus = @(& git -C $Repository status --porcelain)
    if ($LASTEXITCODE -ne 0 -or $gitStatus.Count -ne 0) {
        throw 'Rollback refused: Git working tree is not clean.'
    }
    $oldType = (& git -C $Repository cat-file -t $PreviousCommit).Trim()
    if ($LASTEXITCODE -ne 0 -or $oldType -ne 'commit') {
        throw 'Rollback target Git commit is unavailable.'
    }
    & git -C $Repository merge-base --is-ancestor $PreviousCommit $CandidateCommit
    if ($LASTEXITCODE -ne 0) {
        throw 'Rollback target is not an ancestor of the candidate.'
    }

    # This is intentionally not an unattended retryable transaction. If any move
    # fails, report exactly where it failed and leave preserved assets for review.
    # The caller must keep the service stopped if recovery remains incomplete.
    Restore-FamilyCalendarDependencies -Active $ActiveDependencies -Previous $PreviousDependencies -Rejected $RejectedDependencies

    Move-Item -LiteralPath $ActiveFrontend -Destination $RejectedFrontend -ErrorAction Stop
    Move-Item -LiteralPath $PreviousFrontend -Destination $ActiveFrontend -ErrorAction Stop

    & git -C $Repository reset --hard $PreviousCommit | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Rollback Git reset failed. Do not start Node.' }

    $restored = (& git -C $Repository rev-parse HEAD).Trim()
    $finalStatus = @(& git -C $Repository status --porcelain)
    if ($LASTEXITCODE -ne 0 -or $restored -ne $PreviousCommit -or $finalStatus.Count -ne 0) {
        throw 'Rollback Git verification failed. Do not start Node.'
    }
    if (-not (Test-Path -LiteralPath $ActiveDependencies -PathType Container) -or
        -not (Test-Path -LiteralPath $ActiveFrontend -PathType Container) -or
        -not (Test-Path -LiteralPath $RejectedDependencies -PathType Container) -or
        -not (Test-Path -LiteralPath $RejectedFrontend -PathType Container)) {
        throw 'Rollback file verification failed. Do not start Node.'
    }

    Write-Host '[PASS] Previous backend Git commit, frontend, and npm dependencies restored.'
    Write-Host '[PASS] Rejected frontend and npm package trees retained for investigation.'
    Write-Host 'RELEASE BUNDLE FILE RESTORATION PASSED'
}


# Code/frontend-only rollback for backend updates with NO dependency changes.
# This is the only rollback mode used by the existing guarded backend deployer:
# package.json and package-lock.json changes remain blocked in ReleasePlan.
# Caller must positively stop Node before invoking this function. This helper
# never touches node_modules, SQLite, services, or restart/retry policy.
function Restore-FamilyCalendarCodeAndFrontend {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Repository,
        [Parameter(Mandatory)][string]$PreviousCommit,
        [Parameter(Mandatory)][string]$CandidateCommit,
        [Parameter(Mandatory)][string]$ActiveFrontend,
        [Parameter(Mandatory)][string]$PreviousFrontend,
        [Parameter(Mandatory)][string]$RejectedFrontend
    )

    if ($PreviousCommit -notmatch '^[a-f0-9]{40}$' -or
        $CandidateCommit -notmatch '^[a-f0-9]{40}$' -or
        $PreviousCommit -eq $CandidateCommit) {
        throw 'Code/frontend rollback requires distinct full Git commit SHAs.'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $Repository '.git'))) {
        throw 'Rollback repository is missing.'
    }
    Assert-IndependentDependencyPaths @($ActiveFrontend, $PreviousFrontend, $RejectedFrontend)
    foreach ($path in @($ActiveFrontend, $PreviousFrontend)) {
        if (-not (Test-Path -LiteralPath $path -PathType Container)) {
            throw "Rollback frontend source missing: $path"
        }
    }
    if (Test-Path -LiteralPath $RejectedFrontend) {
        throw 'Rejected frontend destination already exists; refusing overwrite.'
    }
    if (-not (Test-Path -LiteralPath (Split-Path -Path $RejectedFrontend -Parent) -PathType Container)) {
        throw 'Rejected frontend parent directory is missing.'
    }

    $branch = (& git -C $Repository branch --show-current).Trim()
    if ($LASTEXITCODE -ne 0 -or $branch -ne 'main') {
        throw 'Code/frontend rollback requires the main branch.'
    }
    $head = (& git -C $Repository rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $head -ne $CandidateCommit) {
        throw 'Code/frontend rollback refused: deployed Git HEAD changed.'
    }
    $dirty = @(& git -C $Repository status --porcelain)
    if ($LASTEXITCODE -ne 0 -or $dirty.Count -ne 0) {
        throw 'Code/frontend rollback refused: Git checkout is dirty.'
    }
    $previousType = (& git -C $Repository cat-file -t $PreviousCommit).Trim()
    if ($LASTEXITCODE -ne 0 -or $previousType -ne 'commit') {
        throw 'Previous Git backend commit is unavailable.'
    }
    & git -C $Repository merge-base --is-ancestor $PreviousCommit $CandidateCommit
    if ($LASTEXITCODE -ne 0) {
        throw 'Previous backend commit is not an ancestor of candidate.'
    }

    # Do not retry/replay automatically if one move fails. Previous and rejected
    # frontend directories remain available for manual inspection.
    Move-Item -LiteralPath $ActiveFrontend -Destination $RejectedFrontend -ErrorAction Stop
    Move-Item -LiteralPath $PreviousFrontend -Destination $ActiveFrontend -ErrorAction Stop
    & git -C $Repository reset --hard $PreviousCommit | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw 'Previous Git backend commit could not be restored. Do not restart server.'
    }

    $restored = (& git -C $Repository rev-parse HEAD).Trim()
    $finalStatus = @(& git -C $Repository status --porcelain)
    if ($LASTEXITCODE -ne 0 -or $restored -ne $PreviousCommit -or $finalStatus.Count -ne 0 -or
        -not (Test-Path -LiteralPath $ActiveFrontend -PathType Container) -or
        -not (Test-Path -LiteralPath $RejectedFrontend -PathType Container)) {
        throw 'Code/frontend rollback verification failed. Do not restart server.'
    }

    Write-Host '[PASS] Previous backend commit and frontend restored without touching npm or SQLite.'
    Write-Host 'CODE AND FRONTEND FILE RESTORATION PASSED'
}
