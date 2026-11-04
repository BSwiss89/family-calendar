# Frontend-only People cosmetics on the existing TEST site.
# Default is read-only. -Apply builds isolated source, backs up, then swaps UI.
param([Parameter(Mandatory=$true)][string]$CandidateSha, [switch]$Apply)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$stage = Split-Path $PSScriptRoot -Parent
$test = 'C:\Users\bobby\Projects\family-calendar-test-security-stage'
$live = 'C:\Users\bobby\Projects\family-calendar-live-auth-candidate'
$node = 'C:\ProgramData\FamilyCalendar\Runtime\node-v24.22.1\node.exe'
$original = 'ff63784034a413f463a7e113839a7544802ded03'
$expectedLive = '6b77f15da9e2f4166317e1ad005a6e95501f0dab'
$taskName = 'Family Calendar Secure TEST Auto Deploy'
$state = 'C:\ProgramData\FamilyCalendar\ProfileMonthTest'
$journal = Join-Path $state 'IN-PROGRESS.json'
$tz = [TimeZoneInfo]::FindSystemTimeZoneById('Central Standard Time')
$mutex = [Threading.Mutex]::new($false,'Global\FamilyCalendarSecureTestAutoDeploy')
$locked = $false; $gitChanged = $false; $oldMoved = $false; $opened = $false
$backup = $null; $oldDist = $null; $newDist = $null
$priorPath = $env:PATH

function Report([string]$message) {
    $now = [TimeZoneInfo]::ConvertTimeFromUtc([DateTime]::UtcNow,$tz)
    Write-Host "$($now.ToString('yyyy-MM-dd HH:mm:ss')) America/Chicago | $message"
}
function Assert([bool]$ok,[string]$message) { if (-not $ok) { throw $message } }
function Head([string]$folder) {
    $v = & git -C $folder rev-parse HEAD
    Assert ($LASTEXITCODE -eq 0) 'Cannot read source commit.'
    return ([string]$v).Trim()
}
function Hash([string]$file) { (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash }
function Manifest([string]$folder) {
    Assert (Test-Path -LiteralPath $folder -PathType Container) 'Frontend directory missing.'
    $rows = @(Get-ChildItem -LiteralPath $folder -File -Recurse -Force | ForEach-Object {
        "$($_.FullName.Substring($folder.Length))|$(Hash $_.FullName)"
    } | Sort-Object)
    Assert ($rows.Count -gt 0) 'Empty frontend manifest.'
    return $rows -join "`n"
}
function Status([string]$url) {
    try { return [int](Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 10).StatusCode }
    catch {
        if ($null -ne $_.Exception.Response) { return [int]$_.Exception.Response.StatusCode }
        return 0
    }
}
function Health {
    Assert ((Status 'https://laptop1502.tail3a2e53.ts.net/api/health') -eq 200) 'TEST HTTPS health failed.'
    Assert ((Status 'https://laptop1502.tail3a2e53.ts.net/api/events') -eq 401) 'TEST anonymous events gate failed.'
    Assert ((Status 'https://laptop1502.tail3a2e53.ts.net:8443/api/health') -eq 200) 'LIVE HTTPS health failed.'
    Assert ((Status 'http://127.0.0.1:3001/api/events') -eq 401) 'LIVE anonymous events gate failed.'
}
function ProcessStamp([int]$port,[string]$root) {
    $rows = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop)
    Assert ($rows.Count -eq 1) "Unexpected listeners on port $port."
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($rows[0].OwningProcess)"
    Assert ($null -ne $proc -and $proc.ExecutablePath -ieq $node -and
        $proc.CommandLine -like "*$root*") "Unexpected process on port $port."
    return "$($proc.ProcessId)|$($proc.CreationDate.ToUniversalTime().Ticks)"
}
function SwitchSource([string]$sha) {
    & git -C $test -c advice.detachedHead=false checkout --quiet --detach $sha
    Assert ($LASTEXITCODE -eq 0 -and (Head $test) -eq $sha) 'TEST source checkout failed.'
}

try {
    try { $locked = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked = $true }
    Assert $locked 'Another TEST deployment holds the lock.'
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]$identity
    Assert ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) -and
        $identity.Name -ne 'NT AUTHORITY\SYSTEM') 'Use Administrator PowerShell as Bobby.'
    Assert ($CandidateSha -cmatch '^[a-f0-9]{40}$') 'Invalid candidate SHA.'
    Assert ($stage -ine $test -and $stage -ine $live) 'Use isolated reviewed source.'
    Assert ((Head $stage) -eq $CandidateSha -and (Head $test) -eq $original -and
        (Head $live) -eq $expectedLive) 'Source baseline changed; inspect before deployment.'
    foreach ($folder in @($stage,$test)) {
        $dirty = @(& git -C $folder status --porcelain --untracked-files=no)
        Assert ($LASTEXITCODE -eq 0 -and $dirty.Count -eq 0) 'Tracked source is not clean.'
    }
    $task = Get-ScheduledTask -TaskName $taskName
    Assert ($task.State -eq 'Disabled' -and -not $task.Settings.Enabled) 'TEST auto-deployment must remain disabled.'
    Assert ((Get-ScheduledTask -TaskName 'Family Calendar Secure TEST').State -eq 'Running') 'TEST task is not running.'
    Assert (-not (Test-Path -LiteralPath $journal)) 'Prior manual cutover journal requires inspection.'
    foreach ($name in @('IN-PROGRESS.txt','REQUIRES-REVIEW.txt')) {
        Assert (-not (Test-Path -LiteralPath "C:\ProgramData\FamilyCalendar\SecureTestAutoDeploy\$name")) "Existing TEST updater state requires inspection: $name"
    }
    & git -C $stage merge-base --is-ancestor $original $CandidateSha
    Assert ($LASTEXITCODE -eq 0) 'Candidate does not descend from current TEST.'
    $allowed = @('src/App.tsx','src/App.css','scripts/test-mobile-profile-editor.mjs',
        'scripts/deploy-test-profile-month-ui.ps1')
    $changed = @(& git -C $stage diff --name-only $original $CandidateSha | Sort-Object)
    Assert ($LASTEXITCODE -eq 0 -and ($changed -join '|') -ceq (($allowed | Sort-Object) -join '|')) 'Candidate file scope differs from review.'
    & git -C $stage diff --quiet $original $CandidateSha -- Server package.json package-lock.json
    Assert ($LASTEXITCODE -eq 0) 'Backend/auth/dependency changes are forbidden.'
    foreach ($path in @('Server\index.mjs','Server\family-auth.mjs','package.json','package-lock.json')) {
        Assert ((Hash (Join-Path $test $path)) -eq (Hash (Join-Path $stage $path))) 'Installed protected files differ from candidate.'
    }
    Health
    $testProcess = ProcessStamp 13002 $test
    $liveProcess = ProcessStamp 3001 $live
    $liveFrontend = Manifest "$live\dist"
    $liveLauncher = Hash 'C:\ProgramData\FamilyCalendar\SecureLive\start-secure-live-node24.ps1'
    $supervisor = Hash 'C:\ProgramData\FamilyCalendar\SecureTest\start-secure-test-patched.ps1'
    Report 'TEST_CANDIDATE_PREFLIGHT=PASS | LIVE_AND_TEST_HEALTH=PASS'
    if (-not $Apply) { Report 'CHANGES_MADE=NONE'; return }

    # Exact-head CI must pass before building or changing the running TEST site.
    $url = "https://api.github.com/repos/BSwiss89/family-calendar/actions/runs?head_sha=$CandidateSha&event=pull_request&per_page=100"
    $runs = Invoke-RestMethod $url -Headers @{'User-Agent'='FamilyCalendar-TestProfileRelease'} -TimeoutSec 25
    foreach ($name in @('Build Family Calendar','Profile picker browser regressions')) {
        $run = @($runs.workflow_runs | Where-Object { $_.name -eq $name -and $_.head_sha -eq $CandidateSha } | Sort-Object id -Descending | Select-Object -First 1)
        Assert ($run.Count -eq 1 -and $run[0].status -eq 'completed' -and $run[0].conclusion -eq 'success') "Exact-head CI not successful: $name"
    }
    $env:PATH = (Split-Path $node) + ';' + $env:PATH
    Push-Location $stage
    try {
        & npm.cmd ci --no-audit --no-fund
        Assert ($LASTEXITCODE -eq 0) 'Isolated npm ci failed.'
        & npm.cmd run build
        Assert ($LASTEXITCODE -eq 0) 'Isolated frontend build failed.'
    } finally { Pop-Location }
    Health
    Assert ((Head $test) -eq $original -and (Head $live) -eq $expectedLive) 'Source changed during staging.'
    $tag = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0,6)
    $backup = "C:\Users\bobby\CalendarBackups\ProfileMonthTest\$tag"
    New-Item -ItemType Directory -Path $backup | Out-Null
    & icacls.exe $backup '/inheritance:r' '/grant:r' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' "$($identity.Name):(OI)(CI)F" | Out-Null
    Assert ($LASTEXITCODE -eq 0) 'Cannot restrict recovery directory.'
    Export-ScheduledTask -TaskName 'Family Calendar Secure TEST' | Set-Content "$backup\test-task.xml" -Encoding UTF8
    Export-ScheduledTask -TaskName $taskName | Set-Content "$backup\test-updater-task.xml" -Encoding UTF8
    Copy-Item "$test\dist" "$backup\previous-dist" -Recurse
    Assert ((Manifest "$test\dist") -ceq (Manifest "$backup\previous-dist")) 'Frontend backup verification failed.'
    $backupTool = @'
const {DatabaseSync,backup}=require('node:sqlite');
const fs=require('node:fs'); const crypto=require('node:crypto');
(async()=>{
 const [source,dest]=process.argv.slice(2); const db=new DatabaseSync(source,{readOnly:true});
 try{await backup(db,dest)}finally{db.close()}
 fs.copyFileSync(dest,dest+'.restore-check',fs.constants.COPYFILE_EXCL);
 for(const file of [dest,dest+'.restore-check']){
  const check=new DatabaseSync(file,{readOnly:true});
  try{const rows=check.prepare('PRAGMA integrity_check').all();
   if(rows.length!==1||rows[0].integrity_check!=='ok'||check.prepare('PRAGMA foreign_key_check').all().length)throw Error('SQLite verification failed');
  }finally{check.close()}
 }
 const hash=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
 if(hash(dest)!==hash(dest+'.restore-check'))throw Error('Backup copy mismatch');
 console.log('SQLITE_ONLINE_BACKUP_AND_ISOLATED_RESTORE=PASS');
})().catch(e=>{console.error(e.message);process.exitCode=1});
'@
    [IO.File]::WriteAllText("$backup\backup-db.cjs",$backupTool,[Text.UTF8Encoding]::new($false))
    & $node --no-warnings "$backup\backup-db.cjs" "$test\Server\data\calendar.db" "$backup\calendar.db"
    Assert ($LASTEXITCODE -eq 0) 'TEST online database backup failed.'
    $oldDist = Join-Path $backup 'active-dist-before-cutover'
    $newDist = Join-Path $test "dist-profile-candidate-$tag"
    Copy-Item "$stage\dist" $newDist -Recurse
    foreach ($file in Get-ChildItem "$test\dist\assets" -File) {
        $dest = Join-Path "$newDist\assets" $file.Name
        if (-not (Test-Path -LiteralPath $dest)) { Copy-Item -LiteralPath $file.FullName -Destination $dest }
    }
    $candidateManifest = Manifest $newDist
    & git -C $test fetch --quiet $stage $CandidateSha
    Assert ($LASTEXITCODE -eq 0) 'Candidate object transfer failed.'
    New-Item -ItemType Directory -Path $state -Force | Out-Null
    @{from=$original;to=$CandidateSha;backup=$backup;oldDist=$oldDist;newDist=$newDist} |
        ConvertTo-Json | Set-Content -LiteralPath $journal -Encoding UTF8
    $opened = $true
    $gitChanged = $true
    SwitchSource $CandidateSha
    Move-Item "$test\dist" $oldDist
    $oldMoved = $true
    Move-Item $newDist "$test\dist"
    Assert ((Manifest "$test\dist") -ceq $candidateManifest) 'Installed frontend differs from staged build.'
    Health
    Assert ((Head $test) -eq $CandidateSha -and (Head $live) -eq $expectedLive -and
        (ProcessStamp 13002 $test) -ceq $testProcess -and (ProcessStamp 3001 $live) -ceq $liveProcess -and
        (Manifest "$live\dist") -ceq $liveFrontend -and
        (Hash 'C:\ProgramData\FamilyCalendar\SecureLive\start-secure-live-node24.ps1') -eq $liveLauncher -and
        (Hash 'C:\ProgramData\FamilyCalendar\SecureTest\start-secure-test-patched.ps1') -eq $supervisor) 'Post-cutover source/process/launcher verification failed.'
    Assert (-not (Get-ScheduledTask -TaskName $taskName).Settings.Enabled) 'TEST updater state changed.'
    Remove-Item -LiteralPath $journal
    $opened = $false
    Report "TEST_FRONTEND_DEPLOYMENT=PASS | SHA=$CandidateSha"
    Report 'LIVE_UNCHANGED=PASS | BOTH_SERVER_PROCESSES_UNCHANGED=PASS | TEST_AUTO_DEPLOY=Disabled'
    Report "RECOVERY_FOLDER=$backup"
} catch {
    Report "TEST_FRONTEND_DEPLOYMENT=FAIL | $($_.Exception.Message)"
    if ($opened) {
        try {
            if ($oldMoved) {
                if (Test-Path "$test\dist") { Move-Item "$test\dist" "$backup\rejected-dist" }
                Move-Item $oldDist "$test\dist"
            }
            if ($gitChanged) { SwitchSource $original }
            Assert ((Manifest "$test\dist") -ceq (Manifest "$backup\previous-dist")) 'Restored frontend does not match backup.'
            Health
            Remove-Item -LiteralPath $journal
            Report 'TEST_FRONTEND_ROLLBACK=PASS'
        } catch { Report "TEST_FRONTEND_ROLLBACK=FAIL | $($_.Exception.Message) | KEEP_JOURNAL_FOR_REVIEW" }
    }
    if ($null -ne $backup) { Report "RECOVERY_FOLDER=$backup" }
    throw
} finally {
    $env:PATH = $priorPath
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
