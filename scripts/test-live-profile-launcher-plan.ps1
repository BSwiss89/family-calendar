$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'live-profile-launcher-plan.ps1')
$temp=Join-Path ([IO.Path]::GetTempPath()) ('fc-profile-pins-'+[guid]::NewGuid().ToString('N'))
function Reject([scriptblock]$Action) {
    $rejected=$false
    try { & $Action | Out-Null } catch { $rejected=$true }
    if (-not $rejected) { throw 'Unsafe launcher change was accepted.' }
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
    $lines=@('# synthetic launcher; never execute', '$pins=@(')
    foreach ($path in $paths) {
        $lines+="@{Path='$path';Hash='$((Get-FileHash (Join-Path $current $path)).Hash)'}"
    }
    $lines+=')'; $lines+='throw ''Do not execute this launcher or load secrets'''
    $encoding=[Text.UTF8Encoding]::new($true)
    $bytes=$encoding.GetPreamble()+$encoding.GetBytes(($lines -join "`r`n")+"`r`n")
    [IO.File]::WriteAllBytes($launcher,$bytes)
    foreach ($path in @('Server/index.mjs','dist/index.html')) {
        [IO.File]::WriteAllText((Join-Path $candidate $path),('new '+$path))
    }
    # The frontend-only planner must still reject backend changes.
    Reject { New-SecureLiveLauncherPlan $launcher $current $candidate (Join-Path $candidate 'dist') $backup }
    $plan=New-LiveProfileLauncherPlan $launcher $current $candidate $backup
    $expected=[Text.Encoding]::GetEncoding(28591).GetString($bytes)
    foreach ($path in @('Server/index.mjs','dist/index.html')) {
        $expected=$expected.Replace((Get-FileHash (Join-Path $current $path)).Hash,(Get-FileHash (Join-Path $candidate $path)).Hash)
    }
    $actual=[Text.Encoding]::GetEncoding(28591).GetString([IO.File]::ReadAllBytes($plan.Candidate))
    if ($actual -cne $expected) { throw 'Launcher edit changed bytes beyond the two intended pins.' }
    Set-SecureLiveLauncher $plan.Candidate $launcher
    Assert-SecureLiveLauncherPins $launcher $candidate
    Reject { Assert-SecureLiveLauncherPins $launcher $current }
    Set-SecureLiveLauncher $plan.Previous $launcher
    Assert-SecureLiveLauncherPins $launcher $current
    if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($launcher)) -cne [Convert]::ToBase64String($bytes)) {
        throw 'Rollback lost original BOM, line endings or launcher bytes.'
    }
    foreach ($path in @('Server/family-auth.mjs','package-lock.json')) {
        $file=Join-Path $candidate $path; $original=[IO.File]::ReadAllBytes($file)
        [IO.File]::WriteAllText($file,'unapproved change')
        Reject { New-LiveProfileLauncherPlan $launcher $current $candidate $backup }
        [IO.File]::WriteAllBytes($file,$original)
    }
    $bad=($lines -join "`n").Replace("Path='Server/index.mjs'","Path='../outside'")
    [IO.File]::WriteAllText($launcher,$bad)
    Reject { Get-SecureLiveLauncherPins $launcher }
    [IO.File]::WriteAllText($launcher,'$p=@(@{Path=''Server/index.mjs'';Hash=(Get-Content secret)})')
    Reject { Get-SecureLiveLauncherPins $launcher }
    Write-Host 'LIVE_PROFILE_LAUNCHER_ACTIVATION_AND_ROLLBACK=PASS'
} finally {
    if (Test-Path $temp) { Remove-Item $temp -Recurse -Force }
}
