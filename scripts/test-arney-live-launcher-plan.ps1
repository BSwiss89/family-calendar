$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'secure-live-launcher-pins.ps1')
. (Join-Path $PSScriptRoot 'arney-live-launcher-plan.ps1')
$temp=Join-Path ([IO.Path]::GetTempPath()) ('fc-arney-live-pins-'+[guid]::NewGuid().ToString('N'))
function Reject([scriptblock]$Action) {
    $rejected=$false
    try { & $Action | Out-Null } catch { $rejected=$true }
    if (-not $rejected) { throw 'Unsafe Arney LIVE launcher plan was accepted.' }
}
try {
    $current=Join-Path $temp 'current'; $candidate=Join-Path $temp 'candidate'
    $backup=Join-Path $temp 'backup'; $launcher=Join-Path $temp 'launcher.ps1'
    New-Item -ItemType Directory -Path $backup -Force | Out-Null
    $paths=@('Server/index.mjs','Server/family-auth.mjs','package-lock.json','dist/index.html')
    foreach ($root in @($current,$candidate)) {
        foreach ($path in $paths) {
            $file=Join-Path $root $path
            New-Item -ItemType Directory -Path (Split-Path $file -Parent) -Force | Out-Null
            [IO.File]::WriteAllText($file,('original '+$path))
        }
    }
    $lines=@('# synthetic launcher; never execute','$pins=@(')
    foreach ($path in $paths) {
        $lines+="@{Path='$path';Hash='$((Get-FileHash (Join-Path $current $path)).Hash)'}"
    }
    $lines+=')'; $lines+='throw ''Do not execute or load launcher secrets'''
    $encoding=[Text.UTF8Encoding]::new($true)
    $bytes=$encoding.GetPreamble()+$encoding.GetBytes(($lines -join "`r`n")+"`r`n")
    [IO.File]::WriteAllBytes($launcher,$bytes)
    [IO.File]::WriteAllText((Join-Path $candidate 'Server/index.mjs'),'Arney backend bridge')
    [IO.File]::WriteAllText((Join-Path $candidate 'dist/index.html'),'Arney voice frontend')
    $plan=New-ArneyVoiceLauncherPlan $launcher $current $candidate $backup
    $expected=[Text.Encoding]::GetEncoding(28591).GetString($bytes)
    $expected=$expected.Replace(
        (Get-FileHash (Join-Path $current 'Server/index.mjs')).Hash,
        (Get-FileHash (Join-Path $candidate 'Server/index.mjs')).Hash)
    $expected=$expected.Replace(
        (Get-FileHash (Join-Path $current 'dist/index.html')).Hash,
        (Get-FileHash (Join-Path $candidate 'dist/index.html')).Hash)
    $actual=[Text.Encoding]::GetEncoding(28591).GetString([IO.File]::ReadAllBytes($plan.Candidate))
    if ($actual -cne $expected) { throw 'Planner changed more than the two approved launcher pins.' }
    Set-SecureLiveLauncher $plan.Candidate $launcher
    Assert-SecureLiveLauncherPins $launcher $candidate
    Reject { Assert-SecureLiveLauncherPins $launcher $current }
    Set-SecureLiveLauncher $plan.Previous $launcher
    Assert-SecureLiveLauncherPins $launcher $current
    if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($launcher)) -cne
        [Convert]::ToBase64String($bytes)) {
        throw 'Rollback lost original BOM, line endings or launcher bytes.'
    }
    foreach ($path in @('Server/family-auth.mjs','package-lock.json')) {
        $file=Join-Path $candidate $path; $original=[IO.File]::ReadAllBytes($file)
        [IO.File]::WriteAllText($file,'unapproved change')
        Reject { New-ArneyVoiceLauncherPlan $launcher $current $candidate $backup }
        [IO.File]::WriteAllBytes($file,$original)
    }
    [IO.File]::WriteAllBytes((Join-Path $candidate 'Server/index.mjs'),[IO.File]::ReadAllBytes((Join-Path $current 'Server/index.mjs')))
    Reject { New-ArneyVoiceLauncherPlan $launcher $current $candidate $backup }
    Write-Host 'ARNEY_LIVE_BACKEND_FRONTEND_LAUNCHER_AND_ROLLBACK=PASS'
} finally {
    if (Test-Path $temp) { Remove-Item $temp -Recurse -Force }
}
