# Durable WRITE-AHEAD release marker for a future explicitly authorized npm cutover.
# Dot-sourcing this module only defines helpers; it never deploys or writes.
# A marker that exists at the designated live location blocks automatic Git
# deployment and blocks the real production Node process at startup.
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'dependency-swap.ps1')

function Assert-FamilyCalendarJournalRecord {
    param([object]$Record)
    if ($null -eq $Record -or $Record.Schema -ne 1 -or
        $Record.TransactionId -notmatch '^[a-f0-9]{32}$' -or
        $Record.PreviousCommit -notmatch '^[a-f0-9]{40}$' -or
        $Record.CandidateCommit -notmatch '^[a-f0-9]{40}$' -or
        $Record.PreviousCommit -eq $Record.CandidateCommit -or
        $Record.Phase -notin @('Prepared','ServiceStopping','SwappingDependencies',
          'CandidateActivating','UpdatingGit','UpdatingFrontend','StartingCandidate',
          'HealthVerified','RollbackRequired','RestoringPrevious','RollbackVerified') -or
        [string]::IsNullOrWhiteSpace($Record.CreatedUtc)) {
        throw 'Invalid dependency release journal metadata; manual investigation required.'
    }
    Assert-IndependentDependencyPaths @([string]$Record.Active, [string]$Record.Staged, [string]$Record.Previous)
}

function Get-FamilyCalendarDependencyReleaseJournal {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw 'No dependency release journal file exists at the specified path.'
    }
    try {
        $record = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
        Assert-FamilyCalendarJournalRecord $record
        return $record
    } catch {
        throw "Dependency release journal cannot be trusted: $($_.Exception.Message)"
    }
}

function Save-FamilyCalendarAtomicJournal {
    param([string]$Path, [object]$Record, [bool]$IsNew)
    Assert-FamilyCalendarJournalRecord $Record
    $parent = Split-Path -Path $Path -Parent
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
        throw 'Journal directory must already exist. Refusing to create unexpected locations.'
    }
    $temp = Join-Path $parent ('.release-journal-' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
        $json = $Record | ConvertTo-Json -Depth 5
        $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($json)
        $stream = [System.IO.File]::Open($temp, [System.IO.FileMode]::CreateNew,
            [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        try {
            $stream.Write($bytes, 0, $bytes.Length)
            $stream.Flush($true)
        } finally {
            $stream.Dispose()
        }
        if ($IsNew) {
            if (Test-Path -LiteralPath $Path) { throw 'Existing journal collision; refusing overwrite.' }
            [System.IO.File]::Move($temp, $Path)
        } else {
            if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
                throw 'Previously saved journal vanished; refusing an unsafe state update.'
            }
            # Windows atomic replace: never remove the old journal before
            # recording the next state. A power loss keeps old OR new marker.
            [System.IO.File]::Replace($temp, $Path, $null)
        }
    } finally {
        if (Test-Path -LiteralPath $temp) {
            Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
        }
    }
}

function New-FamilyCalendarDependencyReleaseJournal {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$PreviousCommit,
        [Parameter(Mandatory)][string]$CandidateCommit,
        [Parameter(Mandatory)][string]$Active,
        [Parameter(Mandatory)][string]$Staged,
        [Parameter(Mandatory)][string]$Previous
    )
    if (Test-Path -LiteralPath $Path) { throw 'Unfinished dependency journal exists; refusing another release.' }
    if (-not (Test-Path -LiteralPath $Active -PathType Container) -or
        -not (Test-Path -LiteralPath $Staged -PathType Container) -or
        (Test-Path -LiteralPath $Previous)) {
        throw 'Package trees are not safely prepared for a new journal.'
    }
    $record = [pscustomobject]@{
        Schema = 1
        TransactionId = [guid]::NewGuid().ToString('N')
        PreviousCommit = $PreviousCommit
        CandidateCommit = $CandidateCommit
        CreatedUtc = (Get-Date).ToUniversalTime().ToString('o')
        Phase = 'Prepared'
        Active = [IO.Path]::GetFullPath($Active)
        Staged = [IO.Path]::GetFullPath($Staged)
        Previous = [IO.Path]::GetFullPath($Previous)
    }
    Save-FamilyCalendarAtomicJournal -Path $Path -Record $record -IsNew $true
    Write-Host '[PASS] Durable dependency transaction marker saved before any package move.'
    return (Get-FamilyCalendarDependencyReleaseJournal -Path $Path)
}

function Set-FamilyCalendarDependencyReleasePhase {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$TransactionId,
        [Parameter(Mandatory)][string]$Phase
    )
    $record = Get-FamilyCalendarDependencyReleaseJournal -Path $Path
    if ($record.TransactionId -ne $TransactionId) {
        throw 'Journal transaction identity changed; no write performed.'
    }
    $allowed = @{
        Prepared = @('ServiceStopping', 'RollbackRequired')
        ServiceStopping = @('SwappingDependencies', 'RollbackRequired')
        SwappingDependencies = @('CandidateActivating', 'RollbackRequired')
        CandidateActivating = @('UpdatingGit', 'RollbackRequired')
        UpdatingGit = @('UpdatingFrontend', 'RollbackRequired')
        UpdatingFrontend = @('StartingCandidate', 'RollbackRequired')
        StartingCandidate = @('HealthVerified', 'RollbackRequired')
        HealthVerified = @()
        RollbackRequired = @('RestoringPrevious')
        RestoringPrevious = @('RollbackVerified')
        RollbackVerified = @()
    }
    if ($Phase -notin $allowed[$record.Phase]) {
        throw "Invalid journal transition $($record.Phase) -> $Phase; manual investigation required."
    }
    $record.Phase = $Phase
    Save-FamilyCalendarAtomicJournal -Path $Path -Record $record -IsNew $false
    return (Get-FamilyCalendarDependencyReleaseJournal -Path $Path)
}

# Deliberately no Delete/Clear-Journal function. Neither Node nor automated
# deploy may clear the marker. Manual clearance requires separate verification.
