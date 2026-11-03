# Manual TEST-only deployment. Never merges, changes dependencies, or stops LIVE.
param([switch]$Apply)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$from = 'e6790c73e458535f78964909d64891431c00a4bd'
$to = '249d55527851290cbd9111ca81dc1650cd404c96'
$liveSha = 'ea6dcd4805cf9f3dcf1dc5a9b25a91931148bd6d'
$test = 'C:\Users\bobby\Projects\family-calendar-test-security-stage'
$live = 'C:\Users\bobby\Projects\family-calendar-live-auth-candidate'
$node = 'C:\ProgramData\FamilyCalendar\Runtime\node-v24.22.1\node.exe'
$supervisor = 'C:\ProgramData\FamilyCalendar\SecureTest\start-secure-test-patched.ps1'
$supervisorHash = '4539413D837952E8D1BC16970A5E506047CC5993B45474F6F500CB8568BE2F22'
$oldIndex = '2FC3034D51F55B7BC8EDB22D2DBCA5827FC2012CC459B50AFFB11AE2D20FD098'
$oldAuth = 'CC3A1B14834BD3E3AB40437E5164174FADEE25CCFE869CC8EC6438BC0316FC30'
$state = 'C:\ProgramData\FamilyCalendar\ProfilePhotoTest'
$stage = Join-Path $state 'candidate-249d5552'
$journal = Join-Path $state 'IN-PROGRESS.json'
$taskName = 'Family Calendar Secure TEST'
$auto = 'Family Calendar Secure TEST Auto Deploy'
$watchdog = 'Family Calendar Watchdog'
$tz = [TimeZoneInfo]::FindSystemTimeZoneById('Central Standard Time')
$priorPath = $env:PATH
$mutex = [Threading.Mutex]::new($false,'Global\FamilyCalendarSecureTestAutoDeploy')
$locked = $false; $paused = $false; $touched = $false; $changed = $false
$oldMoved = $false; $opened = $false; $success = $false; $rollbackOk = $false
$backup = $null; $oldDist = $null; $newDist = $null

function Report([string]$message) {
    $now = [TimeZoneInfo]::ConvertTimeFromUtc([DateTime]::UtcNow,$tz)
    Write-Host "$($now.ToString('yyyy-MM-dd HH:mm:ss')) America/Chicago | $message"
}
function Assert([bool]$ok,[string]$message) { if (-not $ok) { throw $message } }
function Hash([string]$file) { (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash }
function Head([string]$folder) {
    $v = & git -C $folder rev-parse HEAD
    Assert ($LASTEXITCODE -eq 0) 'Cannot read source SHA.'
    return ([string]$v).Trim()
}
function Manifest([string]$folder) {
    Assert (Test-Path -LiteralPath $folder -PathType Container) "Directory missing: $folder"
    # Build relative names from directory entries, independent of Windows short
    # paths, provider normalization and a legitimate root uploads junction.
    $walk = {
        param([string]$dir,[string]$prefix)
        foreach ($item in Get-ChildItem -LiteralPath $dir -Force) {
            Assert (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) 'Nested storage links require review.'
            if ($item.PSIsContainer) { & $walk $item.FullName ($prefix + $item.Name + '\') }
            else { "$prefix$($item.Name)|$(Hash $item.FullName)" }
        }
    }
    return (@(& $walk $folder '' | Sort-Object) -join "`n")
}
function CopyVerified([string]$source,[string]$destination) {
    Assert (-not (Test-Path -LiteralPath $destination)) 'Backup destination already exists.'
    $links=@(Get-ChildItem -LiteralPath $source -Recurse -Force | Where-Object {
        ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
    })
    Assert ($links.Count -eq 0) 'Nested storage links require review.'
    # Source may itself be TEST's uploads junction. Always create a real backup
    # directory and copy its contents, never an alias back to the active uploads.
    New-Item -ItemType Directory -Path $destination -ErrorAction Stop | Out-Null
    foreach ($item in Get-ChildItem -LiteralPath $source -Force) {
        Copy-Item -LiteralPath $item.FullName -Destination $destination -Recurse -ErrorAction Stop
    }
    Assert ((Manifest $source) -ceq (Manifest $destination)) 'Directory backup hash verification failed.'
}
function Status([string]$url) {
    try { return [int](Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 4).StatusCode }
    catch {
        if ($null -ne $_.Exception.Response) { return [int]$_.Exception.Response.StatusCode }
        return 0
    }
}
function OwnedProcess([int]$port,[string]$root,[bool]$optional=$false) {
    $rows = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
    if ($optional -and $rows.Count -eq 0) { return $null }
    Assert ($rows.Count -eq 1) "Unexpected listeners on port $port."
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($rows[0].OwningProcess)"
    Assert ($null -ne $proc -and $proc.ExecutablePath -ieq $node -and
        $proc.CommandLine -like "*$root*") "Unexpected process on port $port."
    return $proc
}
function LiveStamp {
    $p = OwnedProcess 3001 $live
    return "$($p.ProcessId)|$($p.CreationDate.ToUniversalTime().Ticks)|$(Head $live)|$(Hash "$live\dist\index.html")|$(Hash 'C:\ProgramData\FamilyCalendar\SecureLive\start-secure-live-node24.ps1')"
}
function Healthy {
    $null = OwnedProcess 13002 $test
    Assert ((Status 'https://laptop1502.tail3a2e53.ts.net/api/health') -eq 200) 'TEST HTTPS health failed.'
    Assert ((Status 'https://laptop1502.tail3a2e53.ts.net/api/events') -eq 401) 'TEST anonymous events gate failed.'
    $auth = Invoke-RestMethod 'https://laptop1502.tail3a2e53.ts.net/api/auth/status' -TimeoutSec 4
    Assert ($auth.enabled -eq $true) 'TEST authentication is not enabled.'
    Assert ((Status 'https://laptop1502.tail3a2e53.ts.net:8443/api/health') -eq 200) 'LIVE HTTPS health failed.'
    Assert ((Status 'http://127.0.0.1:3001/api/events') -eq 401) 'LIVE anonymous events gate failed.'
}
function StopTest {
    $null = OwnedProcess 13002 $test $true
    Stop-ScheduledTask -TaskName $taskName -ErrorAction Stop
    for ($i=0; $i -lt 10; $i++) {
        if ((Get-ScheduledTask -TaskName $taskName).State -ne 'Running') { break }
        Start-Sleep -Seconds 1
    }
    Assert ((Get-ScheduledTask -TaskName $taskName).State -ne 'Running') 'TEST supervisor did not stop.'
    $p = OwnedProcess 13002 $test $true
    if ($null -ne $p) { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop }
    for ($i=0; $i -lt 10; $i++) {
        if ($null -eq (OwnedProcess 13002 $test $true)) { return }
        Start-Sleep -Milliseconds 500
    }
    throw 'TEST listener did not stop.'
}
function StartTest {
    Enable-ScheduledTask -TaskName $taskName -ErrorAction Stop | Out-Null
    Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
    for ($i=0; $i -lt 25; $i++) {
        Start-Sleep -Seconds 1
        try { Healthy; return } catch {}
        if ($i % 5 -eq 4) { Report "TEST_START_WAIT=$($i+1)" }
    }
    throw 'TEST startup verification failed.'
}
function SwitchTest([string]$sha) {
    & git -C $test -c advice.detachedHead=false checkout --quiet --detach $sha
    Assert ($LASTEXITCODE -eq 0 -and (Head $test) -eq $sha) 'TEST source checkout failed.'
}
function CheckCI {
    $runs = Invoke-RestMethod "https://api.github.com/repos/BSwiss89/family-calendar/actions/runs?head_sha=$to&event=pull_request&per_page=100" -Headers @{'User-Agent'='FamilyCalendar-TestPhotoRelease'} -TimeoutSec 25
    foreach ($name in @('Build Family Calendar','Profile picker browser regressions')) {
        $run = @($runs.workflow_runs | Where-Object { $_.head_sha -eq $to -and $_.name -eq $name } | Sort-Object id -Descending | Select-Object -First 1)
        Assert ($run.Count -eq 1 -and $run[0].status -eq 'completed' -and $run[0].conclusion -eq 'success') "Exact-head CI is not successful: $name"
    }
}

try {
    try { $locked = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked = $true }
    Assert $locked 'Another TEST deployment holds the lock.'
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    Assert (([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) -and $identity.Name -ne 'NT AUTHORITY\SYSTEM') 'Use Administrator PowerShell as Bobby.'
    Assert ((Head $test) -eq $from -and (Head $live) -eq $liveSha) 'Installed source baseline changed.'
    $dirty = @(& git -C $test status --porcelain --untracked-files=no)
    Assert ($LASTEXITCODE -eq 0 -and $dirty.Count -eq 0) 'TEST tracked source is dirty.'
    Assert ((Hash $supervisor) -eq $supervisorHash -and (Hash "$test\Server\index.mjs") -eq $oldIndex -and (Hash "$test\Server\family-auth.mjs") -eq $oldAuth) 'Observed TEST supervisor/backend pins changed.'
    $tokens=$null; $parseErrors=$null
    $supervisorAst=[System.Management.Automation.Language.Parser]::ParseFile($supervisor,[ref]$tokens,[ref]$parseErrors)
    Assert (@($parseErrors).Count -eq 0) 'Installed supervisor syntax is invalid.'
    $literalHashes=@($supervisorAst.FindAll({param($n)
        $n -is [System.Management.Automation.Language.StringConstantExpressionAst] -and $n.Value -match '^[A-Fa-f0-9]{64}$'
    },$true) | ForEach-Object { $_.Value.ToUpperInvariant() })
    Assert ($literalHashes.Count -eq 2 -and $literalHashes -contains $oldIndex -and $literalHashes -contains $oldAuth) 'Additional supervisor integrity checks require inspection.'
    $serverTask = Get-ScheduledTask -TaskName $taskName
    Assert ($serverTask.State -eq 'Running' -and $serverTask.Settings.Enabled) 'TEST task is not enabled/running.'
    $actions = ($serverTask.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments)" }) -join ' '
    Assert ($actions -like "*$supervisor*") 'TEST task launcher changed.'
    Assert (-not (Get-ScheduledTask -TaskName $auto).Settings.Enabled) 'TEST auto-deployment must remain disabled.'
    $wd = Get-ScheduledTask -TaskName $watchdog
    Assert ($wd.Settings.Enabled -and $wd.State -ne 'Running') 'Watchdog must be enabled and idle.'
    foreach ($path in @($journal,'C:\ProgramData\FamilyCalendar\ProfileMonthTest\IN-PROGRESS.json',
        'C:\ProgramData\FamilyCalendar\SecureTestAutoDeploy\IN-PROGRESS.txt',
        'C:\ProgramData\FamilyCalendar\SecureTestAutoDeploy\REQUIRES-REVIEW.txt')) {
        Assert (-not (Test-Path -LiteralPath $path)) "Recovery state requires inspection: $path"
    }
    Assert (-not (Get-Item -LiteralPath "$test\dist" -Force).LinkType) 'TEST frontend cannot be a link.'
    Healthy
    $liveBefore = LiveStamp
    $liveFiles = Manifest "$live\dist"
    $oldManifest = Manifest "$test\dist"
    Assert ($oldManifest.Length -gt 0) 'TEST frontend is empty.'
    CheckCI
    Report 'PHOTO_TEST_PREFLIGHT=PASS | EXACT_HEAD_CI=PASS'
    if (-not $Apply) { Report 'CHANGES_MADE=NONE'; return }

    New-Item -ItemType Directory -Path $state -Force | Out-Null
    if (-not (Test-Path -LiteralPath $stage)) {
        & git -c credential.interactive=never clone --quiet --no-checkout --branch feature/profile-photo-edit-remove-20261103 https://github.com/BSwiss89/family-calendar.git $stage
        Assert ($LASTEXITCODE -eq 0) 'Candidate clone failed.'
        & git -C $stage checkout --quiet --detach $to
        Assert ($LASTEXITCODE -eq 0) 'Candidate checkout failed.'
    }
    Assert ((Head $stage) -eq $to) 'Unexpected candidate commit.'
    $dirty = @(& git -C $stage status --porcelain --untracked-files=no)
    Assert ($LASTEXITCODE -eq 0 -and $dirty.Count -eq 0) 'Candidate tracked source is dirty.'
    $allowed = @('.github/workflows/build.yml','Server/index.mjs','scripts/deploy-test-profile-month-ui.ps1',
        'scripts/test-person-photo-edit.mjs','scripts/test-profile-picker-browser.mjs','src/App.css','src/App.tsx')
    $files = @(& git -C $stage diff --name-only $from $to | Sort-Object)
    Assert ($LASTEXITCODE -eq 0 -and ($files -join '|') -ceq (($allowed | Sort-Object) -join '|')) 'Candidate file scope differs from review.'
    foreach ($path in @('Server\family-auth.mjs','package.json','package-lock.json')) {
        Assert ((Hash (Join-Path $stage $path)) -eq (Hash (Join-Path $test $path))) 'Auth/dependency files differ.'
    }
    . "$stage\scripts\secure-test-source-pins.ps1"
    Assert-SecureTestSourcePins $supervisor $test
    $env:PATH = (Split-Path $node) + ';' + $env:PATH
    Push-Location $stage
    try {
        & npm.cmd ci --no-audit --no-fund
        Assert ($LASTEXITCODE -eq 0) 'Isolated npm ci failed.'
        & $node --test scripts/test-person-photo-edit.mjs
        Assert ($LASTEXITCODE -eq 0) 'Staged actual-backend photo tests failed.'
        & npm.cmd run build
        Assert ($LASTEXITCODE -eq 0) 'Staged frontend build failed.'
    } finally { Pop-Location }
    Assert (Test-Path "$stage\dist\index.html" -PathType Leaf) 'Built frontend index is missing.'
    Healthy
    Assert ((Head $test) -eq $from -and (LiveStamp) -ceq $liveBefore -and (Hash $supervisor) -eq $supervisorHash) 'Installed state changed during staging.'
    $tag = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0,6)
    $backup = "C:\Users\bobby\CalendarBackups\ProfilePhotoTest\$tag"
    New-Item -ItemType Directory -Path $backup | Out-Null
    & icacls.exe $backup '/inheritance:r' '/grant:r' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' "$($identity.Name):(OI)(CI)F" | Out-Null
    Assert ($LASTEXITCODE -eq 0) 'Cannot restrict recovery directory.'
    Copy-Item -LiteralPath $supervisor -Destination "$backup\previous-supervisor.ps1"
    Copy-Item "$test\Server\index.mjs" "$backup\previous-index.mjs"
    Assert ((Hash "$backup\previous-supervisor.ps1") -eq $supervisorHash -and (Hash "$backup\previous-index.mjs") -eq $oldIndex) 'Source/launcher backup verification failed.'
    foreach ($name in @($taskName,$auto,$watchdog)) {
        Export-ScheduledTask -TaskName $name | Set-Content (Join-Path $backup "$name.xml") -Encoding UTF8
    }
    Copy-Item "$backup\previous-supervisor.ps1" "$backup\candidate-supervisor.ps1"
    $newIndex = Hash "$stage\Server\index.mjs"
    $null = Set-SecureTestSourcePins "$backup\candidate-supervisor.ps1" "$backup\previous-supervisor.ps1" $newIndex $oldAuth
    $planPins = Get-SecureTestSourcePins "$backup\candidate-supervisor.ps1"
    Assert ($planPins.Index -eq $newIndex -and $planPins.Auth -eq $oldAuth) 'Prepared supervisor pins failed.'
    $dbTool = @'
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {DatabaseSync,backup}=require('node:sqlite');
const [mode,source,root,liveDb,testUploads,liveUploads]=process.argv.slice(2);
const tables=['events','people','lists','list_items','recipes','meal_plan_items','family_users','family_sessions'];
function inspect(file){const d=new DatabaseSync(file,{readOnly:true});try{
 const rows=d.prepare('PRAGMA integrity_check').all();if(rows.length!==1||rows[0].integrity_check!=='ok'||d.prepare('PRAGMA foreign_key_check').all().length)throw Error('SQLite integrity failed');
 const counts={};for(const t of tables)if(d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t))counts[t]=d.prepare('SELECT count(*) AS n FROM "'+t+'"').get().n;return counts;
}finally{d.close()}}
(async()=>{const real=f=>fs.realpathSync(f).toLowerCase();
 if(real(source)===real(liveDb)||real(testUploads)===real(liveUploads))throw Error('TEST storage resolves to LIVE storage');
 if(mode==='backup'){const dest=path.join(root,'calendar.db');const d=new DatabaseSync(source,{readOnly:true});try{await backup(d,dest)}finally{d.close()}
  const check=dest+'.restore-check';fs.copyFileSync(dest,check,fs.constants.COPYFILE_EXCL);const counts=inspect(dest);inspect(check);
  const hash=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');if(hash(dest)!==hash(check))throw Error('Restore copy mismatch');
  fs.writeFileSync(path.join(root,'counts.json'),JSON.stringify(counts),{flag:'wx'});console.log('SQLITE_BACKUP_AND_ISOLATED_RESTORE=PASS');
 }else{const expected=JSON.parse(fs.readFileSync(path.join(root,'counts.json'),'utf8'));const actual=inspect(source);for(const [t,n]of Object.entries(expected))if(actual[t]!==n)throw Error('Existing data count changed: '+t);console.log('SQLITE_INTEGRITY_AND_EXISTING_COUNTS=PASS')}
})().catch(e=>{console.error(e.message);process.exitCode=1});
'@
    [IO.File]::WriteAllText("$backup\verify-db.cjs",$dbTool,[Text.UTF8Encoding]::new($false))
    & git -C $test fetch --quiet $stage $to
    Assert ($LASTEXITCODE -eq 0) 'Candidate object transfer failed.'
    $paused = $true
    Disable-ScheduledTask -TaskName $watchdog | Out-Null
    Assert ((Get-ScheduledTask -TaskName $watchdog).State -ne 'Running') 'Watchdog raced staging; aborting before TEST stop.'
    $touched = $true
    Disable-ScheduledTask -TaskName $taskName | Out-Null
    StopTest
    Assert ((Manifest "$test\dist") -ceq $oldManifest) 'TEST frontend changed before backup.'
    CopyVerified "$test\dist" "$backup\previous-dist"
    & $node --no-warnings "$backup\verify-db.cjs" backup "$test\Server\data\calendar.db" $backup "$live\Server\data\calendar.db" "$test\Server\uploads" "$live\Server\uploads"
    Assert ($LASTEXITCODE -eq 0) 'Stopped TEST database backup failed.'
    CopyVerified "$test\Server\uploads" "$backup\uploads"
    $newDist = Join-Path $test "dist-photo-candidate-$tag"
    CopyVerified "$stage\dist" $newDist
    foreach ($file in Get-ChildItem "$backup\previous-dist\assets" -File) {
        $dest = Join-Path "$newDist\assets" $file.Name
        if (-not (Test-Path -LiteralPath $dest)) { Copy-Item -LiteralPath $file.FullName -Destination $dest }
    }
    $candidateManifest = Manifest $newDist
    $oldDist = Join-Path $backup 'active-dist-before-cutover'
    $entry = @{from=$from;to=$to;backup=$backup;oldDist=$oldDist;newDist=$newDist;supervisor=$supervisor} | ConvertTo-Json
    $stream = [IO.File]::Open($journal,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try { $bytes=[Text.UTF8Encoding]::new($false).GetBytes($entry);$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true) }
    finally { $stream.Dispose() }
    $opened = $true
    $changed = $true
    SwitchTest $to
    Assert ((Hash "$test\Server\index.mjs") -eq $newIndex -and (Hash "$test\Server\family-auth.mjs") -eq $oldAuth) 'Installed backend hashes differ from staged source.'
    Move-Item "$test\dist" $oldDist
    $oldMoved = $true
    Move-Item $newDist "$test\dist"
    [IO.File]::WriteAllBytes($supervisor,[IO.File]::ReadAllBytes("$backup\candidate-supervisor.ps1"))
    Assert ((Hash $supervisor) -eq (Hash "$backup\candidate-supervisor.ps1")) 'Installed supervisor write mismatch.'
    Assert-SecureTestSourcePins $supervisor $test
    Report 'TEST_BACKEND_AND_STARTUP_PINS=PASS'
    StartTest
    & $node --no-warnings "$backup\verify-db.cjs" verify "$test\Server\data\calendar.db" $backup "$live\Server\data\calendar.db" "$test\Server\uploads" "$live\Server\uploads"
    Assert ($LASTEXITCODE -eq 0) 'Post-start database verification failed.'
    Assert ((Head $test) -eq $to -and (Manifest "$test\dist") -ceq $candidateManifest -and
        (LiveStamp) -ceq $liveBefore -and (Manifest "$live\dist") -ceq $liveFiles) 'Post-start source/frontend/LIVE verification failed.'
    Assert-SecureTestSourcePins $supervisor $test
    Assert (-not (Get-ScheduledTask -TaskName $auto).Settings.Enabled) 'TEST auto-updater state changed.'
    Enable-ScheduledTask -TaskName $watchdog | Out-Null
    Assert ((Get-ScheduledTask -TaskName $watchdog).Settings.Enabled) 'Watchdog restoration failed.'
    $paused = $false
    Remove-Item -LiteralPath $journal
    $opened = $false; $success = $true
    Report "TEST_PHOTO_DEPLOYMENT=PASS | SHA=$to"
    Report 'FOUR_ROUNDED_CORNERS=Installed | PHOTO_EDIT_AND_REMOVE=Installed'
    Report 'LIVE_UNCHANGED=PASS | WATCHDOG=Enabled | TEST_AUTO_DEPLOY=Disabled'
    Report "RECOVERY_FOLDER=$backup"
} catch {
    Report "TEST_PHOTO_DEPLOYMENT=FAIL | $($_.Exception.Message)"
    if ($touched) {
        try {
            $paused = $true
            Disable-ScheduledTask -TaskName $watchdog | Out-Null
            for ($i=0; $i -lt 10; $i++) {
                if ((Get-ScheduledTask -TaskName $watchdog).State -ne 'Running') { break }
                Start-Sleep -Seconds 1
            }
            Assert ((Get-ScheduledTask -TaskName $watchdog).State -ne 'Running') 'Watchdog did not become idle for recovery.'
            Disable-ScheduledTask -TaskName $taskName | Out-Null
            StopTest
            if ($changed) {
                SwitchTest $from
                [IO.File]::WriteAllBytes("$test\Server\index.mjs",[IO.File]::ReadAllBytes("$backup\previous-index.mjs"))
                [IO.File]::WriteAllBytes($supervisor,[IO.File]::ReadAllBytes("$backup\previous-supervisor.ps1"))
            }
            if ($oldMoved) {
                if (Test-Path "$test\dist") { Move-Item "$test\dist" "$backup\rejected-dist" }
                Move-Item $oldDist "$test\dist"
            }
            Assert ((Head $test) -eq $from -and (Hash "$test\Server\index.mjs") -eq $oldIndex -and
                (Hash $supervisor) -eq $supervisorHash -and (Manifest "$test\dist") -ceq $oldManifest) 'Rollback baseline verification failed.'
            StartTest
            Assert ((LiveStamp) -ceq $liveBefore) 'LIVE changed during recovery.'
            $rollbackOk = $true
            if ($opened) { Remove-Item -LiteralPath $journal; $opened=$false }
            Report 'TEST_ROLLBACK=PASS | DATABASE_AND_UPLOADS_PRESERVED'
        } catch { Report "TEST_ROLLBACK=FAIL | $($_.Exception.Message) | MANUAL_RECOVERY_REQUIRED" }
    }
    if ($null -ne $backup) { Report "RECOVERY_FOLDER=$backup" }
    throw
} finally {
    if ($paused -and (-not $touched -or $rollbackOk -or $success)) {
        try { Enable-ScheduledTask -TaskName $watchdog | Out-Null; Report 'WATCHDOG_RESTORED=PASS' }
        catch { Report 'WATCHDOG_RESTORED=FAIL' }
    } elseif ($paused) { Report 'WATCHDOG_LEFT_DISABLED=Manual recovery required' }
    $env:PATH = $priorPath
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
