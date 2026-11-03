# Only synthetic files and temporary directories; no services, tasks or real DBs.
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'secure-live-launcher-pins.ps1')
$temp=Join-Path ([IO.Path]::GetTempPath()) ('fc-launcher-pins-'+[guid]::NewGuid().ToString('N'))
$passed=0
function Expect-Failure([scriptblock]$Action,[string]$Message) {
    $failed=$false
    try { & $Action | Out-Null } catch { $failed=$true }
    if (-not $failed) { throw "Expected rejection: $Message" }
    $script:passed++
}
try {
    $current=Join-Path $temp 'current'
    $candidate=Join-Path $temp 'candidate'
    $backup=Join-Path $temp 'backup'
    foreach ($dir in @($current,$candidate,$backup)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $paths=@('Server/index.mjs','Server/family-auth.mjs','package-lock.json','dist/index.html')
    foreach ($root in @($current,$candidate)) {
        foreach ($relative in $paths) {
            $file=Join-Path $root $relative
            New-Item -ItemType Directory -Path (Split-Path $file -Parent) -Force | Out-Null
            [IO.File]::WriteAllText($file,('synthetic '+$relative),[Text.UTF8Encoding]::new($false))
        }
    }
    [IO.File]::WriteAllText((Join-Path $candidate 'dist/index.html'),'new frontend')
    $launcher=Join-Path $temp 'launcher.ps1'
    $lines=@('# synthetic launcher; must never execute', '$protected = @(')
    foreach ($relative in $paths) {
        $hash=(Get-FileHash (Join-Path $current $relative)).Hash
        $lines+="@{ Path='$relative'; Hash='$hash' }"
    }
    $lines+=')'
    $lines+='throw ''Executing this synthetic launcher is forbidden'''
    # UTF-8 BOM + CRLF prove that pin edits preserve encoding and line endings.
    $utf8=[Text.UTF8Encoding]::new($true)
    $original=$utf8.GetPreamble()+$utf8.GetBytes(($lines -join "`r`n")+"`r`n")
    [IO.File]::WriteAllBytes($launcher,$original)
    Assert-SecureLiveLauncherPins $launcher $current
    $passed++
    $plan=New-SecureLiveLauncherPlan $launcher $current $candidate (Join-Path $candidate 'dist') $backup
    if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($plan.Previous)) -ne [Convert]::ToBase64String($original)) {
        throw 'Rollback launcher bytes changed'
    }
    $expectedText=$utf8.GetString($original).Replace(
        (Get-FileHash (Join-Path $current 'dist/index.html')).Hash,
        (Get-FileHash (Join-Path $candidate 'dist/index.html')).Hash)
    if ($utf8.GetString([IO.File]::ReadAllBytes($plan.Candidate)) -cne $expectedText) {
        throw 'Launcher edit changed more than the frontend pin'
    }
    $passed++

    # Rehearse the mismatch that took LIVE offline, then candidate activation.
    Copy-Item (Join-Path $candidate 'dist/index.html') (Join-Path $current 'dist/index.html') -Force
    Expect-Failure { Assert-SecureLiveLauncherPins $launcher $current } 'stale frontend pin'
    Set-SecureLiveLauncher $plan.Candidate $launcher
    Assert-SecureLiveLauncherPins $launcher $current
    $passed++

    # Rehearse a failed deployment rollback of both frontend and launcher.
    [IO.File]::WriteAllText((Join-Path $current 'dist/index.html'),'synthetic dist/index.html',[Text.UTF8Encoding]::new($false))
    Set-SecureLiveLauncher $plan.Previous $launcher
    Assert-SecureLiveLauncherPins $launcher $current
    if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($launcher)) -ne [Convert]::ToBase64String($original)) {
        throw 'Rollback did not restore the exact original launcher'
    }
    $passed++

    [IO.File]::WriteAllText((Join-Path $candidate 'Server/index.mjs'),'unauthorized backend change')
    Expect-Failure { New-SecureLiveLauncherPlan $launcher $current $candidate (Join-Path $candidate 'dist') $backup } 'backend change in frontend-only release'
    Remove-Item (Join-Path $current 'Server/family-auth.mjs')
    Expect-Failure { Assert-SecureLiveLauncherPins $launcher $current } 'missing protected auth module'
    [IO.File]::WriteAllBytes($launcher,$original)
    $bad=($lines -join "`n").Replace("Path='Server/index.mjs'", "Path='../outside.mjs'")
    [IO.File]::WriteAllText($launcher,$bad)
    Expect-Failure { Get-SecureLiveLauncherPins $launcher } 'path traversal'
    [IO.File]::WriteAllText($launcher,'$p=@(@{Path=''Server/index.mjs'';Hash=(Get-Content secret)})')
    Expect-Failure { Get-SecureLiveLauncherPins $launcher } 'executable pin value'
    [IO.File]::WriteAllText($launcher,($lines -join "`n")+"`n"+$lines[2])
    Expect-Failure { Get-SecureLiveLauncherPins $launcher } 'duplicate pin'

    $sha='ea6dcd4805cf9f3dcf1dc5a9b25a91931148bd6d'
    $approval=[pscustomobject]@{schema=1;kind='deployed-baseline';repository='BSwiss89/family-calendar';to_sha=$sha;files=@()}
    Assert-SecureLiveBaseline $approval $sha
    $passed++
    Expect-Failure { Assert-SecureLiveBaseline $approval ('0'*40) } 'baseline must not deploy another commit'
    $approval.files=@('Server/index.mjs')
    Expect-Failure { Assert-SecureLiveBaseline $approval $sha } 'baseline cannot authorize file changes'

    # Execute the real controller's main try/catch/finally against mocks. A
    # baseline must verify CI and return without reaching any Git/build/cutover.
    $tokens=$null; $errors=$null
    $controller=[System.Management.Automation.Language.Parser]::ParseFile(
        (Join-Path $PSScriptRoot 'secure-live-auto-deploy.ps1'),[ref]$tokens,[ref]$errors)
    $main=@($controller.EndBlock.Statements | Where-Object {
        $_ -is [System.Management.Automation.Language.TryStatementAst]
    })
    if ($main.Count -ne 1) { throw 'Cannot identify controller main transaction' }
    $mainBlock=[scriptblock]::Create($main[0].Extent.Text)
    function Assert([bool]$condition,[string]$message) { if(-not $condition){throw $message} }
    function CheckLocal { $script:localChecks++ }
    function GitSha([string]$folder) { return $sha }
    function GetApproval { return $approval }
    function CheckRun([long]$runId,[string]$name,[string]$commit) {
        if ($runId -ne 41572196673 -or $name -ne 'Build Family Calendar' -or $commit -ne $sha) {
            throw 'Baseline CI verification failed'
        }
        $script:ciChecks++
    }
    function Start-Transcript { }
    function Stop-Transcript { }
    function git { throw 'A baseline must never invoke Git operations' }
    $repo='BSwiss89/family-calendar'; $live=$current; $root=$temp
    $hold=Join-Path $temp 'hold.txt'; $journal=Join-Path $temp 'journal.json'
    $log=Join-Path $temp 'log.txt'; $Apply=$true
    $approval.files=@(); $approval | Add-Member build_run_id 41572196673
    $localChecks=0; $ciChecks=0; $transactionOpened=$false; $transcribing=$false; $locked=$false
    $mutex=[Threading.Mutex]::new($false)
    & $mainBlock
    if ($localChecks -ne 1 -or $ciChecks -ne 1 -or (Test-Path $hold) -or (Test-Path $journal)) {
        throw 'Baseline controller touched transaction state or skipped verification'
    }
    $passed++
    Write-Host "SECURE LIVE LAUNCHER RECOVERY FIXTURES PASS: $passed"
} finally {
    if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Recurse -Force }
}
