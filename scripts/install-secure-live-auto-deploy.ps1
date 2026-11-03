# One-time installer for the new Secure LIVE auto deployer.
# Default: audits only. -Install registers a DISABLED task; -Enable explicitly activates it.
# The legacy auto deploy and Secure TEST tasks are never changed.
param([switch]$Install,[switch]$Enable)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'

$root='C:\ProgramData\FamilyCalendar\SecureLiveAutoDeploy'
$taskName='Family Calendar Secure LIVE Auto Deploy'
$oldName='Family Calendar Auto Deploy'
$live='C:\Users\bobby\Projects\family-calendar-live-auth-candidate'
$test='C:\Users\bobby\Projects\family-calendar-test-security-stage'
$controller=Join-Path $root 'secure-live-auto-deploy.ps1'
$helper=Join-Path $root 'secure-live-online-backup.mjs'
$sourceController=Join-Path $PSScriptRoot 'secure-live-auto-deploy.ps1'
$sourceHelper=Join-Path $PSScriptRoot 'secure-live-online-backup.mjs'
$sourcePins=Join-Path $PSScriptRoot 'secure-live-launcher-pins.ps1'
$installedPins=Join-Path $root 'secure-live-launcher-pins.ps1'
$approvalUri='https://api.github.com/repos/BSwiss89/family-calendar/contents/ops/secure-live-approved.json?ref=secure-live-release-approvals'
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$principal=[Security.Principal.WindowsPrincipal]$identity
$admin=$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
function Assert([bool]$ok,[string]$why){if(-not $ok){throw $why}}

Assert (-not ($Install -and $Enable)) 'Install and Enable must run separately'
Assert (Test-Path -LiteralPath $sourceController) 'Source controller missing'
Assert (Test-Path -LiteralPath $sourceHelper) 'Source SQLite helper missing'
Assert (Test-Path -LiteralPath $sourcePins) 'Source launcher pin helper missing'
Assert (Test-Path -LiteralPath (Join-Path $live '.git')) 'Secure LIVE source not found'
Assert (Test-Path -LiteralPath (Join-Path $test '.git')) 'Secure TEST source not found'
$liveSha=(& git -C $live rev-parse HEAD).Trim()
Assert ($LASTEXITCODE -eq 0 -and $liveSha -match '^[a-f0-9]{40}$') 'Could not read secure LIVE commit'
$approvalResponse=Invoke-RestMethod -Uri $approvalUri -Headers @{'User-Agent'='FamilyCalendar-SecureLiveInstaller'} -TimeoutSec 25
Assert ($approvalResponse.type -eq 'file' -and $approvalResponse.encoding -eq 'base64') 'Approved release manifest could not be read'
$approvedJson=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(([string]$approvalResponse.content -replace '\s','')))
$release=$approvedJson | ConvertFrom-Json
Assert ($release.schema -eq 1 -and $release.kind -in @('frontend-only','deployed-baseline') -and $release.repository -eq 'BSwiss89/family-calendar') 'Release approval schema invalid'
if($release.kind -eq 'deployed-baseline'){
  . $sourcePins
  Assert-SecureLiveBaseline $release $liveSha
}else{
  Assert ($liveSha -eq $release.from_sha -or $liveSha -eq $release.to_sha) 'LIVE version does not match the approved release; inspect before installing'
}
$testSha=(& git -C $test rev-parse HEAD).Trim()
Assert ($LASTEXITCODE -eq 0 -and $testSha -match '^[a-f0-9]{40}$') 'TEST source commit could not be read'
$origin=(& git -C $live remote get-url origin).Trim()
Assert ($LASTEXITCODE -eq 0 -and $origin -match '^(?:git@github\.com:|https://github\.com/)BSwiss89/family-calendar(?:\.git)?$') 'Unexpected LIVE Git origin'
$oldTask=Get-ScheduledTask -TaskName $oldName -ErrorAction SilentlyContinue
Assert ($null -eq $oldTask -or $oldTask.State -eq 'Disabled') 'Legacy LIVE updater must remain disabled'
Assert ((Get-ScheduledTask -TaskName 'Family Calendar Server' -ErrorAction Stop).State -eq 'Running') 'Secure LIVE server not running'
Assert ((Invoke-RestMethod 'http://127.0.0.1:3001/api/health' -TimeoutSec 10).status -eq 'ok') 'LIVE health check failed'
Write-Host ('=== SECURE LIVE AUTO DEPLOY INSTALL AUDIT '+(Get-Date -Format o)+' ===')
Write-Host "LIVE_SHA=$liveSha"
Write-Host "TEST_SHA=$testSha"
Write-Host "LEGACY_LIVE_TASK=$($oldTask.State)"
Write-Host "ADMIN=$admin"
$existing=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Write-Host ("NEW_TASK="+$(if($null -eq $existing){'NOT INSTALLED'}else{$existing.State}))
if(-not $Install -and -not $Enable){
  Write-Host ('INSTALL READ-ONLY AUDIT PASS: '+(Get-Date -Format o))
  return
}
Assert ($admin -and $identity.Name -ne 'NT AUTHORITY\SYSTEM') 'Run in elevated PowerShell as the laptop administrator'
if($Install){
  Assert ($null -eq $existing) 'Secure LIVE auto deploy task already exists; never overwrite automatically'
  Assert (-not (Test-Path -LiteralPath $root)) 'Secure LIVE auto deploy folder already exists; inspect before installing'
  New-Item -ItemType Directory -Path $root -ErrorAction Stop | Out-Null
  Copy-Item -LiteralPath $sourceController -Destination $controller -ErrorAction Stop
  Copy-Item -LiteralPath $sourceHelper -Destination $helper -ErrorAction Stop
  Copy-Item -LiteralPath $sourcePins -Destination $installedPins -ErrorAction Stop
  & icacls.exe $root '/inheritance:r' '/grant:r' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Host
  Assert ($LASTEXITCODE -eq 0) 'Unable to restrict updater directory to SYSTEM and Administrators'
  $action=New-ScheduledTaskAction -Execute (Join-Path $PSHOME 'powershell.exe') -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$controller+'" -Apply') -WorkingDirectory $root
  $trigger=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration (New-TimeSpan -Days 3650)
  $settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 25)
  $definition=New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Principal (New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Password -RunLevel Highest)
  Write-Host 'Windows ACCOUNT password required for an unattended elevated task (not Windows Hello PIN).'
  $secure=Read-Host 'Enter Windows ACCOUNT password' -AsSecureString
  Assert ($secure.Length -gt 0) 'Missing account password'
  $ptr=[IntPtr]::Zero
  try {
    $ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    $password=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
    try {
      Register-ScheduledTask -TaskName $taskName -InputObject $definition -User $identity.Name -Password $password -ErrorAction Stop | Out-Null
    } finally { $password=$null }
  } finally { if($ptr -ne [IntPtr]::Zero){[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)} }
  Disable-ScheduledTask -TaskName $taskName -ErrorAction Stop | Out-Null
  Write-Host ('INSTALL PASS / TASK DISABLED: '+(Get-Date -Format o))
  Write-Host 'Controller and SQLite helper installed. No LIVE/TEST deployment performed.'
  return
}
Assert ($null -ne $existing -and $existing.State -eq 'Disabled') 'Expected an installed, disabled Secure LIVE deploy task'
Assert ((Get-FileHash -LiteralPath $controller -Algorithm SHA256).Hash -eq (Get-FileHash -LiteralPath $sourceController -Algorithm SHA256).Hash) 'Installed controller hash differs from reviewed source'
Assert ((Get-FileHash -LiteralPath $helper -Algorithm SHA256).Hash -eq (Get-FileHash -LiteralPath $sourceHelper -Algorithm SHA256).Hash) 'Installed backup helper differs from reviewed source'
Assert ((Get-FileHash -LiteralPath $installedPins).Hash -eq (Get-FileHash -LiteralPath $sourcePins).Hash) 'Installed pin helper differs from reviewed source'
Assert (-not (Test-Path -LiteralPath (Join-Path $root 'REQUIRES-REVIEW.txt'))) 'Secure LIVE auto-deploy hold exists'
Assert (-not (Test-Path -LiteralPath (Join-Path $root 'DEPLOYMENT-IN-PROGRESS.json'))) 'Secure LIVE auto-deploy transaction journal exists'
& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $controller
Assert ($LASTEXITCODE -eq 0) 'Secure LIVE read-only preflight failed'
Enable-ScheduledTask -TaskName $taskName -ErrorAction Stop | Out-Null
Write-Host ('SECURE LIVE AUTO DEPLOY ENABLED: '+(Get-Date -Format o))
Write-Host 'Approved releases only; never follows main or TEST.'
