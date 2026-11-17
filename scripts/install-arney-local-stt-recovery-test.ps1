param([switch]$Apply)
# Owner-approved TEST companion: registers ONE independent recovery task.
# No changes to existing STT, TEST, LIVE tasks or credentials. Preview by default.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$state='C:\ProgramData\FamilyCalendar\LocalSTT'
$configFile=Join-Path $state 'config.json'
$source=Join-Path $PSScriptRoot 'monitor-arney-local-stt-test.ps1'
$expectedScripts='C:\Users\bobby\Projects\family-calendar-test-security-stage\scripts'
if (-not [string]::Equals($PSScriptRoot,$expectedScripts,[StringComparison]::OrdinalIgnoreCase)) { throw 'RECOVERY_PREFLIGHT=FAIL: Run only from approved secure TEST checkout.' }
$dest=Join-Path $state 'monitor-arney-local-stt-test.ps1'
$recoveryName='Family Calendar Local STT Recovery'
$sttName='Family Calendar Local STT'
$testName='Family Calendar Secure TEST'

$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$principal=[Security.Principal.WindowsPrincipal]$identity
if ($identity.Name -eq 'NT AUTHORITY\SYSTEM' -or -not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'RECOVERY_PREFLIGHT=FAIL: Run in an Administrator PowerShell session under your Windows account.'
}
foreach ($p in @($configFile,$source)) {
    if (!(Test-Path -LiteralPath $p -PathType Leaf)) { throw 'RECOVERY_PREFLIGHT=FAIL: Required file missing.' }
}
$config=Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
if ($config.enabled -ne $true -or $config.serviceUrl -ne 'http://127.0.0.1:13981/transcribe' -or !($config.serviceToken -is [string]) -or $config.serviceToken.Length -lt 32) {
    throw 'RECOVERY_PREFLIGHT=FAIL: Local STT configuration is invalid.'
}
$stt=Get-ScheduledTask -TaskName $sttName -ErrorAction Stop
if (@($stt.Actions).Count -ne 1 -or $stt.Actions[0].Execute -notmatch '(?i)powershell\.exe$' -or $stt.Actions[0].Arguments -notlike '*C:\ProgramData\FamilyCalendar\LocalSTT\start-arney-local-stt.ps1*') {
    throw 'RECOVERY_PREFLIGHT=FAIL: Existing STT task action is unexpected.'
}
$test=Get-ScheduledTask -TaskName $testName -ErrorAction Stop
if ($test.State -ne 'Running') { throw 'RECOVERY_PREFLIGHT=FAIL: Secure TEST task is not running.' }
foreach($port in @(3001,13002)) {
    $listeners=@(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
    if ($listeners.Count -ne 1) { throw "RECOVERY_PREFLIGHT=FAIL: Expected one calendar listener on port $port." }
}
$head=@(& git -C 'C:\Users\bobby\Projects\family-calendar-test-security-stage' rev-parse HEAD)
if ($LASTEXITCODE -ne 0 -or $head.Count -ne 1 -or $head[0] -notmatch '^[a-f0-9]{40}$') {
    throw 'RECOVERY_PREFLIGHT=FAIL: TEST checkout unavailable.'
}
$existing=Get-ScheduledTask -TaskName $recoveryName -ErrorAction SilentlyContinue
if ($existing) { Write-Host 'LOCAL_STT_RECOVERY=ALREADY_INSTALLED | NO_CHANGE'; return }
if (Test-Path -LiteralPath $dest) { throw 'RECOVERY_PREFLIGHT=FAIL: Runtime monitor script already exists; refusing to overwrite.' }
Write-Host "LOCAL_STT_RECOVERY_PREFLIGHT=PASS | TEST_SHA=$($head[0]) | STT_STATE=$($stt.State)"
Write-Host 'RECOVERY_ACTION=Check localhost 13981 every 5 minutes; request existing STT task startup if stopped.'
Write-Host 'RECOVERY_SCOPE=STT_ONLY | TEST_AND_LIVE_UNCHANGED=True'
if (!$Apply) { Write-Host 'PREVIEW_ONLY=TRUE | Use -Apply only after reviewing preflight.'; return }
$createdFile=$false
$registered=$false
try {
    Copy-Item -LiteralPath $source -Destination $dest -ErrorAction Stop
    $createdFile=$true
    if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash) { throw 'Monitor file verification failed.' }
    $action=New-ScheduledTaskAction -Execute (Join-Path $PSHOME 'powershell.exe') -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$dest+'"') -WorkingDirectory $state
    $startup=New-ScheduledTaskTrigger -AtStartup
    $repeat=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
    $settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 1)
    $owner=New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    Register-ScheduledTask -TaskName $recoveryName -Action $action -Trigger @($startup,$repeat) -Settings $settings -Principal $owner -ErrorAction Stop | Out-Null
    $registered=$true
    $check=Get-ScheduledTask -TaskName $recoveryName -ErrorAction Stop
    if ($check.State -eq 'Disabled' -or @($check.Triggers).Count -ne 2 -or @($check.Actions).Count -ne 1) {
        throw 'Registered recovery task did not match the expected configuration.'
    }
    Start-ScheduledTask -TaskName $recoveryName -ErrorAction Stop
    Write-Host 'LOCAL_STT_RECOVERY_INSTALL=PASS'
    Write-Host 'RECOVERY_INTERVAL=5_MINUTES | MONITOR_START_REQUESTED=TRUE'
    Write-Host 'EXISTING_STT_TASK_UNCHANGED=TRUE | TEST_UNCHANGED=TRUE | LIVE_UNCHANGED=TRUE'
} catch {
    if ($registered) { Unregister-ScheduledTask -TaskName $recoveryName -Confirm:$false -ErrorAction SilentlyContinue }
    if ($createdFile) { Remove-Item -LiteralPath $dest -Force -ErrorAction SilentlyContinue }
    throw "LOCAL_STT_RECOVERY_INSTALL=FAIL: $($_.Exception.Message)"
}
