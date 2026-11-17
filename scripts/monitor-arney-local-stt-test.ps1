# TEST-only background recovery for an already installed, private local STT
# scheduled task. Never kills listeners, launches processes directly, changes
# calendar checkouts, logs tokens, or touches LIVE.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$folder='C:\ProgramData\FamilyCalendar\LocalSTT'
$configPath=Join-Path $folder 'config.json'
$taskName='Family Calendar Local STT'
if (!(Test-Path -LiteralPath $configPath)) { throw 'STT_MONITOR=CONFIG_MISSING' }
$config=Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
if ($config.enabled -ne $true -or
    $config.serviceUrl -ne 'http://127.0.0.1:13981/transcribe' -or
    !($config.serviceToken -is [string]) -or $config.serviceToken.Length -lt 32) {
    throw 'STT_MONITOR=INVALID_CONFIGURATION'
}
# This watcher should never make a stopped TEST/LIVE calendar available. It
# only maintains the independent localhost speech service when TEST is present.
$testListeners=@(Get-NetTCPConnection -State Listen -LocalPort 13002 -ErrorAction SilentlyContinue)
if ($testListeners.Count -ne 1) { Write-Host 'STT_MONITOR=SKIP_TEST_NOT_RUNNING'; return }
$listeners=@(Get-NetTCPConnection -State Listen -LocalPort 13981 -ErrorAction SilentlyContinue)
if ($listeners.Count -gt 1 -or ($listeners.Count -eq 1 -and
    $listeners[0].LocalAddress -ne '127.0.0.1')) {
    throw 'STT_MONITOR=UNEXPECTED_PORT_OWNER'
}
if ($listeners.Count -eq 1) { Write-Host 'STT_MONITOR=LISTENER_PRESENT'; return }
$task=Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
if ($task.State -eq 'Running') {
    # Base.en can still be loading. Do not forcibly restart a valid process.
    Write-Host 'STT_MONITOR=TASK_RUNNING_LOADING_OR_UNAVAILABLE'
    return
}
if ($task.State -ne 'Ready') { Write-Host "STT_MONITOR=TASK_$($task.State)_NO_ACTION"; return }
$expectedLauncher='C:\ProgramData\FamilyCalendar\LocalSTT\start-arney-local-stt.ps1'
$action=@($task.Actions)
if ($action.Count -ne 1 -or
    $action[0].Arguments -notlike ('*' + $expectedLauncher + '*') -or
    $action[0].Execute -notmatch '(?i)powershell\.exe$') {
    throw 'STT_MONITOR=UNEXPECTED_TASK_ACTION'
}
# Invoke the EXISTING task under its existing identity/credentials. Never
# transfer its token to this task or the browser.
Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
Write-Host 'STT_MONITOR=START_REQUESTED'
