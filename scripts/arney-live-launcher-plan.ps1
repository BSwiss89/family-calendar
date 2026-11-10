# Arney LIVE release: update only backend and frontend launcher pins; never execute the secure launcher.
# The caller must import secure-live-launcher-pins.ps1 from the exact verified candidate.
function New-ArneyVoiceLauncherPlan([string]$Launcher,[string]$Current,[string]$Candidate,[string]$Backup) {
    Assert-SecureLiveLauncherPins $Launcher $Current
    $pins = Get-SecureLiveLauncherPins $Launcher
    foreach ($path in @('Server/family-auth.mjs','package-lock.json')) {
        if ((Get-FileHash (Join-Path $Candidate $path)).Hash -ne $pins[$path]) {
            throw "Arney voice release changed protected launcher source: $path"
        }
    }
    $oldIndex = $pins['Server/index.mjs']
    $oldDist = $pins['dist/index.html']
    $newIndex = (Get-FileHash (Join-Path $Candidate 'Server/index.mjs')).Hash
    $newDist = (Get-FileHash (Join-Path $Candidate 'dist/index.html')).Hash
    if ($oldIndex -eq $newIndex -or $oldDist -eq $newDist) {
        throw 'Arney voice release must change both backend and frontend launcher pins.'
    }
    $encoding=[Text.Encoding]::GetEncoding(28591)
    $bytes=[IO.File]::ReadAllBytes($Launcher)
    $text=$encoding.GetString($bytes)
    foreach ($oldHash in @($oldIndex,$oldDist)) {
        if ([regex]::Matches($text,[regex]::Escape($oldHash)).Count -ne 1) {
            throw 'Each changed launcher pin must occur exactly once.'
        }
    }
    $previous=Join-Path $Backup 'previous-launcher.ps1'
    $prepared=Join-Path $Backup 'candidate-launcher.ps1'
    foreach ($file in @($previous,$prepared)) {
        if (Test-Path -LiteralPath $file) { throw 'Launcher plan already exists.' }
    }
    [IO.File]::WriteAllBytes($previous,$bytes)
    $candidateText=$text.Replace($oldIndex,$newIndex).Replace($oldDist,$newDist)
    [IO.File]::WriteAllBytes($prepared,$encoding.GetBytes($candidateText))
    Assert-SecureLiveLauncherPins $previous $Current
    Assert-SecureLiveLauncherPins $prepared $Candidate
    if ((Get-FileHash $previous).Hash -ne (Get-FileHash $Launcher).Hash) {
        throw 'Launcher backup verification failed.'
    }
    return @{Previous=$previous;Candidate=$prepared}
}
