# Opt-in Windows Scheduled Task for automatic PR previews.
# Default: credentials/readiness check only. -Install prompts for Windows account password.
# Runs separately from live, every 10 minutes, using bobby's existing SSH agent.

param([switch]$Install)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$homePath = 'C:\Users\bobby'
$test = Join-Path $homePath 'Projects\family-calendar-test'
$live = Join-Path $homePath 'Projects\family-calendar'
$source = Join-Path $test 'scripts\auto-preview.ps1'
$state = Join-Path $homePath 'AppData\Local\FamilyCalendar\auto-preview'
$installed = Join-Path $state 'auto-preview.ps1'
$taskName = 'Family Calendar Auto Preview'
$expectedRemote = 'git@github.com:BSwiss89/family-calendar.git'

$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$admin = ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin -or $id.Name -eq 'NT AUTHORITY\SYSTEM' -or
    -not [string]::Equals($env:USERPROFILE,$homePath,[StringComparison]::OrdinalIgnoreCase)) {
    throw 'Run from an elevated interactive laptop PowerShell session as bobby, not SYSTEM.'
}
foreach ($folder in @($test,$live)) {
    if (-not (Test-Path (Join-Path $folder '.git'))) { throw "Missing Git checkout: $folder" }
    $remote = (& git -C $folder remote get-url origin).Trim()
    if ($LASTEXITCODE -ne 0 -or $remote -ne $expectedRemote) { throw "Unexpected Git remote: $folder" }
    $dirty = @(& git -C $folder status --porcelain)
    if ($LASTEXITCODE -ne 0 -or $dirty.Count -ne 0) { throw "Uncommitted changes: $folder" }
}
if (-not (Test-Path $source)) { throw 'Pull the merged preview setup into the test checkout first.' }
if (-not (Test-Path (Join-Path $test 'scripts\preview-pr.ps1')) -or
    -not (Test-Path (Join-Path $test 'scripts\create-preview-db.mjs'))) {
    throw 'Isolated PR preview dependencies are missing.'
}
Write-Host 'CHECKING AUTOMATIC PREVIEW READINESS'
. (Join-Path $test 'scripts\get-github-refs.ps1')
$refs = @(Get-FamilyCalendarGitHubRefs -Repository $test -Type PullRequests)
Write-Host "PASS: GitHub PR reference query completed ($($refs.Count) refs)."
$tailscale = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
if (-not (Test-Path $tailscale)) { throw 'Tailscale executable is missing.' }
$ips = @(& $tailscale ip -4)
if ($LASTEXITCODE -ne 0 -or $ips.Count -ne 1) { throw 'Tailscale IPv4 is not currently available.' }
if (-not (Test-Path (Join-Path $test 'Server\data\calendar.db'))) {
    throw 'Separate test database is missing. Live data will not be used for the preview.'
}
Write-Host 'PASS: GitHub can be accessed using the working repository-local Git configuration.'
Write-Host "PASS: Tailscale preview address $($ips[0]):13002"
Write-Host 'PASS: Separate test database is present.'
if (-not $Install) {
    Write-Host 'AUTOMATIC PREVIEW READINESS PASSED. No scheduled tasks changed.'
    return
}
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    throw 'Automatic preview task already exists. Inspect it before reinstalling.'
}

New-Item -ItemType Directory -Path $state -Force | Out-Null
Copy-Item -LiteralPath $source -Destination $installed -ErrorAction Stop
$actionArgs = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $installed + '"'
$action = New-ScheduledTaskAction -Execute (Join-Path $PSHOME 'powershell.exe') -Argument $actionArgs -WorkingDirectory $live
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(3) -RepetitionInterval (New-TimeSpan -Minutes 10) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 25)
$principal = New-ScheduledTaskPrincipal -UserId $id.Name -LogonType Password -RunLevel Highest
$definition = New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Principal $principal

Write-Host 'Enter your laptop WINDOWS ACCOUNT PASSWORD (not PIN).'
Write-Host 'The password goes only to Windows Task Scheduler and is not written to GitHub.'
$securePassword = Read-Host 'Windows account password' -AsSecureString
if ($securePassword.Length -eq 0) { throw 'No password entered; no task installed.' }
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
try {
    $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    Register-ScheduledTask -TaskName $taskName -InputObject $definition -User $id.Name -Password $password -ErrorAction Stop | Out-Null
} finally {
    $password = $null
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}
Write-Host ''
Write-Host 'AUTOMATIC PREVIEW TASK INSTALLED'
Write-Host 'Checks for open, mergeable GitHub PRs every 10 minutes.'
Write-Host "Preview URL: http://$($ips[0]):13002"
Write-Host "Log: $(Join-Path $state 'auto-preview.log')"
Write-Host 'Your live calendar continues to use port 3001.'
