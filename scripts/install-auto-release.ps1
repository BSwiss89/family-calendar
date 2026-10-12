# Set up Windows Task Scheduler to deploy GitHub main after it is merged.
# Default: readiness test only. -Install requires explicit action + Windows password.
# Runs under bobby (NOT SYSTEM) with Highest privileges, every 15 minutes.

param([switch]$Install)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$homePath = 'C:\Users\bobby'
$test = Join-Path $homePath 'Projects\family-calendar-test'
$live = Join-Path $homePath 'Projects\family-calendar'
$source = Join-Path $test 'scripts\auto-release.ps1'
$state = Join-Path $homePath 'AppData\Local\FamilyCalendar\auto-release'
$installed = Join-Path $state 'auto-release.ps1'
$taskName = 'Family Calendar Auto Deploy'
$ssh = 'ssh -i C:/Users/bobby/.ssh/id_ed25519_github -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=20'

$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$admin = ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin -or $id.Name -eq 'NT AUTHORITY\SYSTEM') {
    throw 'Open an elevated interactive PowerShell as the laptop user, not SYSTEM.'
}
if (-not [string]::Equals($env:USERPROFILE,$homePath,[StringComparison]::OrdinalIgnoreCase)) {
    throw 'Unexpected Windows profile; refusing to set up another account.'
}
if (-not (Test-Path $source)) { throw 'First update the test repo to the merged version with auto-release.ps1.' }
foreach ($folder in @($test,$live)) {
    if (-not (Test-Path (Join-Path $folder '.git'))) { throw "Missing Git checkout: $folder" }
    $remote = (& git -C $folder remote get-url origin).Trim()
    if ($LASTEXITCODE -ne 0 -or $remote -ne 'git@github.com:BSwiss89/family-calendar.git') {
        throw "Unexpected Git origin: $folder"
    }
    $dirty = @(& git -C $folder status --porcelain)
    if ($LASTEXITCODE -ne 0 -or $dirty.Count -ne 0) { throw "Dirty checkout: $folder" }
}
Write-Host 'CHECKING NONINTERACTIVE GITHUB ACCESS'
$oldSsh = [Environment]::GetEnvironmentVariable('GIT_SSH_COMMAND','Process')
try {
    $env:GIT_SSH_COMMAND = $ssh
    $head = @(& git -C $test ls-remote origin refs/heads/main)
    if ($LASTEXITCODE -ne 0 -or $head.Count -ne 1) {
        throw 'Unattended SSH failed. Configure Windows ssh-agent for the current GitHub key before installing.'
    }
} finally {
    [Environment]::SetEnvironmentVariable('GIT_SSH_COMMAND',$oldSsh,'Process')
}
Write-Host 'PASS: GitHub fetch can authenticate without prompting for an SSH passphrase.'
Write-Host 'PASS: Live and test folders exist and are clean.'
if (-not $Install) {
    Write-Host 'READINESS TEST PASSED. No background task installed or changed.'
    return
}
if (Test-Path (Join-Path $state 'REQUIRES-REVIEW.txt')) {
    throw 'Previous release is blocked. Review the hold file before installing.'
}
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($null -ne $existing) { throw 'An auto-deploy task already exists. Inspect before attempting reinstall.' }

New-Item -ItemType Directory -Path $state -Force | Out-Null
Copy-Item -LiteralPath $source -Destination $installed -ErrorAction Stop
$actionArgs = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $installed + '"'
$action = New-ScheduledTaskAction -Execute (Join-Path $PSHOME 'powershell.exe') -Argument $actionArgs -WorkingDirectory $live
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(3) -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 25)
$user = $id.Name
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Password -RunLevel Highest
$definition = New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Principal $principal

Write-Host 'Windows will ask for your ACCOUNT PASSWORD, not your Windows Hello PIN.'
Write-Host 'The password is passed to Windows Task Scheduler; it is not echoed or saved in a script or GitHub.'
$securePassword = Read-Host 'Enter laptop Windows ACCOUNT password (not PIN)' -AsSecureString
if ($securePassword.Length -eq 0) { throw 'No password entered; task not installed.' }
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
try {
    $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    Register-ScheduledTask -TaskName $taskName -InputObject $definition -User $user -Password $password -ErrorAction Stop | Out-Null
} finally {
    $password = $null
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}
Write-Host ''
Write-Host 'AUTO DEPLOY TASK INSTALLED'
Write-Host 'Runs every 15 minutes as the laptop user with elevated privileges.'
Write-Host 'Github PR merge is the deployment approval; no additional per-release PowerShell command.'
Write-Host "Log: $(Join-Path $state 'auto-release.log')"
Write-Host 'If an approved release fails, unattended retries are held until a manual review.'
