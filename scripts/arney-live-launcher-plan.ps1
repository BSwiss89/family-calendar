# Arney People LIVE release: update only the frontend launcher pin; never execute the secure launcher.
# The caller must import secure-live-launcher-pins.ps1 from the exact verified candidate.
function New-ArneyVoiceLauncherPlan([string]$Launcher,[string]$Current,[string]$Candidate,[string]$Backup) {
    Assert-SecureLiveLauncherPins $Launcher $Current
    $pins = Get-SecureLiveLauncherPins $Launcher
    foreach ($path in @('Server/family-auth.mjs','package-lock.json')) {
        if ((Get-FileHash (Join-Path $Candidate $path)).Hash -ne $pins[$path]) {
            throw "Arney People release changed protected launcher source: $path"
        }
    }
    $oldIndex = $pins['Server/index.mjs']
    $oldDist = $pins['dist/index.html']
    $newIndex = (Get-FileHash (Join-Path $Candidate 'Server/index.mjs')).Hash
    $newDist = (Get-FileHash (Join-Path $Candidate 'dist/index.html')).Hash
    if ($oldIndex -ne $newIndex) {
        throw 'Arney People release unexpectedly changed the backend launcher pin.'
    }
    if ($oldDist -eq $newDist) {
        throw 'Arney People release must change the frontend launcher pin.'
    }
    $encoding=[Text.Encoding]::GetEncoding(28591)
    $bytes=[IO.File]::ReadAllBytes($Launcher)
    $text=$encoding.GetString($bytes)
    if ([regex]::Matches($text,[regex]::Escape($oldDist)).Count -ne 1) {
        throw 'Changed frontend launcher pin must occur exactly once.'
    }
    $previous=Join-Path $Backup 'previous-launcher.ps1'
    $prepared=Join-Path $Backup 'candidate-launcher.ps1'
    foreach ($file in @($previous,$prepared)) {
        if (Test-Path -LiteralPath $file) { throw 'Launcher plan already exists.' }
    }
    [IO.File]::WriteAllBytes($previous,$bytes)
    $candidateText=$text.Replace($oldDist,$newDist)
    [IO.File]::WriteAllBytes($prepared,$encoding.GetBytes($candidateText))
    Assert-SecureLiveLauncherPins $previous $Current
    Assert-SecureLiveLauncherPins $prepared $Candidate
    if ((Get-FileHash $previous).Hash -ne (Get-FileHash $Launcher).Hash) {
        throw 'Launcher backup verification failed.'
    }
    return @{Previous=$previous;Candidate=$prepared}
}
