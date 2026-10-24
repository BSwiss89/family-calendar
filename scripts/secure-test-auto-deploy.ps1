# Secure TEST only. Runs from a pinned copy under ProgramData; never from the changing checkout.
# Deploys only the intentionally promoted test-release branch after a successful GitHub Actions push build.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$homePath = 'C:\Users\bobby'
$test = Join-Path $homePath 'Projects\family-calendar-test-security-stage'
$live = Join-Path $homePath 'Projects\family-calendar-live-auth-candidate'
$repo = 'https://github.com/BSwiss89/family-calendar.git'
$branch = 'test-release'
$node = 'C:\ProgramData\FamilyCalendar\Runtime\node-v24.22.1\node.exe'
$taskName = 'Family Calendar Secure TEST'
$supervisor = 'C:\ProgramData\FamilyCalendar\SecureTest\start-secure-test-patched.ps1'
$state = 'C:\ProgramData\FamilyCalendar\SecureTestAutoDeploy'
$holdFile = Join-Path $state 'REQUIRES-REVIEW.txt'
$journal = Join-Path $state 'IN-PROGRESS.txt'
$logFile = Join-Path $state 'auto-test-deploy.log'
$sourcePinHelper = Join-Path $state 'secure-test-source-pins.ps1'
if (!(Test-Path -LiteralPath $sourcePinHelper)) { throw 'Trusted supervisor source-pin helper missing.' }
. $sourcePinHelper
$env:GIT_TERMINAL_PROMPT = '0'
$env:GCM_INTERACTIVE = 'Never'
$env:PATH = (Split-Path $node) + ';' + $env:PATH

function Sha([string]$folder) {
    $v = (& git -C $folder rev-parse HEAD)
    if ($LASTEXITCODE -ne 0 -or $v -notmatch '^[a-f0-9]{40}$') { throw "Invalid Git head: $folder" }
    return $v.Trim()
}
function Assert-Junctions {
    foreach ($entry in @(
        @{Name='data'; Target=(Join-Path $homePath 'Projects\family-calendar-preview\Server\data')},
        @{Name='uploads'; Target=(Join-Path $homePath 'Projects\family-calendar-preview\Server\uploads')}
    )) {
        $item = Get-Item -LiteralPath (Join-Path $test "Server\$($entry.Name)") -Force -ErrorAction Stop
        if ($item.LinkType -ne 'Junction' -or
            -not [string]::Equals([string](@($item.Target)[0]),$entry.Target,[StringComparison]::OrdinalIgnoreCase)) {
            throw "Unexpected TEST $($entry.Name) junction."
        }
    }
    if ((Get-Item -LiteralPath (Join-Path $test 'dist') -Force).LinkType) {
        throw 'TEST dist cannot be a link.'
    }
}
function Test-Listener {
    $all = @(Get-NetTCPConnection -State Listen -LocalPort 13002 -ErrorAction SilentlyContinue)
    if ($all.Count -ne 1) { throw 'Expected exactly one TEST listener on port 13002.' }
    $p = Get-CimInstance Win32_Process -Filter "ProcessId = $($all[0].OwningProcess)" -ErrorAction Stop
    if ($null -eq $p -or -not [string]::Equals($p.ExecutablePath,$node,[StringComparison]::OrdinalIgnoreCase) -or
        $p.CommandLine -notlike '*family-calendar-test-security-stage*' -or
        $all[0].LocalAddress -notmatch '^100\.') {
        throw 'TEST listener/process identity mismatch.'
    }
    return $all[0]
}
function Health-And-Auth {
    $conn = Test-Listener
    $base = "http://$($conn.LocalAddress):13002"
    $h = Invoke-RestMethod -Uri "$base/api/health" -TimeoutSec 5
    $auth = Invoke-RestMethod -Uri "$base/api/auth/status" -TimeoutSec 5
    if ($h.status -ne 'ok' -or $auth.enabled -ne $true) {
        throw 'TEST health or authentication is not verified.'
    }
    try {
        $null = Invoke-WebRequest -Uri "$base/api/events" -UseBasicParsing -TimeoutSec 5
        throw 'Anonymous calendar event access was allowed.'
    } catch {
        if (!$_.Exception.Response -or [int]$_.Exception.Response.StatusCode -ne 401) { throw }
    }
    Write-Host 'PASS: TEST healthy, authentication required, anonymous calendar denied.'
}
function Wait-Healthy {
    for ($i=0; $i -lt 35; $i++) {
        try { Health-And-Auth; return }
        catch { Start-Sleep -Seconds 2 }
    }
    throw 'TEST did not pass health and authentication checks after restart.'
}
function Stop-Only-Test {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort 13002 -ErrorAction SilentlyContinue)
    if ($listeners.Count -gt 1) { throw 'Multiple TEST listeners found.' }
    if ($listeners.Count -eq 1) {
        $p = Get-CimInstance Win32_Process -Filter "ProcessId = $($listeners[0].OwningProcess)"
        if ($null -eq $p -or -not [string]::Equals($p.ExecutablePath,$node,[StringComparison]::OrdinalIgnoreCase) -or
            $p.CommandLine -notlike '*family-calendar-test-security-stage*') {
            throw 'Refusing to terminate an unexpected process.'
        }
        Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
    }
    for ($i=0; $i -lt 20; $i++) {
        if (-not (Get-NetTCPConnection -State Listen -LocalPort 13002 -ErrorAction SilentlyContinue)) { return }
        Start-Sleep -Milliseconds 400
    }
    throw 'TEST listener did not stop.'
}
function Copy-Tree([string]$source,[string]$destination) {
    if (!(Test-Path -LiteralPath $source)) { throw "Backup source missing: $source" }
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    & robocopy.exe $source $destination /E /XJ /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -gt 7) { throw "Backup copy failed: $source" }
}
function Test-PinnedFiles {
    if (!(Test-Path -LiteralPath $node)) { throw 'Pinned Node.js binary missing.' }
    foreach ($p in @($test,$live)) {
        if (!(Test-Path (Join-Path $p '.git'))) { throw "Git checkout missing: $p" }
        if (@(& git -C $p status --porcelain --untracked-files=no | Where-Object { $_ }).Count) {
            throw "Unexpected modified tracked files in: $p"
        }
    }
    Assert-Junctions
    Assert-SecureTestSourcePins $supervisor $test
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
    if ($task.State -ne 'Running' -or
        @($task.Actions | Where-Object { $_.Arguments -like '*start-secure-test-patched.ps1*' }).Count -ne 1) {
        throw 'Secure TEST scheduled task has changed.'
    }
    foreach ($name in @('Family Calendar Auto Preview','Family Calendar Auto Deploy')) {
        $oldTask = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
        if ($oldTask -and $oldTask.State -ne 'Disabled') {
            throw "Legacy task $name is active; refusing overlapping deployment."
        }
    }
    if (!(Get-NetTCPConnection -State Listen -LocalPort 3001 -ErrorAction SilentlyContinue)) {
        throw 'LIVE listener missing. Refusing to deploy.'
    }
    Health-And-Auth
}
New-Item -ItemType Directory -Path $state -Force | Out-Null
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if ($identity.Name -eq 'NT AUTHORITY\SYSTEM' -or
    -not [string]::Equals($env:USERPROFILE,$homePath,[StringComparison]::OrdinalIgnoreCase) -or
    -not ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Only the authorized elevated laptop user may run TEST updates.'
}
$mutex = [System.Threading.Mutex]::new($false,'Global\FamilyCalendarSecureTestAutoDeploy')
$locked = $false
$transcribing = $false
try {
    try { $locked = $mutex.WaitOne(0) }
    catch [System.Threading.AbandonedMutexException] { $locked = $true }
    if (!$locked) { return }
    Start-Transcript -LiteralPath $logFile -Append | Out-Null
    $transcribing = $true
    Write-Host ("TEST AUTO DEPLOY CHECK " + (Get-Date -Format 'o'))
    if ((Test-Path $holdFile) -or (Test-Path $journal)) {
        Write-Warning 'Prior deployment needs manual review. No changes made.'
        return
    }
    Test-PinnedFiles
    $oldSha = Sha $test
    $liveSha = Sha $live

    # Query the dedicated branch only, never draft PR heads, main or "latest" PR.
    $remoteText = @(& git -c credential.helper= ls-remote $repo "refs/heads/$branch")
    if ($LASTEXITCODE -ne 0 -or $remoteText.Count -ne 1) {
        Write-Warning 'Cannot read dedicated GitHub test-release ref. No deployment.'
        return
    }
    $matchRef = [regex]::Match($remoteText[0],'^([a-f0-9]{40})\s+refs/heads/test-release$')
    if (!$matchRef.Success) {
        Write-Warning 'Unexpected GitHub TEST ref; no deployment.'
        return
    }
    $targetSha = $matchRef.Groups[1].Value
    if ($targetSha -eq $oldSha) {
        Write-Host "TEST already at approved SHA $($oldSha.Substring(0,7))."
        return
    }

    # Require completed, successful PUSH workflow on the exact branch and commit.
    # A failed or unavailable check never authorizes deployment.
    $uri = "https://api.github.com/repos/BSwiss89/family-calendar/actions/runs?branch=test-release&event=push&head_sha=$targetSha&per_page=30"
    try {
        $runs = Invoke-RestMethod -Uri $uri -Headers @{ 'User-Agent'='FamilyCalendar-SecureTest-Updater'; 'Accept'='application/vnd.github+json' } -TimeoutSec 15
    } catch {
        Write-Warning 'GitHub CI verification unavailable; retry next check without deploying.'
        return
    }
    $matching = @($runs.workflow_runs | Where-Object {
        $_.name -eq 'Build Family Calendar' -and $_.head_sha -eq $targetSha -and
        $_.head_branch -eq $branch -and $_.event -eq 'push'
    } | Sort-Object id -Descending)
    if ($matching.Count -eq 0 -or $matching[0].status -ne 'completed' -or
        $matching[0].conclusion -ne 'success') {
        Write-Host 'Exact commit has no successful completed TEST push build yet; no deployment.'
        return
    }
    Write-Host "Approved GitHub test-release commit: $targetSha"

    # The candidate is a separate, short-lived clone; never build over a running server.
    $candidate = Join-Path $state ("candidate-" + $targetSha.Substring(0,12))
    if (Test-Path $candidate) { throw 'Candidate folder unexpectedly already exists; manual review required.' }
    & git -c credential.helper= clone --quiet --single-branch --depth 1 --branch $branch $repo $candidate
    if ($LASTEXITCODE -ne 0 -or (Sha $candidate) -ne $targetSha) {
        throw 'Candidate clone SHA mismatch.'
    }
    & git -C $test -c credential.helper= fetch --no-tags $repo "refs/heads/$branch"
    if ($LASTEXITCODE -ne 0 -or (& git -C $test rev-parse FETCH_HEAD).Trim() -ne $targetSha) {
        throw 'TEST fetch SHA mismatch.'
    }
    & git -C $test merge-base --is-ancestor $oldSha $targetSha
    if ($LASTEXITCODE -ne 0) { throw 'TEST release is not a fast-forward from the installed revision.' }
    foreach ($file in @('package.json','package-lock.json')) {
        if ((Get-FileHash (Join-Path $test $file)).Hash -ne (Get-FileHash (Join-Path $candidate $file)).Hash) {
            throw "Dependency changes need a separate reviewed installation: $file"
        }
    }
    Push-Location $candidate
    try {
        & npm.cmd ci --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'Candidate npm ci failed.' }
        & $node --test scripts/test-family-auth.mjs scripts/test-list-features.mjs scripts/test-shopping-stores.mjs scripts/test-list-icons.mjs
        if ($LASTEXITCODE -ne 0) { throw 'Candidate safety tests failed.' }
        & $node --check Server/index.mjs
        if ($LASTEXITCODE -ne 0) { throw 'Candidate backend syntax failed.' }
        & npm.cmd run build
        if ($LASTEXITCODE -ne 0) { throw 'Candidate build failed.' }
    } finally { Pop-Location }
    if (!(Test-Path (Join-Path $candidate 'dist\index.html'))) { throw 'Candidate dist missing.' }
    Assert-Junctions
    Test-PinnedFiles
    if ((Sha $test) -ne $oldSha -or (Sha $live) -ne $liveSha) { throw 'A checkout moved during staging.' }
    $latestRef = @(& git -c credential.helper= ls-remote $repo "refs/heads/$branch")
    if ($LASTEXITCODE -ne 0 -or $latestRef.Count -ne 1 -or
        !$latestRef[0].StartsWith($targetSha + [char]9)) {
        throw 'GitHub TEST branch changed during staging; no deployment.'
    }
    $backup = Join-Path $state ("backups\" + (Get-Date -Format 'yyyyMMdd-HHmmss') + "-" + $oldSha.Substring(0,7))
    if (Test-Path $backup) { throw 'Backup path already exists.' }
    New-Item -ItemType Directory -Path $backup -Force | Out-Null
    Copy-Tree (Join-Path $test 'dist') (Join-Path $backup 'dist')
    $supervisorBackup = Join-Path $backup 'start-secure-test-patched.ps1'
    Copy-Item -LiteralPath $supervisor -Destination $supervisorBackup -ErrorAction Stop
    Assert-SecureTestSourcePins $supervisor $test
    Set-Content -LiteralPath $journal -Value "Started $(Get-Date -Format o) from $oldSha to $targetSha backup $backup" -Encoding UTF8
    $taskDisabled = $false
    $codeChanged = $false
    $pinChanged = $false
    try {
        Disable-ScheduledTask -TaskName $taskName -ErrorAction Stop | Out-Null
        $taskDisabled = $true
        Stop-Only-Test
        Assert-Junctions
        Copy-Tree (Join-Path $test 'Server\data') (Join-Path $backup 'data')
        Copy-Tree (Join-Path $test 'Server\uploads') (Join-Path $backup 'uploads')
        if (!(Test-Path (Join-Path $backup 'data\calendar.db'))) { throw 'TEST database backup missing.' }
        & $node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1],{readOnly:true});const r=d.prepare('PRAGMA quick_check').get();d.close();if(r.quick_check!=='ok')process.exit(2)" (Join-Path $backup 'data\calendar.db')
        if ($LASTEXITCODE -ne 0) { throw 'TEST database backup integrity check failed.' }
        $codeChanged = $true
        & git -C $test checkout --detach --force $targetSha
        if ($LASTEXITCODE -ne 0) { throw 'TEST Git switch failed.' }
        Remove-Item -LiteralPath (Join-Path $test 'dist') -Recurse -Force
        Copy-Tree (Join-Path $candidate 'dist') (Join-Path $test 'dist')
        Assert-Junctions
        $candidateIndex = (Get-FileHash -LiteralPath (Join-Path $candidate 'Server\index.mjs') -Algorithm SHA256).Hash
        $candidateAuth = (Get-FileHash -LiteralPath (Join-Path $candidate 'Server\family-auth.mjs') -Algorithm SHA256).Hash
        if ($candidateIndex -ne (Get-FileHash -LiteralPath (Join-Path $test 'Server\index.mjs') -Algorithm SHA256).Hash -or
            $candidateAuth -ne (Get-FileHash -LiteralPath (Join-Path $test 'Server\family-auth.mjs') -Algorithm SHA256).Hash) {
            throw 'TEST backend files differ from the tested GitHub source.'
        }
        $pinChanged = $true
        $null = Set-SecureTestSourcePins $supervisor $supervisorBackup $candidateIndex $candidateAuth
        Assert-SecureTestSourcePins $supervisor $test
        Enable-ScheduledTask -TaskName $taskName -ErrorAction Stop | Out-Null
        $taskDisabled = $false
        Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
        Wait-Healthy
        Assert-SecureTestSourcePins $supervisor $test
        if ((Sha $test) -ne $targetSha -or (Sha $live) -ne $liveSha) {
            throw 'Post-deployment revision mismatch.'
        }
        Remove-Item -LiteralPath $journal -Force
        Remove-Item -LiteralPath $candidate -Recurse -Force -ErrorAction SilentlyContinue
        Write-Host "TEST AUTO DEPLOY SUCCESS $targetSha. Backup: $backup"
    } catch {
        $message = $_.Exception.Message
        Write-Warning "TEST update failed: $message"
        $rollbackOk = $false
        try {
            if (!$taskDisabled) {
                Disable-ScheduledTask -TaskName $taskName -ErrorAction Stop | Out-Null
                $taskDisabled = $true
            }
            Stop-Only-Test
            if ($codeChanged) {
                & git -C $test checkout --detach --force $oldSha
                if ($LASTEXITCODE -ne 0) { throw 'Previous code checkout failed.' }
                if (Test-Path (Join-Path $test 'dist')) {
                    Remove-Item -LiteralPath (Join-Path $test 'dist') -Recurse -Force
                }
                Copy-Tree (Join-Path $backup 'dist') (Join-Path $test 'dist')
            }
            if ($pinChanged) { Restore-SecureTestSupervisor $supervisor $supervisorBackup }
            Assert-SecureTestSourcePins $supervisor $test
            Enable-ScheduledTask -TaskName $taskName -ErrorAction Stop | Out-Null
            $taskDisabled = $false
            Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
            Wait-Healthy
            $rollbackOk = $true
        } catch {
            Write-Warning ("Rollback needs manual recovery: " + $_.Exception.Message)
        }
        $notice = "Automatic TEST update failed at $(Get-Date -Format o). $message. Old=$oldSha target=$targetSha backup=$backup rollbackHealthy=$rollbackOk. Do not delete journal or hold until recovery review. Logs=$logFile"
        Set-Content -LiteralPath $holdFile -Value $notice -Encoding UTF8
        throw 'TEST deployment failed; automatic retries blocked. Inspect review hold and backup.'
    }
} catch {
    Write-Warning ("TEST AUTO DEPLOY ERROR: " + $_.Exception.Message)
    # Stage/test failures also need a manual hold to avoid repeated unsafe builds.
    if (!(Test-Path $holdFile)) {
        Set-Content -LiteralPath $holdFile -Value ("Failure $(Get-Date -Format o): " + $_.Exception.Message) -Encoding UTF8
    }
    throw
} finally {
    if ($transcribing) { Stop-Transcript | Out-Null }
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
