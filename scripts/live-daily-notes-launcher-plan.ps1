# Approved daily Notes LIVE release: pin both authenticated backend index and frontend.
# The existing secure launcher is inspected as inert text, never executed here.
function New-LiveDailyNotesLauncherPlan([string]$Launcher,[string]$Current,[string]$Candidate,[string]$Backup) {
    Assert-SecureLiveLauncherPins $Launcher $Current
    $pins=Get-SecureLiveLauncherPins $Launcher
    foreach ($path in @('Server/family-auth.mjs','package-lock.json')) {
        if ((Get-FileHash -LiteralPath (Join-Path $Candidate $path)).Hash -cne $pins[$path]) {
            throw "Protected LIVE launcher source changed: $path"
        }
    }
    $oldIndex=$pins['Server/index.mjs']; $oldDist=$pins['dist/index.html']
    $newIndex=(Get-FileHash -LiteralPath (Join-Path $Candidate 'Server/index.mjs')).Hash
    $newDist=(Get-FileHash -LiteralPath (Join-Path $Candidate 'dist/index.html')).Hash
    if ($oldIndex -ceq $newIndex -or $oldDist -ceq $newDist) {
        throw 'Daily Notes release requires reviewed backend and frontend changes.'
    }
    $previous=Join-Path $Backup 'previous-launcher.ps1'
    $prepared=Join-Path $Backup 'candidate-launcher.ps1'
    foreach ($file in @($previous,$prepared)) {
        if (Test-Path -LiteralPath $file) { throw 'Recovery launcher path already exists.' }
    }
    $bytes=[IO.File]::ReadAllBytes($Launcher)
    $encoding=[Text.Encoding]::GetEncoding(28591)
    $original=$encoding.GetString($bytes)
    foreach ($pin in @($oldIndex,$oldDist)) {
        if ([regex]::Matches($original,[regex]::Escape($pin)).Count -ne 1) {
            throw 'The changed secure launcher pins must each appear exactly once.'
        }
    }
    $changed=$original.Replace($oldIndex,$newIndex).Replace($oldDist,$newDist)
    [IO.File]::WriteAllBytes($previous,$bytes)
    [IO.File]::WriteAllBytes($prepared,$encoding.GetBytes($changed))
    Assert-SecureLiveLauncherPins $previous $Current
    Assert-SecureLiveLauncherPins $prepared $Candidate
    if ((Get-FileHash $previous).Hash -cne (Get-FileHash $Launcher).Hash) {
        throw 'Launcher recovery byte hash verification failed.'
    }
    return @{Previous=$previous;Candidate=$prepared}
}
