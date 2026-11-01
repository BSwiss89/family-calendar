# Secure LIVE frontend-only auto deploy. Runs ONLY a commit named in the separate
# secure-live-release-approvals branch and proven by two GitHub Actions runs.
# Default: read-only preflight. -Apply is reserved for the separately approved task.
# Never uses GitHub main, modifies TEST, or restarts the production server.
param([switch]$Apply)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repo='BSwiss89/family-calendar'
$live='C:\Users\bobby\Projects\family-calendar-live-auth-candidate'
$test='C:\Users\bobby\Projects\family-calendar-test-security-stage'
$root='C:\ProgramData\FamilyCalendar\SecureLiveAutoDeploy'
$approvalUrl='https://api.github.com/repos/BSwiss89/family-calendar/contents/ops/secure-live-approved.json?ref=secure-live-release-approvals'
$legacyTask='Family Calendar Auto Deploy'
$liveTask='Family Calendar Server'
$task='Family Calendar Secure LIVE Auto Deploy'
$mutex=[Threading.Mutex]::new($false,'Global\FamilyCalendarSecureLiveAutoDeploy')
$locked=$false
$transcribing=$false
$gitChanged=$false
$oldMoved=$false
$newActivated=$false
$transactionOpened=$false
$backup=$null
$oldDist=$null
$newDist=$null
$from=$null
$to=$null
$liveDist=Join-Path $live 'dist'
$journal=Join-Path $root 'DEPLOYMENT-IN-PROGRESS.json'
$hold=Join-Path $root 'REQUIRES-REVIEW.txt'
$log=Join-Path $root 'secure-live-auto-deploy.log'

function Assert([bool]$condition,[string]$message) {
  if(-not $condition){throw $message}
}
function GitSha([string]$folder) {
  $value=(& git -C $folder rev-parse HEAD)
  Assert ($LASTEXITCODE -eq 0) "Cannot read Git SHA in $folder"
  return ([string]$value).Trim()
}
function RequireHealthy {
  $health=Invoke-RestMethod 'http://127.0.0.1:3001/api/health' -TimeoutSec 10
  $auth=Invoke-RestMethod 'http://127.0.0.1:3001/api/auth/status' -TimeoutSec 10
  Assert ($health.status -eq 'ok' -and $auth.enabled -eq $true) 'Secure LIVE health/authentication gate failed'
}
function CheckRun([long]$runId,[string]$name,[string]$sha) {
  Assert ($runId -gt 0) "$name run ID missing"
  $url="https://api.github.com/repos/$repo/actions/runs/$runId"
  $response=Invoke-RestMethod -Uri $url -Headers @{ 'User-Agent'='FamilyCalendar-SecureLiveRelease' } -TimeoutSec 25
  Assert ($response.head_sha -eq $sha -and $response.status -eq 'completed' -and $response.conclusion -eq 'success' -and $response.name -eq $name) "CI check failed: $name ($runId)"
}
function GetApproval {
  $result=Invoke-RestMethod -Uri $approvalUrl -Headers @{ 'User-Agent'='FamilyCalendar-SecureLiveRelease'; 'Cache-Control'='no-cache' } -TimeoutSec 25
  Assert ($result.type -eq 'file' -and $result.encoding -eq 'base64' -and $result.content) 'Approval document is unavailable'
  $bytes=[Convert]::FromBase64String(([string]$result.content -replace '\s',''))
  return ([Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json)
}
function CheckLocal {
  Assert (Test-Path -LiteralPath (Join-Path $live '.git')) 'Secure LIVE Git directory missing'
  Assert (Test-Path -LiteralPath (Join-Path $test '.git')) 'Secure TEST Git directory missing'
  Assert (Test-Path -LiteralPath $liveDist -PathType Container) 'Secure LIVE frontend missing'
  Assert (Test-Path -LiteralPath (Join-Path $live 'Server\data\calendar.db')) 'LIVE database missing'
  Assert (Test-Path -LiteralPath (Join-Path $live 'Server\uploads') -PathType Container) 'LIVE uploads missing'
  Assert (Test-Path -LiteralPath (Join-Path $root 'secure-live-online-backup.mjs')) 'Online backup helper missing'
  $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
  Assert ($identity.Name -ne 'NT AUTHORITY\SYSTEM') 'Secure LIVE updater must never run as SYSTEM'
  $principal=[Security.Principal.WindowsPrincipal]$identity
  Assert ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) 'Run elevated as the authorized account'
  Assert ((Get-ScheduledTask -TaskName $liveTask -ErrorAction Stop).State -eq 'Running') 'Secure LIVE server task is not running'
  $legacy=Get-ScheduledTask -TaskName $legacyTask -ErrorAction SilentlyContinue
  Assert ($null -eq $legacy -or $legacy.State -eq 'Disabled') 'Legacy automatic LIVE deployment must remain disabled'
  $origin=(& git -C $live remote get-url origin)
  Assert ($LASTEXITCODE -eq 0 -and [string]$origin -match '^(?:git@github\.com:|https://github\.com/)BSwiss89/family-calendar(?:\.git)?$') 'Untrusted LIVE Git origin'
  $status=@(& git -C $live status --porcelain --untracked-files=no)
  Assert ($LASTEXITCODE -eq 0 -and $status.Count -eq 0) 'LIVE tracked files are dirty'
  Assert (([string](& git -C $live branch --show-current)).Trim() -eq '') 'Secure LIVE must stay detached'
  RequireHealthy
}

try {
  try{$locked=$mutex.WaitOne(0)}catch [Threading.AbandonedMutexException]{$locked=$true}
  if(-not $locked){Write-Host 'SECURE LIVE AUTO DEPLOY SKIP: another instance holds the lock';return}
  if(-not $Apply) {
    CheckLocal
    Write-Host ("SECURE LIVE READ-ONLY PREFLIGHT PASS: "+(Get-Date -Format o))
    Write-Host ("LIVE_SHA="+(GitSha $live))
    Write-Host ("TEST_SHA="+(GitSha $test))
    return
  }
  Assert (Test-Path -LiteralPath $root -PathType Container) 'Secure LIVE updater is not installed'
  if(Test-Path -LiteralPath $hold){Write-Host 'AUTO DEPLOY HELD: read REQUIRES-REVIEW.txt';return}
  if(Test-Path -LiteralPath $journal){Write-Host 'AUTO DEPLOY HELD: incomplete release journal; manual recovery required';return}
  Start-Transcript -LiteralPath $log -Append -ErrorAction Stop | Out-Null
  $transcribing=$true
  CheckLocal
  $approval=GetApproval
  Assert ($approval.schema -eq 1 -and $approval.kind -eq 'frontend-only' -and $approval.repository -eq $repo) 'Unsupported release approval'
  $from=[string]$approval.from_sha
  $to=[string]$approval.to_sha
  Assert ($from -cmatch '^[a-f0-9]{40}$' -and $to -cmatch '^[a-f0-9]{40}$' -and $from -ne $to) 'Invalid approved commit pair'
  $files=@($approval.files | ForEach-Object { [string]$_ } | Sort-Object)
  Assert ($files.Count -gt 0 -and $files.Count -eq @($files | Select-Object -Unique).Count) 'Approval files missing or duplicated'
  foreach($file in $files){
    Assert ($file -cmatch '^(src/[^\\]+|public/[^\\]+|index\.html$)' -and $file -notmatch '\.\.') "Forbidden release file: $file"
  }
  $current=GitSha $live
  if($current -eq $to){Write-Host ("ALREADY APPROVED AND DEPLOYED: "+$to);return}
  Assert ($current -eq $from) "LIVE diverged from approved release; current $current expected $from"
  CheckRun ([long]$approval.build_run_id) 'Build Family Calendar' $to
  CheckRun ([long]$approval.safety_run_id) 'Deployment safety' $to
  $testBefore=GitSha $test
  $timestamp=Get-Date -Format 'yyyyMMdd-HHmmss'
  $stage=Join-Path $root ("stage-"+$timestamp+"-"+$to.Substring(0,8))
  Assert (-not (Test-Path -LiteralPath $stage)) 'Stage already exists'
  $origin=(& git -C $live remote get-url origin).Trim()
  & git clone --quiet --no-checkout --single-branch --branch feature/auth-current-calendar-two-sites $origin $stage
  Assert ($LASTEXITCODE -eq 0) 'Candidate clone failed'
  & git -C $stage checkout --quiet --detach $to
  Assert ($LASTEXITCODE -eq 0 -and (GitSha $stage) -eq $to) 'Approved commit not found in source branch'
  & git -C $stage merge-base --is-ancestor $from $to
  Assert ($LASTEXITCODE -eq 0) 'Approved release is not descended from LIVE'
  $actual=@(& git -C $stage diff --name-only $from $to | Sort-Object)
  Assert ($LASTEXITCODE -eq 0 -and ($files -join '|') -ceq ($actual -join '|')) "Changed file scope mismatch: $($actual -join ', ')"
  Push-Location $stage
  try {
    & npm.cmd ci --no-audit --no-fund
    Assert ($LASTEXITCODE -eq 0) 'npm ci failed in isolated staging'
    & npm.cmd run build
    Assert ($LASTEXITCODE -eq 0) 'Candidate production build failed'
  } finally {Pop-Location}
  Assert (Test-Path -LiteralPath (Join-Path $stage 'dist\index.html')) 'Candidate dist missing'
  RequireHealthy
  Assert ((GitSha $live) -eq $from -and (GitSha $test) -eq $testBefore) 'LIVE/TEST changed during staging'
  $backup=Join-Path $root ("backup-"+$timestamp+"-"+$from.Substring(0,8))
  Assert (-not (Test-Path $backup)) 'Backup location already exists'
  New-Item -ItemType Directory -Path $backup -ErrorAction Stop | Out-Null
  Copy-Item -LiteralPath $liveDist -Destination (Join-Path $backup 'previous-dist') -Recurse -Force -ErrorAction Stop
  Copy-Item -LiteralPath (Join-Path $live 'Server\uploads') -Destination (Join-Path $backup 'uploads') -Recurse -Force -ErrorAction Stop
  & node (Join-Path $root 'secure-live-online-backup.mjs') (Join-Path $live 'Server\data\calendar.db') (Join-Path $backup 'calendar.db')
  Assert ($LASTEXITCODE -eq 0) 'Online SQLite backup or integrity check failed'
  Assert (Test-Path (Join-Path $backup 'previous-dist\index.html')) 'Frontend backup incomplete'
  Assert (Test-Path (Join-Path $backup 'uploads')) 'Uploads backup incomplete'
  $newDist=Join-Path $live ("dist-secure-release-"+$to.Substring(0,8))
  $oldDist=Join-Path $backup 'active-dist-before-cutover'
  Assert (-not (Test-Path $newDist) -and -not (Test-Path $oldDist)) 'Staged/previous path collision'
  Copy-Item -LiteralPath (Join-Path $stage 'dist') -Destination $newDist -Recurse -Force
  $indexHash=(Get-FileHash -LiteralPath (Join-Path $newDist 'index.html') -Algorithm SHA256).Hash
  # Record the exact operation before touching LIVE's Git checkout or dist.
  @{from=$from;to=$to;backup=$backup;stage=$stage;test=$testBefore;started=(Get-Date -Format o)} |
    ConvertTo-Json -Compress | Set-Content -LiteralPath $journal -Encoding UTF8
  $transactionOpened=$true
  & git -C $live fetch --quiet $stage $to
  Assert ($LASTEXITCODE -eq 0) 'Approved candidate fetch into LIVE failed'
  & git -C $live checkout --quiet --detach $to
  Assert ($LASTEXITCODE -eq 0 -and (GitSha $live) -eq $to) 'LIVE source checkout failed'
  $gitChanged=$true
  Move-Item -LiteralPath $liveDist -Destination $oldDist -ErrorAction Stop
  $oldMoved=$true
  Move-Item -LiteralPath $newDist -Destination $liveDist -ErrorAction Stop
  $newActivated=$true
  Assert ((Get-FileHash -LiteralPath (Join-Path $liveDist 'index.html') -Algorithm SHA256).Hash -eq $indexHash) 'Live frontend hash does not match candidate'
  RequireHealthy
  $login=Invoke-WebRequest 'http://127.0.0.1:3001/login' -UseBasicParsing -TimeoutSec 10
  Assert ($login.StatusCode -eq 200) 'LIVE login route failed'
  Assert ((GitSha $live) -eq $to -and (GitSha $test) -eq $testBefore) 'Post-deployment LIVE/TEST SHA verification failed'
  Remove-Item -LiteralPath $journal -Force -ErrorAction Stop
  Write-Host ("SECURE LIVE AUTO DEPLOY PASS: "+(Get-Date -Format o))
  Write-Host "LIVE_SHA=$to"
  Write-Host "RECOVERY_BACKUP=$backup"
} catch {
  $failure=$_.Exception.Message
  $recovery=@()
  if($transactionOpened){
    if($oldMoved){
      try {
        if(Test-Path -LiteralPath $liveDist){
          Move-Item -LiteralPath $liveDist -Destination (Join-Path $backup 'rejected-dist') -ErrorAction Stop
        }
        Move-Item -LiteralPath $oldDist -Destination $liveDist -ErrorAction Stop
      } catch { $recovery+=("Frontend recovery: "+$_.Exception.Message) }
    }
    if($gitChanged){
      try {
        & git -C $live checkout --quiet --detach $from
        if($LASTEXITCODE -ne 0 -or (GitSha $live) -ne $from){throw 'Git rollback did not restore the previous commit'}
      } catch { $recovery+=("Git recovery: "+$_.Exception.Message) }
    }
  }
  if(Test-Path -LiteralPath $root){
    try {
      $message="SECURE LIVE AUTO DEPLOY FAILURE $(Get-Date -Format o) - $failure"
      if($recovery.Count -gt 0){$message+="; RECOVERY INCOMPLETE: "+($recovery -join '; ')}
      $message+="; review backups and journal before manually clearing hold."
      Set-Content -LiteralPath $hold -Value $message -Encoding UTF8
    } catch {}
  }
  Write-Warning ("SECURE LIVE AUTO DEPLOY FAIL: "+(Get-Date -Format o)+" "+$failure)
  if($recovery.Count -gt 0){throw ($failure+"; RECOVERY INCOMPLETE: "+($recovery -join '; '))}
  throw
} finally {
  if($transcribing){Stop-Transcript | Out-Null}
  if($locked){$mutex.ReleaseMutex()}
  $mutex.Dispose()
}
