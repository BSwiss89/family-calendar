param([switch]$Install)
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
$requirementsFile = Join-Path $state 'requirements.txt'
$launcherFile = Join-Path $state 'start-arney-local-stt.ps1'
$sourceRoot = Split-Path $PSScriptRoot
$sourceService = Join-Path $sourceRoot 'stt\arney_local_stt_service.py'
$sourceRequirements = Join-Path $sourceRoot 'stt\requirements.txt'
$sourceLauncher = Join-Path $PSScriptRoot 'start-arney-local-stt.ps1'

function Head([string]$folder) {
    $value = @(& git -C $folder rev-parse HEAD)
    if ($LASTEXITCODE -ne 0 -or $value.Count -ne 1 -or $value[0] -notmatch '^[a-f0-9]{40}$') {
        throw "Invalid Git checkout: $folder"
    }
    return $value[0].Trim()
}
function Wait-Http([string]$token) {
    for ($i=0; $i -lt 240; $i++) {
        try {
            $health = Invoke-RestMethod -Uri 'http://127.0.0.1:13981/health' -Headers @{Authorization="Bearer $token"} -TimeoutSec 3
            if ($health.status -eq 'ok' -and $health.modelReady -eq $true) { return }
        } catch {}
        Start-Sleep -Seconds 2
    }
    throw 'Local STT did not become healthy.'
}
function Wait-TestHealthy {
    for ($i=0; $i -lt 40; $i++) {
        try {
            $connection = @(Get-NetTCPConnection -State Listen -LocalPort 13002 -ErrorAction Stop)
            if ($connection.Count -eq 1) {
                $base = "http://$($connection[0].LocalAddress):13002"
                $health = Invoke-RestMethod -Uri "$base/api/health" -TimeoutSec 3
                $auth = Invoke-RestMethod -Uri "$base/api/auth/status" -TimeoutSec 3
                if ($health.status -eq 'ok' -and $auth.enabled -eq $true) { return }
            }
        } catch {}
        Start-Sleep -Seconds 2
    }
    throw 'TEST calendar did not become healthy after local STT installation.'
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
foreach ($source in @($sourceService,$sourceRequirements,$sourceLauncher)) {
    if (!(Test-Path -LiteralPath $source)) { throw "Installer source missing: $source" }
}
if ((Get-ScheduledTask -TaskName $autoTask -ErrorAction Stop).State -ne 'Disabled') {
    throw 'TEST auto-deploy must remain disabled.'
}
if ((Get-ScheduledTask -TaskName $testTask -ErrorAction Stop).State -ne 'Running') {
    throw 'Secure TEST must be running before installation.'
}
if (!(Get-NetTCPConnection -State Listen -LocalPort 3001 -ErrorAction SilentlyContinue)) {
    throw 'LIVE listener is missing.'
}
if (Get-NetTCPConnection -State Listen -LocalPort 13981 -ErrorAction SilentlyContinue) {
    throw 'Local STT port is already occupied.'
}
$existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existingTask -or (Test-Path -LiteralPath $state)) {
    throw 'Existing Local STT installation found. Review it instead of overwriting.'
}
$pythonCommand = Get-Command py.exe -ErrorAction SilentlyContinue
$pythonArgs = @('-3')
if (!$pythonCommand) {
    $pythonCommand = Get-Command python.exe -ErrorAction SilentlyContinue
    $pythonArgs = @()
}
if (!$pythonCommand) { throw 'Python 3 is required for the local STT pilot.' }
& $pythonCommand.Source @pythonArgs -c "import sys; assert sys.version_info >= (3,9); print(sys.version)"
if ($LASTEXITCODE -ne 0) { throw 'Python 3.9 or newer is required.' }
$liveBefore = Head $live
$testBefore = Head $test
Write-Host "LOCAL_STT_PREFLIGHT=PASS | TEST=$testBefore | LIVE=$liveBefore"
if (!$Install) {
    Write-Host 'READINESS CHECK PASSED. Run with -Install only after reviewing this output.'
    return
}

$registered = $false
$testStopped = $false
try {
    New-Item -ItemType Directory -Path $state -ErrorAction Stop | Out-Null
    Copy-Item -LiteralPath $sourceService -Destination $serviceFile -ErrorAction Stop
    Copy-Item -LiteralPath $sourceRequirements -Destination $requirementsFile -ErrorAction Stop
    Copy-Item -LiteralPath $sourceLauncher -Destination $launcherFile -ErrorAction Stop
    & $pythonCommand.Source @pythonArgs -m venv (Join-Path $state 'venv')
    if ($LASTEXITCODE -ne 0) { throw 'Python virtual environment creation failed.' }
    $venvPython = Join-Path $state 'venv\Scripts\python.exe'
    & $venvPython -m pip install --disable-pip-version-check --no-input --no-cache-dir --only-binary=:all: -r $requirementsFile
    if ($LASTEXITCODE -ne 0) { throw 'Pinned local STT package installation failed.' }
    New-Item -ItemType Directory -Path (Join-Path $state 'models') -Force | Out-Null
    $bytes = New-Object byte[] 48
    # Windows PowerShell 5.1 runs on .NET Framework, which does not provide
    # the newer static RandomNumberGenerator.Fill API. Create/GetBytes is
    # cryptographically secure and works on both Windows PowerShell and pwsh.
    $random = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $random.GetBytes($bytes) }
    finally { $random.Dispose() }
    $token = [Convert]::ToBase64String($bytes)
    @{enabled=$true;serviceUrl='http://127.0.0.1:13981/transcribe';serviceToken=$token} |
        ConvertTo-Json -Compress | Set-Content -LiteralPath $configFile -Encoding UTF8
    & icacls.exe $state /inheritance:r /grant:r "$($identity.Name):(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Local STT directory ACL failed.' }
    $env:HF_HOME = Join-Path $state 'models'
    & $venvPython -c "from faster_whisper import WhisperModel; WhisperModel('small.en',device='cpu',compute_type='int8'); print('LOCAL_STT_MODEL_READY')"
    if ($LASTEXITCODE -ne 0) { throw 'Local STT model preparation failed.' }
    $action = New-ScheduledTaskAction -Execute (Join-Path $PSHOME 'powershell.exe') -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $launcherFile + '"') -WorkingDirectory $state
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    $taskPrincipal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Password -RunLevel Highest
    $definition = New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Principal $taskPrincipal
    Write-Host 'Windows needs your account password, not your Windows Hello PIN.'
    $secure = Read-Host 'Windows account password' -AsSecureString
    if ($secure.Length -eq 0) { throw 'Empty password.' }
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
        Register-ScheduledTask -TaskName $taskName -InputObject $definition -User $identity.Name -Password $plain -ErrorAction Stop | Out-Null
        $registered = $true
    } finally {
        $plain = $null
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
    Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
    Wait-Http $token
    Stop-ScheduledTask -TaskName $testTask -ErrorAction SilentlyContinue
    $testStopped = $true
    for ($i=0; $i -lt 30; $i++) {
        if (!(Get-NetTCPConnection -State Listen -LocalPort 13002 -ErrorAction SilentlyContinue)) { break }
        Start-Sleep -Milliseconds 500
    }
    if (Get-NetTCPConnection -State Listen -LocalPort 13002 -ErrorAction SilentlyContinue) {
        throw 'TEST listener did not stop for configuration reload.'
    }
    Start-ScheduledTask -TaskName $testTask -ErrorAction Stop
    $testStopped = $false
    Wait-TestHealthy
    if ((Head $test) -ne $testBefore -or (Head $live) -ne $liveBefore) {
        throw 'A calendar checkout changed during Local STT installation.'
    }
    if ((Get-ScheduledTask -TaskName $autoTask).State -ne 'Disabled') {
        throw 'TEST auto-deploy changed unexpectedly.'
    }
    Write-Host 'ARNEY_LOCAL_STT_INSTALL=PASS'
    Write-Host 'LOCAL_STT_BINDING=127.0.0.1:13981'
    Write-Host 'TEST_RESTART_HEALTH=PASS'
    Write-Host 'LIVE_UNCHANGED=PASS'
    Write-Host 'TEST_AUTO_DEPLOY=DISABLED'
} catch {
    $failure = $_.Exception.Message
    if ($registered) {
        try { Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue } catch {}
        try { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop } catch {}
    }
    if (Test-Path -LiteralPath $state) { Remove-Item -LiteralPath $state -Recurse -Force -ErrorAction SilentlyContinue }
    try {
        Stop-ScheduledTask -TaskName $testTask -ErrorAction SilentlyContinue
        for ($i=0; $i -lt 30; $i++) {
            if (!(Get-NetTCPConnection -State Listen -LocalPort 13002 -ErrorAction SilentlyContinue)) { break }
            Start-Sleep -Milliseconds 500
        }
        Start-ScheduledTask -TaskName $testTask -ErrorAction Stop
        Wait-TestHealthy
    } catch {}
    throw "Local STT installation failed and was rolled back: $failure"
}

