# Trusted helper used only by the installed TEST updater (never from the updating checkout).
# Preserve the supervisor's fail-closed SHA-256 checks across an approved release.
Set-StrictMode -Version Latest

function Get-SecureTestSourcePins([string]$supervisorFile) {
    if (!(Test-Path -LiteralPath $supervisorFile)) { throw 'Secure TEST supervisor is missing.' }
    $source = [System.IO.File]::ReadAllText($supervisorFile)
    if (!$source.Contains('family-calendar-test-security-stage') -or
        !$source.Contains('Server source changed. Refusing unreviewed startup.') -or
        !$source.Contains('Authentication code changed. Refusing unreviewed startup.')) {
        throw 'Unrecognized supervisor code. Refusing to modify source-integrity protection.'
    }
    $indexPattern = '(?m)^[ \t]*\$indexHash[ \t]*=[ \t]*''([A-Fa-f0-9]{64})''[ \t]*\r?$'
    $authPattern = '(?m)^[ \t]*\$authHash[ \t]*=[ \t]*''([A-Fa-f0-9]{64})''[ \t]*\r?$'
    $index = [regex]::Matches($source,$indexPattern)
    $auth = [regex]::Matches($source,$authPattern)
    if ($index.Count -ne 1 -or $auth.Count -ne 1) {
        throw 'Exactly one Server/index.mjs and family-auth.mjs integrity pin is required.'
    }
    return [pscustomobject]@{
        Text=$source
        Index=$index[0].Groups[1].Value.ToUpperInvariant()
        Auth=$auth[0].Groups[1].Value.ToUpperInvariant()
        IndexLine=$index[0].Value
        AuthLine=$auth[0].Value
    }
}
function Assert-SecureTestSourcePins([string]$supervisorFile,[string]$testFolder) {
    $pins = Get-SecureTestSourcePins $supervisorFile
    $index = (Get-FileHash -LiteralPath (Join-Path $testFolder 'Server\index.mjs') -Algorithm SHA256).Hash
    $auth = (Get-FileHash -LiteralPath (Join-Path $testFolder 'Server\family-auth.mjs') -Algorithm SHA256).Hash
    if ($pins.Index -ne $index -or $pins.Auth -ne $auth) {
        throw 'Secure TEST supervisor pins do not match the installed backend files.'
    }
}
function Set-SecureTestSourcePins(
    [string]$supervisorFile,
    [string]$backupFile,
    [string]$indexHash,
    [string]$authHash
) {
    $current = Get-SecureTestSourcePins $supervisorFile
    if ((Get-FileHash -LiteralPath $supervisorFile -Algorithm SHA256).Hash -ne
        (Get-FileHash -LiteralPath $backupFile -Algorithm SHA256).Hash) {
        throw 'Supervisor changed after the verified backup.'
    }
    foreach ($h in @($indexHash,$authHash)) {
        if ($h -cnotmatch '^[A-F0-9]{64}$') { throw 'Invalid proposed backend integrity hash.' }
    }
    if ($current.Index -ceq $indexHash -and $current.Auth -ceq $authHash) {
        return $false
    }
    $next = $current.Text.Replace(
        $current.IndexLine,$current.IndexLine.Replace($current.Index,$indexHash)
    ).Replace(
        $current.AuthLine,$current.AuthLine.Replace($current.Auth,$authHash)
    )
    if ($next -ceq $current.Text) { throw 'Supervisor source pin substitution did not change the expected lines.' }
    $temp = $supervisorFile + '.update-' + [guid]::NewGuid().ToString('N') + '.tmp'
    try {
        $bytes = [System.IO.File]::ReadAllBytes($supervisorFile)
        if ($bytes.Length -lt 3) { throw 'Supervisor file is unexpectedly empty.' }
        $hasBom = $bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191
        [System.IO.File]::WriteAllText($temp,$next,[System.Text.UTF8Encoding]::new($hasBom))
        $tokens=$null
        $errors=$null
        [System.Management.Automation.Language.Parser]::ParseFile(
            $temp,[ref]$tokens,[ref]$errors
        ) | Out-Null
        if ($errors -and $errors.Count -gt 0) { throw 'Updated TEST supervisor contains a PowerShell syntax error.' }
        $replaceBackup = $supervisorFile + '.swap-' + [guid]::NewGuid().ToString('N') + '.bak'
        [System.IO.File]::Replace($temp,$supervisorFile,$replaceBackup)
        $installed = Get-SecureTestSourcePins $supervisorFile
        if ($installed.Index -cne $indexHash -or $installed.Auth -cne $authHash) {
            throw 'Verified source hashes were not installed correctly.'
        }
        return $true
    } finally {
        if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force }
    }
}
function Restore-SecureTestSupervisor([string]$supervisorFile,[string]$backupFile) {
    if (!(Test-Path -LiteralPath $backupFile)) { throw 'Supervisor rollback backup is missing.' }
    $temp = $supervisorFile + '.rollback-' + [guid]::NewGuid().ToString('N') + '.tmp'
    try {
        Copy-Item -LiteralPath $backupFile -Destination $temp -ErrorAction Stop
        $replaceBackup = $supervisorFile + '.swap-' + [guid]::NewGuid().ToString('N') + '.bak'
        [System.IO.File]::Replace($temp,$supervisorFile,$replaceBackup)
        if ((Get-FileHash -LiteralPath $supervisorFile -Algorithm SHA256).Hash -ne
            (Get-FileHash -LiteralPath $backupFile -Algorithm SHA256).Hash) {
            throw 'Restored supervisor differs from the verified backup.'
        }
    } finally {
        if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force }
    }
}
