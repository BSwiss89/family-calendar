# Purely synthetic crash journal tests. Never touches live Calendar/SQLite/tasks.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'dependency-release-journal.ps1')

$root = Join-Path ([IO.Path]::GetTempPath()) ('FamilyCalendarJournal-' + [guid]::NewGuid().ToString('N'))
$oldCommit = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
$newCommit = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

function Assert-JournalTest([bool]$ok, [string]$message) {
    if (-not $ok) { throw "Dependency journal fixture FAILED: $message" }
}
function Expect-JournalRefusal([scriptblock]$action, [string]$message) {
    $refused = $false
    try { & $action | Out-Null } catch { $refused = $true }
    Assert-JournalTest $refused "Did not refuse: $message"
    Write-Host "[PASS] Rejected $message"
}
function Make-Tree([string]$parent) {
    New-Item -ItemType Directory -Path $parent -ErrorAction Stop | Out-Null
    $active = Join-Path $parent 'active'
    $staged = Join-Path $parent 'staged'
    $previous = Join-Path $parent 'previous'
    New-Item -ItemType Directory -Path $active -ErrorAction Stop | Out-Null
    New-Item -ItemType Directory -Path $staged -ErrorAction Stop | Out-Null
    [IO.File]::WriteAllText((Join-Path $active 'marker.txt'), 'old-working-packages')
    [IO.File]::WriteAllText((Join-Path $staged 'marker.txt'), 'new-staged-packages')
    return @{Active=$active; Staged=$staged; Previous=$previous}
}

if (Test-Path -LiteralPath $root) { throw 'Temporary journal test directory collision.' }
New-Item -ItemType Directory -Path $root -ErrorAction Stop | Out-Null
try {
    $first = Make-Tree (Join-Path $root 'interrupted-after-first-move')
    $journal1 = Join-Path (Split-Path $first.Active -Parent) 'DEPENDENCY-RELEASE-IN-PROGRESS.json'
    $args1 = @{
        Path = $journal1
        PreviousCommit = $oldCommit
        CandidateCommit = $newCommit
        Active = $first.Active
        Staged = $first.Staged
        Previous = $first.Previous
    }
    $record = New-FamilyCalendarDependencyReleaseJournal @args1
    Assert-JournalTest ($record.Phase -eq 'Prepared' -and $record.PreviousCommit -eq $oldCommit -and $record.CandidateCommit -eq $newCommit) 'Initial durable record incomplete'
    Expect-JournalRefusal { New-FamilyCalendarDependencyReleaseJournal @args1 } 'overwriting an unfinished journal'
    Expect-JournalRefusal {
        Set-FamilyCalendarDependencyReleasePhase -Path $journal1 -TransactionId ('0' * 32) -Phase ServiceStopping
    } 'advancing wrong transaction identity'
    Expect-JournalRefusal {
        Set-FamilyCalendarDependencyReleasePhase -Path $journal1 -TransactionId $record.TransactionId -Phase HealthVerified
    } 'skipping protected release phases'
    $record = Set-FamilyCalendarDependencyReleasePhase -Path $journal1 -TransactionId $record.TransactionId -Phase ServiceStopping
    $record = Set-FamilyCalendarDependencyReleasePhase -Path $journal1 -TransactionId $record.TransactionId -Phase SwappingDependencies

    # Abrupt power loss after old tree moved aside (PowerShell catch never runs).
    Move-Item -LiteralPath $first.Active -Destination $first.Previous -ErrorAction Stop
    $layout1 = Get-FamilyCalendarDependencySwapState -Active $first.Active -Staged $first.Staged -Previous $first.Previous
    Assert-JournalTest ($layout1 -eq 'InterruptedAfterPreservingOld') 'Power-loss package state was not detected'
    $persisted = Get-FamilyCalendarDependencyReleaseJournal -Path $journal1
    Assert-JournalTest ($persisted.Phase -eq 'SwappingDependencies' -and $persisted.TransactionId -eq $record.TransactionId) 'Journal did not survive simulated crash'
    Write-Host '[PASS] Durable write-ahead record survived simulated abrupt first-move interruption.'
    Restore-FamilyCalendarInterruptedPackageMove -Active $first.Active -Staged $first.Staged -Previous $first.Previous
    $hasOriginal = (Get-Content -LiteralPath (Join-Path $first.Active 'marker.txt') -Raw) -eq 'old-working-packages'
    $hasCandidate = (Get-Content -LiteralPath (Join-Path $first.Staged 'marker.txt') -Raw) -eq 'new-staged-packages'
    Assert-JournalTest ($hasOriginal -and $hasCandidate) 'Recovered packages do not match preserved identity'
    Assert-JournalTest (Test-Path -LiteralPath $journal1 -PathType Leaf) 'Recovery improperly cleared crash hold'
    $record = Set-FamilyCalendarDependencyReleasePhase -Path $journal1 -TransactionId $record.TransactionId -Phase RollbackRequired
    $record = Set-FamilyCalendarDependencyReleasePhase -Path $journal1 -TransactionId $record.TransactionId -Phase RestoringPrevious
    $record = Set-FamilyCalendarDependencyReleasePhase -Path $journal1 -TransactionId $record.TransactionId -Phase RollbackVerified
    Assert-JournalTest ((Get-FamilyCalendarDependencyReleaseJournal -Path $journal1).Phase -eq 'RollbackVerified') 'Rollback state was not durable'
    Assert-JournalTest (Test-Path -LiteralPath $journal1 -PathType Leaf) 'Verified rollback journal cleared itself'
    Write-Host '[PASS] Verified rollback still requires manual journal clearance.'

    # Separate power loss after the candidate packages are already active.
    $second = Make-Tree (Join-Path $root 'candidate-activated')
    $journal2 = Join-Path (Split-Path $second.Active -Parent) 'DEPENDENCY-RELEASE-IN-PROGRESS.json'
    $args2 = @{
        Path = $journal2
        PreviousCommit = $oldCommit
        CandidateCommit = $newCommit
        Active = $second.Active
        Staged = $second.Staged
        Previous = $second.Previous
    }
    $record2 = New-FamilyCalendarDependencyReleaseJournal @args2
    foreach ($phase in @('ServiceStopping','SwappingDependencies','CandidateActivating')) {
        $record2 = Set-FamilyCalendarDependencyReleasePhase -Path $journal2 -TransactionId $record2.TransactionId -Phase $phase
    }
    Switch-FamilyCalendarDependencies -Active $second.Active -Staged $second.Staged -Previous $second.Previous
    $layout2 = Get-FamilyCalendarDependencySwapState -Active $second.Active -Staged $second.Staged -Previous $second.Previous
    Assert-JournalTest ($layout2 -eq 'CandidateActivatedOldPreserved') 'Candidate-active state was not recognized'
    Expect-JournalRefusal {
        Restore-FamilyCalendarInterruptedPackageMove -Active $second.Active -Staged $second.Staged -Previous $second.Previous
    } 'using first-move recovery after candidate activation'
    $preserved = (Get-Content -LiteralPath (Join-Path $second.Previous 'marker.txt') -Raw) -eq 'old-working-packages'
    Assert-JournalTest ($preserved -and (Test-Path -LiteralPath $journal2 -PathType Leaf)) 'Candidate stage lost previous packages or crash hold'
    Write-Host '[PASS] Candidate-active interruption retained old packages and journal for manual decision.'

    [IO.File]::WriteAllText($journal2, '{"broken":')
    Expect-JournalRefusal { Get-FamilyCalendarDependencyReleaseJournal -Path $journal2 } 'corrupt or truncated journal'
    Assert-JournalTest (Test-Path -LiteralPath $journal2 -PathType Leaf) 'Corrupt journal was mistakenly deleted'
    Write-Host ''
    Write-Host 'DURABLE DEPENDENCY RELEASE JOURNAL CRASH FIXTURES PASSED'
    Write-Host 'Only synthetic package paths in a unique disposable Windows Temp folder changed.'
} finally {
    if (Test-Path -LiteralPath $root) {
        Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction Stop
    }
}
