# Directory-only package switch/restore primitives. Import by dot-sourcing.
# Caller MUST stop the Node service and stage/validate candidate dependencies first.
# Loading this file performs no actions. Do not run these functions on live until
# the guarded release integrates and tests process-stop, health and rollback checks.
Set-StrictMode -Version Latest

function Assert-IndependentDependencyPaths {
    param([string[]]$Paths)
    if ($Paths.Count -ne 3) { throw 'Expected exactly three dependency directories.' }
    $all = @($Paths | ForEach-Object { [IO.Path]::GetFullPath($_).TrimEnd('\') })
    for ($i=0; $i -lt $all.Count; $i++) {
        for ($j=$i+1; $j -lt $all.Count; $j++) {
            if ([string]::Equals($all[$i], $all[$j], [StringComparison]::OrdinalIgnoreCase) -or
                $all[$i].StartsWith($all[$j] + '\', [StringComparison]::OrdinalIgnoreCase) -or
                $all[$j].StartsWith($all[$i] + '\', [StringComparison]::OrdinalIgnoreCase)) {
                throw 'Dependency directories must be independent, not nested or overlapping.'
            }
        }
    }
}

function Switch-FamilyCalendarDependencies {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Active,
        [Parameter(Mandatory)][string]$Staged,
        [Parameter(Mandatory)][string]$Previous,
        [switch]$InjectFailureAfterPreviousMove
    )
    Assert-IndependentDependencyPaths @($Active, $Staged, $Previous)
    if (-not (Test-Path -LiteralPath $Active -PathType Container)) {
        throw 'Existing dependency directory is missing. No switch attempted.'
    }
    if (-not (Test-Path -LiteralPath $Staged -PathType Container)) {
        throw 'Staged dependency directory is missing. No switch attempted.'
    }
    if (Test-Path -LiteralPath $Previous) {
        throw 'Previous dependency backup already exists; refusing overwrite.'
    }
    $previousParent = Split-Path -Path $Previous -Parent
    if (-not (Test-Path -LiteralPath $previousParent -PathType Container)) {
        throw 'Previous dependency backup parent missing; refusing to create paths.'
    }

    $oldMoved = $false
    try {
        Move-Item -LiteralPath $Active -Destination $Previous -ErrorAction Stop
        $oldMoved = $true
        if ($InjectFailureAfterPreviousMove) {
            throw 'Simulated interruption immediately after old dependencies were preserved.'
        }
        Move-Item -LiteralPath $Staged -Destination $Active -ErrorAction Stop
        Write-Host '[PASS] Candidate dependencies activated, previous packages preserved.'
    } catch {
        $reason = $_.Exception.Message
        if ($oldMoved) {
            if (Test-Path -LiteralPath $Active) {
                throw "Dependency switch failed: $reason. Both candidate and previous locations need manual inspection."
            }
            try {
                Move-Item -LiteralPath $Previous -Destination $Active -ErrorAction Stop
            } catch {
                throw "Dependency switch failed: $reason; could not restore original directory: $($_.Exception.Message)"
            }
            Write-Host '[PASS] Original dependencies restored after interrupted directory switch.'
        }
        throw "Dependency switch refused or rolled back: $reason"
    }
}

function Restore-FamilyCalendarDependencies {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Active,
        [Parameter(Mandatory)][string]$Previous,
        [Parameter(Mandatory)][string]$Rejected
    )
    Assert-IndependentDependencyPaths @($Active, $Previous, $Rejected)
    if (-not (Test-Path -LiteralPath $Previous -PathType Container)) {
        throw 'Previous package directory missing; rollback refused.'
    }
    if (-not (Test-Path -LiteralPath $Active -PathType Container)) {
        throw 'Candidate package directory missing; rollback refused.'
    }
    if (Test-Path -LiteralPath $Rejected) {
        throw 'Rejected package location already exists; refusing to overwrite.'
    }
    $rejectedParent = Split-Path -Path $Rejected -Parent
    if (-not (Test-Path -LiteralPath $rejectedParent -PathType Container)) {
        throw 'Rejected package backup parent missing.'
    }

    Move-Item -LiteralPath $Active -Destination $Rejected -ErrorAction Stop
    try {
        Move-Item -LiteralPath $Previous -Destination $Active -ErrorAction Stop
    } catch {
        # Previous and rejected copies remain available for controlled manual recovery.
        throw "Previous dependency restoration failed. Do not retry unattended: $($_.Exception.Message)"
    }
    Write-Host '[PASS] Previous dependencies restored; rejected candidate preserved.'
}


# Read-only classification of the three directory states surrounding the two
# rename operations in Switch-FamilyCalendarDependencies.
# Requires no journal and NEVER guesses if an unexpected extra/missing directory
# is found. This is deliberately NOT invoked by live automatic deployment.
function Get-FamilyCalendarDependencySwapState {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Active,
        [Parameter(Mandatory)][string]$Staged,
        [Parameter(Mandatory)][string]$Previous
    )
    Assert-IndependentDependencyPaths @($Active, $Staged, $Previous)

    foreach ($folder in @($Active, $Staged, $Previous)) {
        if ((Test-Path -LiteralPath $folder) -and
            -not (Test-Path -LiteralPath $folder -PathType Container)) {
            throw "Unexpected non-directory package path: $folder"
        }
    }

    $a = Test-Path -LiteralPath $Active -PathType Container
    $s = Test-Path -LiteralPath $Staged -PathType Container
    $p = Test-Path -LiteralPath $Previous -PathType Container

    if ($a -and $s -and -not $p) { return 'PreparedNotSwitched' }
    if (-not $a -and $s -and $p) { return 'InterruptedAfterPreservingOld' }
    if ($a -and -not $s -and $p) { return 'CandidateActivatedOldPreserved' }
    throw 'Ambiguous dependency swap state; manual investigation required.'
}

# Narrow manual-only recovery primitive for an abrupt process/OS interruption
# BETWEEN moving old node_modules to Previous and activating staged packages.
# Caller must independently prove the correct Node service is fully stopped,
# confirm the previous tree belongs to this transaction, and verify health after
# recovery. Never called by the automatic release task.
function Restore-FamilyCalendarInterruptedPackageMove {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Active,
        [Parameter(Mandatory)][string]$Staged,
        [Parameter(Mandatory)][string]$Previous
    )

    $state = Get-FamilyCalendarDependencySwapState -Active $Active -Staged $Staged -Previous $Previous
    if ($state -ne 'InterruptedAfterPreservingOld') {
        throw "Interrupted-package recovery refused: state is $state."
    }
    Move-Item -LiteralPath $Previous -Destination $Active -ErrorAction Stop
    if (-not (Test-Path -LiteralPath $Active -PathType Container) -or
        -not (Test-Path -LiteralPath $Staged -PathType Container) -or
        (Test-Path -LiteralPath $Previous)) {
        throw 'Interrupted-package recovery verification failed. Do not restart Node.'
    }
    Write-Host '[PASS] Previously preserved packages restored after interrupted first directory move.'
    Write-Host '[PASS] Unactivated candidate packages remain staged and untouched.'
    Write-Host 'INTERRUPTED PACKAGE DIRECTORY MOVE RECOVERY PASSED'
}
