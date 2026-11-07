# ISSUE 144: backend-only launcher pin plan; never execute the secure launcher.
# The caller must import secure-live-launcher-pins.ps1 from the exact verified candidate.
function New-Issue144LauncherPlan([string]$Launcher,[string]$Current,[string]$Candidate,[string]$Backup) {
    Assert-SecureLiveLauncherPins $Launcher $Current
    $pins = Get-SecureLiveLauncherPins $Launcher
    foreach ($path in @('Server/family-auth.mjs','package-lock.json')) {
        if ((Get-FileHash (Join-Path $Candidate $path)).Hash -ne $pins[$path]) {
            throw "Protected authentication/dependency source changed: $path"
        }
    }
    $encoding = [Text.Encoding]::GetEncoding(28591)
    $original = [IO.File]::ReadAllBytes($Launcher)
    $text = $encoding.GetString($original)
    # The front end is unchanged for Issue 144. Only the backend executable
    # source may differ. Preserve all other launcher bytes and pinned hashes.
    $oldIndex = $pins['Server/index.mjs']
    $newIndex = (Get-FileHash (Join-Path $Candidate 'Server/index.mjs')).Hash
    if ($oldIndex -eq $newIndex -or
        [regex]::Matches($text,[regex]::Escape($oldIndex)).Count -ne 1) {
        throw 'Issue 144 requires exactly one changed backend launcher pin.'
    }
    if ($pins['dist/index.html'] -ne (Get-FileHash (Join-Path $Candidate 'dist/index.html')).Hash) {
        throw 'Frontend launcher pin changed during backend-only release.'
    }
    $text = $text.Replace($oldIndex,$newIndex)
    $previous = Join-Path $Backup 'previous-launcher.ps1'
    $prepared = Join-Path $Backup 'candidate-launcher.ps1'
    foreach ($file in @($previous,$prepared)) {
        if (Test-Path -LiteralPath $file) { throw 'Launcher plan already exists.' }
    }
    [IO.File]::WriteAllBytes($previous,$original)
    [IO.File]::WriteAllBytes($prepared,$encoding.GetBytes($text))
    Assert-SecureLiveLauncherPins $previous $Current
    Assert-SecureLiveLauncherPins $prepared $Candidate
    if ((Get-FileHash $previous).Hash -ne (Get-FileHash $Launcher).Hash) {
        throw 'Launcher backup verification failed.'
    }
    return @{Previous=$previous;Candidate=$prepared}
}
