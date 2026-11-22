# Read-only parser for the existing secure TEST updater transcript.
# Scan ALL historical lines; once-a-minute checks can push valid deployment
# receipts far beyond a short tail window. Never echo raw logs or credentials.
# This function has no task, Git, SQLite, Funnel, or filesystem mutations.
function Read-SecureTestLastSuccessReceipt {
    [CmdletBinding()]
    param([Parameter(Mandatory=$true)][string]$LogFile)

    $lastCheckAt = 'UNKNOWN'
    $lastSuccessSha = 'UNKNOWN'
    $lastSuccessAt = 'UNKNOWN'
    $lastBackup = 'UNKNOWN'
    # System.IO.File.ReadLines is lazy, so very large transcripts are not
    # copied into memory merely to locate a historical success record.
    foreach ($line in [System.IO.File]::ReadLines($LogFile)) {
        if ($line -match 'TEST AUTO DEPLOY CHECK (\d{4}-\d\d-\d\dT\S+)') {
            $lastCheckAt = $Matches[1]
        }
        if ($line -match 'TEST AUTO DEPLOY SUCCESS ([a-fA-F0-9]{40})\. Backup: (.+)$') {
            $lastSuccessSha = $Matches[1].ToLowerInvariant()
            $lastSuccessAt = $lastCheckAt
            $lastBackup = $Matches[2].Trim()
        }
    }
    return [pscustomobject]@{
        LastSuccessSha = $lastSuccessSha
        LastSuccessAt = $lastSuccessAt
        LastBackup = $lastBackup
    }
}
