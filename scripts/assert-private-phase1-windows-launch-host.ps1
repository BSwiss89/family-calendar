# Read-only host gate, invoked before the persistent TEST supervisor opens SQLite.
# No task/route/file mutations; the separately approved cutover must install
# the existing TEST task action and keep the legacy updater disabled.
param(
 [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{40}$')][string]$ExpectedCandidateSha,
 [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{40}$')][string]$ExpectedInstalledTestSha,
 [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{40}$')][string]$ExpectedLiveSha,
 [ValidateSet('Launch','MaintenanceResume')][string]$Mode='Launch'
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
function Refuse { throw 'Phase 1 persistent TEST launch host refused.' }
$projects=Join-Path $env:USERPROFILE 'Projects'
$code=Join-Path $projects 'family-calendar-phase1-test-code'
$legacy=Join-Path $projects 'family-calendar-test-security-stage'
$live=Join-Path $projects 'family-calendar'
$data=Join-Path $projects 'family-calendar-phase1-test-data'
$node='C:\ProgramData\FamilyCalendar\Runtime\node-v24.22.1\node.exe'
$ps=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$launcher=Join-Path $code 'scripts\start-private-phase1-windows-test.ps1'
function Same([string]$a,[string]$b){return [string]::Equals($a,$b,[StringComparison]::OrdinalIgnoreCase)}
function Pin([string]$dir,[string]$sha){
 $item=Get-Item -LiteralPath $dir -Force
 if(-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){Refuse}
 $head=((& git -C $dir rev-parse HEAD 2>$null)|Out-String).Trim()
 if($LASTEXITCODE -ne 0 -or $head -cne $sha){Refuse}
}
if(-not (Same ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))) $code)){Refuse}
Pin $code $ExpectedCandidateSha
Pin $legacy $ExpectedInstalledTestSha
Pin $live $ExpectedLiveSha
$dirty=@(& git -C $code status --porcelain --untracked-files=no)
if($LASTEXITCODE -ne 0 -or $dirty.Count -ne 0){Refuse}
foreach($f in @($node,$launcher,(Join-Path $code 'dist\index.html'))){
 $item=Get-Item -LiteralPath $f -Force
 if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){Refuse}
}
$acl=@(& $ps -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'private-phase1-windows-stage-acl.ps1') -Mode Verify -Scope windows-inactive-stage -Directory $data)
if($LASTEXITCODE -ne 0 -or ($acl -join '') -cne 'PHASE1_WINDOWS_STAGE_ACL=PASS | PRIVATE_DACL=YES | TASKS_CHANGED=NO | DEPLOYMENT_AUTHORIZED=NO'){Refuse}
$test=Get-ScheduledTask -TaskName 'Family Calendar Secure TEST' -TaskPath '\'
$updater=Get-ScheduledTask -TaskName 'Family Calendar Secure TEST Auto Deploy' -TaskPath '\'
$lt=Get-ScheduledTask -TaskName 'Family Calendar Server' -TaskPath '\'
$expectedTaskState=if($Mode -ceq 'MaintenanceResume'){'Disabled'}else{'Running'}
if($test.State -cne $expectedTaskState -or $updater.State -cne 'Disabled' -or $lt.State -cne 'Running'){Refuse}
$actions=@($test.Actions)
$expectedArgs='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$launcher+'"'
if($actions.Count -ne 1 -or -not (Same ([string]$actions[0].Execute) $ps) -or
   [string]$actions[0].Arguments -cne $expectedArgs -or -not (Same ([string]$actions[0].WorkingDirectory) $code)){Refuse}
if([int]$test.Settings.RestartCount -ne 0 -or [string]$test.Settings.MultipleInstances -cne 'IgnoreNew'){Refuse}
foreach($name in @('Family Calendar Auto Deploy','Family Calendar Auto Preview','Family Calendar Secure LIVE Auto Deploy')){
 if((Get-ScheduledTask -TaskName $name -TaskPath '\').State -cne 'Disabled'){Refuse}
}
foreach($name in @('REQUIRES-REVIEW.txt','IN-PROGRESS.txt')){
 if(Test-Path -LiteralPath (Join-Path 'C:\ProgramData\FamilyCalendar\SecureTestAutoDeploy' $name)){Refuse}
}
$rows=@(Get-NetTCPConnection -State Listen | Where-Object {$_.LocalPort -in @(3001,13002,13003,13004)})
$l=@($rows|Where-Object {$_.LocalPort -eq 3001})
$p=@($rows|Where-Object {$_.LocalPort -eq 13003})
if($rows.Count -ne 2 -or $l.Count -ne 1 -or $p.Count -ne 1 -or
   $l[0].LocalAddress -cne '127.0.0.1' -or $p[0].LocalAddress -cne '127.0.0.1'){Refuse}
$lp=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$l[0].OwningProcess)
$pp=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$p[0].OwningProcess)
if($lp.Name -cne 'node.exe' -or [string]$lp.CommandLine -notlike ('*'+$live+'\Server\index.mjs*') -or
   $pp.Name -cne 'svchost.exe'){Refuse}
foreach($proc in @(Get-CimInstance Win32_Process | Where-Object {$_.Name -in @('node.exe','powershell.exe','pwsh.exe')})){
 if([string]::IsNullOrWhiteSpace([string]$proc.CommandLine)){Refuse}
 if([string]$proc.CommandLine -match '(?i)family-calendar-test-security-stage|start-secure-test-patched\.ps1|secure-test-auto-deploy\.ps1'){Refuse}
}
$dump=@(& netsh interface portproxy dump)
if($LASTEXITCODE -ne 0){Refuse}
$show=@(& netsh interface portproxy show all)
if($LASTEXITCODE -ne 0){Refuse}
$matched=0
$phases=if($Mode -ceq 'MaintenanceResume'){@('candidate-review')}else{@('legacy-fenced','candidate-review')}
foreach($phase in $phases){
 $inputJson=@{dump=($dump -join "`n");showAll=($show -join "`n");installedTestSha=$ExpectedInstalledTestSha;legacyTestAddress='100.124.58.19';phase=$phase}|ConvertTo-Json -Compress
 $out=@($inputJson | & $node (Join-Path $PSScriptRoot 'review-private-phase1-portproxy-all-families.mjs') 2>$null)
 if($LASTEXITCODE -eq 0){$matched++}
}
if($matched -ne 1){Refuse}
$repeat=@(& netsh interface portproxy show all)
if($LASTEXITCODE -ne 0 -or ($repeat -join "`n") -cne ($show -join "`n")){Refuse}
$health=Invoke-WebRequest -Uri 'http://127.0.0.1:3001/api/health' -UseBasicParsing -TimeoutSec 5
if($health.StatusCode -ne 200 -or (ConvertFrom-Json $health.Content).status -cne 'ok'){Refuse}
if($Mode -ceq 'MaintenanceResume'){Write-Output 'PHASE1_WINDOWS_RESUME_HOST=PASS | TEST_ONLY=YES'}else{Write-Output 'PHASE1_WINDOWS_LAUNCH_HOST=PASS | TEST_ONLY=YES'}
