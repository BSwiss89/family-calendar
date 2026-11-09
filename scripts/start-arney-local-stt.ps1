Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$state = 'C:\ProgramData\FamilyCalendar\LocalSTT'
$configFile = Join-Path $state 'config.json'
$python = Join-Path $state 'venv\Scripts\python.exe'
$service = Join-Path $state 'arney_local_stt_service.py'
foreach ($file in @($configFile,$python,$service)) {
    if (!(Test-Path -LiteralPath $file)) { throw "Local STT file missing: $file" }
}
$config = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
if ($config.enabled -ne $true -or $config.serviceUrl -ne 'http://127.0.0.1:13981/transcribe' -or
    !($config.serviceToken -is [string]) -or $config.serviceToken.Length -lt 32) {
    throw 'Local STT configuration is invalid.'
}
$listeners = @(Get-NetTCPConnection -State Listen -LocalPort 13981 -ErrorAction SilentlyContinue)
if ($listeners.Count -gt 0) { throw 'Local STT port is already occupied.' }
$env:FAMILY_CALENDAR_LOCAL_STT_TOKEN = $config.serviceToken
$env:FAMILY_CALENDAR_LOCAL_STT_PORT = '13981'
$env:FAMILY_CALENDAR_LOCAL_STT_MODEL = 'small.en'
$env:HF_HOME = Join-Path $state 'models'
& $python -u $service
if ($LASTEXITCODE -ne 0) { throw "Local STT service exited with code $LASTEXITCODE" }

