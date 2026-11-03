# Inspect launcher source only. Never execute it or load its secrets.
. (Join-Path $PSScriptRoot 'secure-live-launcher-pins.ps1')
function New-LiveProfileLauncherPlan([string]$Launcher,[string]$Current,[string]$Candidate,[string]$Backup) {
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
    foreach ($path in @('Server/index.mjs','dist/index.html')) {
        $old = $pins[$path]
        $new = (Get-FileHash (Join-Path $Candidate $path)).Hash
        if ($old -eq $new -or [regex]::Matches($text,[regex]::Escape($old)).Count -ne 1) {
            throw "Expected one changed launcher pin: $path"
        }
        $text = $text.Replace($old,$new)
    }
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
