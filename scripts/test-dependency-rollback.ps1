# Exercise REAL directory switch/rollback helpers with synthetic packages only.
# No live calendar, npm installs, DB, service restarts, or Git working-tree changes.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'dependency-swap.ps1')

$root = Join-Path ([IO.Path]::GetTempPath()) ('FamilyCalendarPackageRollback-' + [guid]::NewGuid().ToString('N'))
if (Test-Path -LiteralPath $root) { throw 'Unexpected synthetic test directory collision.' }
New-Item -ItemType Directory -Path $root -ErrorAction Stop | Out-Null

function Assert-Fixture([bool]$ok, [string]$why) {
    if (-not $ok) { throw "Dependency rollback fixture failed: $why" }
}
function Create-Package([string]$folder, [string]$identity) {
    New-Item -ItemType Directory -Path $folder -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $folder 'fixture.txt') -Value $identity -NoNewline -Encoding UTF8
}
function Has-Identity([string]$folder, [string]$identity) {
    $marker = Join-Path $folder 'fixture.txt'
    return ((Test-Path -LiteralPath $marker -PathType Leaf) -and
        ((Get-Content -LiteralPath $marker -Raw) -eq $identity))
}
function Expect-Rejection([scriptblock]$action, [string]$label) {
    $rejected = $false
    try { & $action } catch { $rejected = $true }
    Assert-Fixture $rejected "Unsafe operation was accepted: $label"
    Write-Host "[PASS] Refused $label"
}

try {
    Write-Host 'Testing dependency directory switching using synthetic folders...'
    $normal = Join-Path $root 'normal'
    $active = Join-Path $normal 'active'
    $stage = Join-Path $normal 'stage'
    $backup = Join-Path $normal 'backup'
    $rejected = Join-Path $normal 'rejected'
    New-Item -ItemType Directory -Path $normal | Out-Null
    Create-Package $active 'original-package-version'
    Create-Package $stage 'candidate-package-version'
    Assert-Fixture ((Get-FamilyCalendarDependencySwapState -Active $active -Staged $stage -Previous $backup) -eq 'PreparedNotSwitched') 'Expected a ready-to-switch transaction'
    Switch-FamilyCalendarDependencies -Active $active -Staged $stage -Previous $backup
    Assert-Fixture ((Get-FamilyCalendarDependencySwapState -Active $active -Staged $stage -Previous $backup) -eq 'CandidateActivatedOldPreserved') 'Expected a candidate-active transaction'
    Assert-Fixture (Has-Identity $active 'candidate-package-version') 'Candidate was not activated'
    Assert-Fixture (Has-Identity $backup 'original-package-version') 'Original version was not preserved'
    Assert-Fixture (-not (Test-Path $stage)) 'Staging folder should have moved into active'
    Write-Host '[PASS] Successful switch retains a complete rollback package directory'

    Restore-FamilyCalendarDependencies -Active $active -Previous $backup -Rejected $rejected
    Assert-Fixture (Has-Identity $active 'original-package-version') 'Rollback failed to restore original version'
    Assert-Fixture (Has-Identity $rejected 'candidate-package-version') 'Rejected candidate lost'
    Write-Host '[PASS] Failed health-check scenario restores the previous package version'

    $interrupted = Join-Path $root 'interrupted'
    $active2 = Join-Path $interrupted 'active'
    $stage2 = Join-Path $interrupted 'stage'
    $backup2 = Join-Path $interrupted 'backup'
    New-Item -ItemType Directory -Path $interrupted | Out-Null
    Create-Package $active2 'safe-before-interruption'
    Create-Package $stage2 'candidate-before-interruption'
    Expect-Rejection {
        Switch-FamilyCalendarDependencies -Active $active2 -Staged $stage2 -Previous $backup2 -InjectFailureAfterPreviousMove
    } 'interrupted switch after preserving old packages'
    Assert-Fixture (Has-Identity $active2 'safe-before-interruption') 'Interrupted switch lost original active packages'
    Assert-Fixture (Has-Identity $stage2 'candidate-before-interruption') 'Interrupted switch changed staged copy'
    Assert-Fixture (-not (Test-Path $backup2)) 'Backup should have moved back into active after interruption'
    Write-Host '[PASS] Interrupted directory switch immediately restores the original version'

    # Simulate power loss between the TWO separate directory move operations.
    # Unlike an exception thrown by a running PowerShell process, a power
    # outage skips the catch block that normally restores the previous tree.
    $crash = Join-Path $root 'crash-between-moves'
    New-Item -ItemType Directory -Path $crash | Out-Null
    $crashActive = Join-Path $crash 'active'
    $crashStaged = Join-Path $crash 'stage'
    $crashPrevious = Join-Path $crash 'previous'
    Create-Package $crashActive 'working-version-before-power-failure'
    Create-Package $crashStaged 'candidate-not-yet-activated'
    Move-Item -LiteralPath $crashActive -Destination $crashPrevious -ErrorAction Stop
    Assert-Fixture ((Get-FamilyCalendarDependencySwapState -Active $crashActive -Staged $crashStaged -Previous $crashPrevious) -eq 'InterruptedAfterPreservingOld') 'Power loss after preserving old packages was not detected'
    Restore-FamilyCalendarInterruptedPackageMove -Active $crashActive -Staged $crashStaged -Previous $crashPrevious
    Assert-Fixture (Has-Identity $crashActive 'working-version-before-power-failure') 'Power-loss recovery did not restore old packages'
    Assert-Fixture (Has-Identity $crashStaged 'candidate-not-yet-activated') 'Power-loss recovery lost the staged candidate'
    Expect-Rejection {
        Restore-FamilyCalendarInterruptedPackageMove -Active $crashActive -Staged $crashStaged -Previous $crashPrevious
    } 'replaying already-completed interruption recovery'

    # Refuse ambiguous three-present folders rather than risking overwrite.
    $collision = Join-Path $root 'ambiguous-interruption'
    New-Item -ItemType Directory -Path $collision | Out-Null
    $collisionActive = Join-Path $collision 'active'
    $collisionStaged = Join-Path $collision 'stage'
    $collisionPrevious = Join-Path $collision 'previous'
    Create-Package $collisionActive 'active-original'
    Create-Package $collisionStaged 'staged-original'
    Create-Package $collisionPrevious 'backup-original'
    Expect-Rejection {
        Get-FamilyCalendarDependencySwapState -Active $collisionActive -Staged $collisionStaged -Previous $collisionPrevious
    } 'ambiguous existing active, staged and previous package paths'
    Expect-Rejection {
        Restore-FamilyCalendarInterruptedPackageMove -Active $collisionActive -Staged $collisionStaged -Previous $collisionPrevious
    } 'restoring an ambiguous package transaction'
    Assert-Fixture ((Has-Identity $collisionActive 'active-original') -and
        (Has-Identity $collisionStaged 'staged-original') -and
        (Has-Identity $collisionPrevious 'backup-original')) 'Ambiguous transaction moved or overwrote packages'

    $missing = Join-Path $root 'incomplete-interruption'
    New-Item -ItemType Directory -Path $missing | Out-Null
    Expect-Rejection {
        Restore-FamilyCalendarInterruptedPackageMove -Active (Join-Path $missing 'absent-active') -Staged (Join-Path $missing 'absent-stage') -Previous (Join-Path $missing 'absent-previous')
    } 'recovering without previous and staged package backups'
    Write-Host '[PASS] Abrupt power-loss gap can be identified and manually recovered without candidate activation.'

    $blocked = Join-Path $root 'blocked'
    $active3 = Join-Path $blocked 'active'
    $stage3 = Join-Path $blocked 'stage'
    $backup3 = Join-Path $blocked 'backup'
    New-Item -ItemType Directory -Path $blocked | Out-Null
    Create-Package $active3 'safe-blocked'
    Create-Package $stage3 'new-blocked'
    Create-Package $backup3 'preexisting-do-not-overwrite'
    Expect-Rejection {
        Switch-FamilyCalendarDependencies -Active $active3 -Staged $stage3 -Previous $backup3
    } 'overwriting an existing recovery copy'
    Assert-Fixture (Has-Identity $active3 'safe-blocked') 'Collision modified original active packages'
    Assert-Fixture (Has-Identity $backup3 'preexisting-do-not-overwrite') 'Collision overwrote recovery copy'
    Write-Host '[PASS] Existing recovery copies cannot be overwritten'

    Expect-Rejection {
        Switch-FamilyCalendarDependencies -Active $active3 -Staged (Join-Path $active3 'nested') -Previous (Join-Path $blocked 'unused-backup')
    } 'overlapping dependency directory paths'
    Expect-Rejection {
        Switch-FamilyCalendarDependencies -Active $active3 -Staged (Join-Path $blocked 'missing-stage') -Previous (Join-Path $blocked 'unused-backup')
    } 'a missing staged package directory'
    Assert-Fixture (Has-Identity $active3 'safe-blocked') 'Invalid-path tests modified original packages'

    Write-Host ''
    Write-Host 'INTERRUPTED PACKAGE SWAP SAFETY FIXTURES PASSED'
    Write-Host 'DEPENDENCY SWITCH AND ROLLBACK FIXTURES PASSED'
    Write-Host 'Only synthetic package folders under the Windows temporary directory were used.'
    Write-Host 'No live application, data, or service was modified.'
} finally {
    if (Test-Path -LiteralPath $root) {
        Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction Stop
    }
}
