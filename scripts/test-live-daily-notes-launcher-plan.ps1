$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'secure-live-launcher-pins.ps1')
. (Join-Path $PSScriptRoot 'live-daily-notes-launcher-plan.ps1')
$temp=Join-Path ([IO.Path]::GetTempPath()) ('fc-live-notes-'+[guid]::NewGuid().ToString('N'))
function Reject([scriptblock]$code) {
    $blocked=$false
    try { & $code | Out-Null } catch { $blocked=$true }
    if (-not $blocked) { throw 'Unsafe launcher plan was accepted.' }
}
try {
    $current=Join-Path $temp 'current';$candidate=Join-Path $temp 'candidate'
    $backup=Join-Path $temp 'backup';$launcher=Join-Path $temp 'launcher.ps1'
    New-Item -ItemType Directory -Path $backup -Force | Out-Null
    $paths=@('Server/index.mjs','Server/family-auth.mjs','package-lock.json','dist/index.html')
    foreach ($root in @($current,$candidate)) {
        foreach ($path in $paths) {
            $file=Join-Path $root $path
            New-Item -ItemType Directory -Path (Split-Path $file -Parent) -Force | Out-Null
            [IO.File]::WriteAllText($file,'original '+$path)
        }
    }
    $lines=@('# synthetic launcher never execute','$pins=@(')
    foreach ($path in $paths) {
        $lines+="@{Path='$path';Hash='$((Get-FileHash (Join-Path $current $path)).Hash)'}"
    }
    $lines+=')';$lines+='throw ''DO NOT EXECUTE'''
    $encoding=[Text.UTF8Encoding]::new($true)
    $bytes=$encoding.GetPreamble()+$encoding.GetBytes(($lines -join "`r`n")+"`r`n")
    [IO.File]::WriteAllBytes($launcher,$bytes)
    [IO.File]::WriteAllText((Join-Path $candidate 'Server/index.mjs'),'new Notes backend index')
    [IO.File]::WriteAllText((Join-Path $candidate 'dist/index.html'),'new Notes frontend')
    $plan=New-LiveDailyNotesLauncherPlan $launcher $current $candidate $backup
    $expected=[Text.Encoding]::GetEncoding(28591).GetString($bytes)
    foreach ($path in @('Server/index.mjs','dist/index.html')) {
        $expected=$expected.Replace((Get-FileHash (Join-Path $current $path)).Hash,
            (Get-FileHash (Join-Path $candidate $path)).Hash)
    }
    $actual=[Text.Encoding]::GetEncoding(28591).GetString([IO.File]::ReadAllBytes($plan.Candidate))
    if ($actual -cne $expected) { throw 'Planner modified unapproved launcher bytes.' }
    Set-SecureLiveLauncher $plan.Candidate $launcher
    Assert-SecureLiveLauncherPins $launcher $candidate
    Reject { Assert-SecureLiveLauncherPins $launcher $current }
    Set-SecureLiveLauncher $plan.Previous $launcher
    Assert-SecureLiveLauncherPins $launcher $current
    if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($launcher)) -cne
        [Convert]::ToBase64String($bytes)) { throw 'Rollback lost launcher bytes.' }
    foreach ($path in @('Server/family-auth.mjs','package-lock.json')) {
        $f=Join-Path $candidate $path
        $old=[IO.File]::ReadAllBytes($f)
        [IO.File]::WriteAllText($f,'unapproved change')
        $reject=Join-Path $temp ('reject-'+[guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $reject -Force | Out-Null
        Reject { New-LiveDailyNotesLauncherPlan $launcher $current $candidate $reject }
        [IO.File]::WriteAllBytes($f,$old)
    }
    $index=Join-Path $candidate 'Server/index.mjs'
    [IO.File]::WriteAllBytes($index,[IO.File]::ReadAllBytes((Join-Path $current 'Server/index.mjs')))
    $reject=Join-Path $temp 'no-index';New-Item -ItemType Directory -Path $reject -Force | Out-Null
    Reject { New-LiveDailyNotesLauncherPlan $launcher $current $candidate $reject }
    [IO.File]::WriteAllText($index,'new Notes backend index')
    $dist=Join-Path $candidate 'dist/index.html'
    [IO.File]::WriteAllBytes($dist,[IO.File]::ReadAllBytes((Join-Path $current 'dist/index.html')))
    $reject=Join-Path $temp 'no-dist';New-Item -ItemType Directory -Path $reject -Force | Out-Null
    Reject { New-LiveDailyNotesLauncherPlan $launcher $current $candidate $reject }
    Write-Host 'LIVE_DAILY_NOTES_FRONTEND_BACKEND_PIN_AND_ROLLBACK=PASS'
} finally {if (Test-Path $temp) {Remove-Item -LiteralPath $temp -Recurse -Force}}
