param([switch]$Apply)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$homePath = 'C:\Users\bobby'
$test = Join-Path $homePath 'Projects\family-calendar-test-security-stage'
$live = Join-Path $homePath 'Projects\family-calendar-live-auth-candidate'
$state = 'C:\ProgramData\FamilyCalendar\LocalSTT'
$taskName = 'Family Calendar Local STT'
$testTask = 'Family Calendar Secure TEST'
$autoTask = 'Family Calendar Secure TEST Auto Deploy'
$configFile = Join-Path $state 'config.json'
$serviceFile = Join-Path $state 'arney_local_stt_service.py'
$launcherFile = Join-Path $state 'start-arney-local-stt.ps1'
$venvPython = Join-Path $state 'venv\Scripts\python.exe'
$models = Join-Path $state 'models'
$sourceRoot = Split-Path $PSScriptRoot
$sourceService = Join-Path $sourceRoot 'stt\arney_local_stt_service.py'
$sourceLauncher = Join-Path $PSScriptRoot 'start-arney-local-stt.ps1'

function Head([string]$folder) {
    $value = @(& git -C $folder rev-parse HEAD)
    if ($LASTEXITCODE -ne 0 -or $value.Count -ne 1 -or $value[0] -notmatch '^[a-f0-9]{40}$') {
        throw "Invalid Git checkout: $folder"
    }
    return $value[0].Trim()
}
function Read-LocalConfig {
    $config = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
    if ($config.enabled -ne $true -or
        $config.serviceUrl -ne 'http://127.0.0.1:13981/transcribe' -or
        !($config.serviceToken -is [string]) -or $config.serviceToken.Length -lt 32) {
        throw 'Installed Local STT configuration is invalid.'
    }
    return $config
}
function Wait-LocalHealth([string]$expectedModel) {
    $config = Read-LocalConfig
    for ($i=0; $i -lt 240; $i++) {
        try {
            $health = Invoke-RestMethod -Uri 'http://127.0.0.1:13981/health' -Headers @{Authorization="Bearer $($config.serviceToken)"} -TimeoutSec 3
            if ($health.status -eq 'ok' -and $health.modelReady -eq $true -and
                (!$expectedModel -or $health.model -eq $expectedModel)) { return $health }
        } catch {}
        Start-Sleep -Seconds 2
    }
    throw 'Local STT did not become healthy with the expected model.'
}
function Stop-OnlyLocalStt {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort 13981 -ErrorAction SilentlyContinue)
    if ($listeners.Count -gt 1) { throw 'Multiple Local STT listeners found.' }
    if ($listeners.Count -eq 1) {
        if ($listeners[0].LocalAddress -ne '127.0.0.1') { throw 'Local STT is not loopback-only.' }
        $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($listeners[0].OwningProcess)" -ErrorAction Stop
        if ($null -eq $process -or
            -not [string]::Equals($process.ExecutablePath,$venvPython,[StringComparison]::OrdinalIgnoreCase) -or
            $process.CommandLine -notlike '*arney_local_stt_service.py*') {
            throw 'Refusing to terminate an unexpected Local STT process.'
        }
        Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
    }
    for ($i=0; $i -lt 20; $i++) {
        if (!(Get-NetTCPConnection -State Listen -LocalPort 13981 -ErrorAction SilentlyContinue)) { return }
        Start-Sleep -Milliseconds 400
    }
    throw 'Local STT listener did not stop.'
}
function Test-CalendarHealth {
    $connections = @(Get-NetTCPConnection -State Listen -LocalPort 13002 -ErrorAction Stop)
    if ($connections.Count -ne 1) { throw 'Expected exactly one TEST listener.' }
    $base = "http://$($connections[0].LocalAddress):13002"
    $health = Invoke-RestMethod -Uri "$base/api/health" -TimeoutSec 5
    $auth = Invoke-RestMethod -Uri "$base/api/auth/status" -TimeoutSec 5
    if ($health.status -ne 'ok' -or $auth.enabled -ne $true) {
        throw 'TEST calendar health or authentication failed.'
    }
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]$identity
if ($identity.Name -eq 'NT AUTHORITY\SYSTEM' -or
    -not [string]::Equals($env:USERPROFILE,$homePath,[StringComparison]::OrdinalIgnoreCase) -or
    -not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run as bobby in PowerShell as Administrator, not SYSTEM.'
}
foreach ($folder in @($test,$live)) {
    if (!(Test-Path -LiteralPath (Join-Path $folder '.git'))) { throw "Checkout missing: $folder" }
    if (@(& git -C $folder status --porcelain --untracked-files=no | Where-Object { $_ }).Count) {
        throw "Tracked changes found: $folder"
    }
}
foreach ($file in @($sourceService,$sourceLauncher,$serviceFile,$launcherFile,$venvPython,$configFile)) {
    if (!(Test-Path -LiteralPath $file)) { throw "Required Local STT file missing: $file" }
}
if ((Get-ScheduledTask -TaskName $autoTask -ErrorAction Stop).State -ne 'Disabled') {
    throw 'TEST auto-deploy must remain disabled.'
}
if ((Get-ScheduledTask -TaskName $testTask -ErrorAction Stop).State -ne 'Running') {
    throw 'Secure TEST must be running before the performance upgrade.'
}
if ((Get-ScheduledTask -TaskName $taskName -ErrorAction Stop).State -ne 'Running') {
    throw 'Local STT task must be running before the performance upgrade.'
}
if (!(Get-NetTCPConnection -State Listen -LocalPort 3001 -ErrorAction SilentlyContinue)) {
    throw 'LIVE listener is missing.'
}
$listeners = @(Get-NetTCPConnection -State Listen -LocalPort 13981 -ErrorAction Stop)
if ($listeners.Count -ne 1 -or $listeners[0].LocalAddress -ne '127.0.0.1') {
    throw 'Installed Local STT listener is not loopback-only.'
}
$null = Read-LocalConfig
$null = Wait-LocalHealth ''
Test-CalendarHealth
$testBefore = Head $test
$liveBefore = Head $live
Write-Host "LOCAL_STT_PERFORMANCE_PREFLIGHT=PASS | TEST=$testBefore | LIVE=$liveBefore"
if (!$Apply) {
    Write-Host 'READINESS CHECK PASSED. Run with -Apply only after reviewing this output.'
    return
}

$backup = Join-Path $state ('upgrade-backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$changed = $false
try {
    New-Item -ItemType Directory -Path $backup -ErrorAction Stop | Out-Null
    Copy-Item -LiteralPath $serviceFile -Destination (Join-Path $backup 'arney_local_stt_service.py') -ErrorAction Stop
    Copy-Item -LiteralPath $launcherFile -Destination (Join-Path $backup 'start-arney-local-stt.ps1') -ErrorAction Stop
    $env:HF_HOME = $models
    & $venvPython -c "from faster_whisper import WhisperModel; WhisperModel('base.en',device='cpu',compute_type='int8',cpu_threads=8,num_workers=1); print('LOCAL_STT_BASE_MODEL_READY')"
    if ($LASTEXITCODE -ne 0) { throw 'Faster Local STT model preparation failed.' }
    Stop-OnlyLocalStt
    $changed = $true
    Copy-Item -LiteralPath $sourceService -Destination $serviceFile -Force -ErrorAction Stop
    Copy-Item -LiteralPath $sourceLauncher -Destination $launcherFile -Force -ErrorAction Stop
    Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
    $health = Wait-LocalHealth 'base.en'
    Test-CalendarHealth
    if ((Head $test) -ne $testBefore -or (Head $live) -ne $liveBefore) {
        throw 'A calendar checkout changed during the Local STT performance upgrade.'
    }
    if ((Get-ScheduledTask -TaskName $autoTask).State -ne 'Disabled') {
        throw 'TEST auto-deploy changed unexpectedly.'
    }
    Write-Host 'ARNEY_LOCAL_STT_PERFORMANCE_UPGRADE=PASS'
    Write-Host "LOCAL_STT_MODEL=$($health.model)"
    Write-Host 'LOCAL_STT_CPU_THREADS=8'
    Write-Host 'LOCAL_STT_BINDING=127.0.0.1:13981'
    Write-Host 'TEST_HEALTH_AUTH=PASS'
    Write-Host 'LIVE_UNCHANGED=PASS'
    Write-Host 'TEST_AUTO_DEPLOY=DISABLED'
} catch {
    $failure = $_.Exception.Message
    $rollbackOk = $false
    try {
        Stop-OnlyLocalStt
        if ($changed) {
            Copy-Item -LiteralPath (Join-Path $backup 'arney_local_stt_service.py') -Destination $serviceFile -Force -ErrorAction Stop
            Copy-Item -LiteralPath (Join-Path $backup 'start-arney-local-stt.ps1') -Destination $launcherFile -Force -ErrorAction Stop
        }
        Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
        $null = Wait-LocalHealth ''
        Test-CalendarHealth
        $rollbackOk = $true
    } catch {
        Write-Warning ("Local STT rollback needs review: " + $_.Exception.Message)
    }
    throw "Local STT performance upgrade failed: $failure rollbackHealthy=$rollbackOk backup=$backup"
}
