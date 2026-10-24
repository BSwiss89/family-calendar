# One-time opt-in installer for a dedicated CI-gated TEST updater.
# No live task, service, Tailscale route or database is changed by installation.
param([switch]$Install)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$homePath = 'C:\Users\bobby'
$test = Join-Path $homePath 'Projects\family-calendar-test-security-stage'
$live = Join-Path $homePath 'Projects\family-calendar-live-auth-candidate'
$runtime = 'C:\ProgramData\FamilyCalendar\Runtime\node-v24.22.1\node.exe'
$taskName = 'Family Calendar Secure TEST Auto Deploy'
$secureTestTask = 'Family Calendar Secure TEST'
$state = 'C:\ProgramData\FamilyCalendar\SecureTestAutoDeploy'
$destination = Join-Path $state 'auto-test-deploy.ps1'
$source = Join-Path $PSScriptRoot 'secure-test-auto-deploy.ps1'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$admin = ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (!$admin -or $identity.Name -eq 'NT AUTHORITY\SYSTEM' -or
    -not [string]::Equals($env:USERPROFILE,$homePath,[StringComparison]::OrdinalIgnoreCase)) {
    throw 'Run this installer as bobby in an elevated PowerShell (Run as Administrator), not SYSTEM.'
}
if (!(Test-Path $source) -or !(Test-Path $runtime)) { throw 'Expected runner or pinned Node binary missing.' }
if (!(Test-Path (Join-Path $test '.git')) -or !(Test-Path (Join-Path $live '.git'))) {
    throw 'Secure TEST or LIVE checkout missing.'
}
if (@(& git -C $test status --porcelain --untracked-files=no | Where-Object { $_ }).Count -gt 0) {
    throw 'Secure TEST contains unexpected tracked edits.'
}
if (@(& git -C $live status --porcelain --untracked-files=no | Where-Object { $_ }).Count -gt 0) {
    throw 'LIVE contains unexpected tracked edits.'
}
foreach ($entry in @(
    @{Name='data';Target=(Join-Path $homePath 'Projects\family-calendar-preview\Server\data')},
    @{Name='uploads';Target=(Join-Path $homePath 'Projects\family-calendar-preview\Server\uploads')}
)) {
    $item = Get-Item -LiteralPath (Join-Path $test "Server\$($entry.Name)") -Force
    if ($item.LinkType -ne 'Junction' -or
        -not [string]::Equals([string](@($item.Target)[0]),$entry.Target,[StringComparison]::OrdinalIgnoreCase)) {
        throw "Unexpected TEST $($entry.Name) mapping."
    }
}
$testTask = Get-ScheduledTask -TaskName $secureTestTask -ErrorAction Stop
if ($testTask.State -ne 'Running' -or @($testTask.Actions | Where-Object {
    $_.Arguments -like '*start-secure-test-patched.ps1*'
}).Count -ne 1) {
    throw 'Secure TEST startup task is not the expected running launcher.'
}
foreach ($name in @('Family Calendar Auto Preview','Family Calendar Auto Deploy')) {
    $oldTask = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if ($oldTask -and $oldTask.State -ne 'Disabled') {
        throw "Old deployment task $name is active. Do not run overlapping updaters."
    }
}
foreach ($port in @(3001,13002,13003)) {
    if (!(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)) {
        throw "Expected Calendar port $port is missing."
    }
}
$connections = @(Get-NetTCPConnection -State Listen -LocalPort 13002 -ErrorAction SilentlyContinue)
if ($connections.Count -ne 1 -or $connections[0].LocalAddress -notmatch '^100\.') {
    throw 'TEST listener is not bound to one Tailscale address.'
}
$p = Get-CimInstance Win32_Process -Filter "ProcessId = $($connections[0].OwningProcess)"
if ($null -eq $p -or -not [string]::Equals($p.ExecutablePath,$runtime,[StringComparison]::OrdinalIgnoreCase) -or
    $p.CommandLine -notlike '*family-calendar-test-security-stage*') {
    throw 'TEST Node process identity unexpected.'
}
$base = "http://$($connections[0].LocalAddress):13002"
$h = Invoke-RestMethod "$base/api/health" -TimeoutSec 5
$a = Invoke-RestMethod "$base/api/auth/status" -TimeoutSec 5
if ($h.status -ne 'ok' -or $a.enabled -ne $true) { throw 'Secure TEST health/auth not ready.' }
try {
    $null = Invoke-WebRequest -Uri "$base/api/events" -TimeoutSec 5 -UseBasicParsing
    throw 'Anonymous event access is not blocked.'
} catch {
    if (!$_.Exception.Response -or [int]$_.Exception.Response.StatusCode -ne 401) { throw }
}
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) { throw "Task already exists: $taskName. Review before changing it." }
if (Test-Path $destination) { throw 'An existing installed updater was found. No overwrite attempted.' }
Write-Host 'PASS: Secure TEST, LIVE, original data junctions, authentication, and retired auto tasks verified.'
Write-Host 'Automatic releases will use only the test-release branch after its GitHub Actions push build passes.'
Write-Host 'Updates create TEST data/upload/build backups, verify the candidate, and hold after failures.'
if (!$Install) {
    Write-Host 'READINESS CHECK PASSED. Run with -Install to create the new scheduled task.'
    return
}
New-Item -ItemType Directory -Path $state -Force | Out-Null
Copy-Item -LiteralPath $source -Destination $destination -ErrorAction Stop
$exe = Join-Path $PSHOME 'powershell.exe'
$arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $destination + '"'
$action = New-ScheduledTaskAction -Execute $exe -Argument $arguments -WorkingDirectory $state
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(3) -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 45)
$principal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Password -RunLevel Highest
$definition = New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Principal $principal
Write-Host 'Windows needs your account PASSWORD, not your Windows Hello PIN, so this can run unattended.'
$secure = Read-Host 'Windows account password' -AsSecureString
if ($secure.Length -eq 0) { throw 'Empty password. Nothing registered.' }
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    Register-ScheduledTask -TaskName $taskName -InputObject $definition -User $identity.Name -Password $plain -ErrorAction Stop | Out-Null
} finally {
    $plain = $null
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}
Write-Host 'TEST AUTO DEPLOY TASK INSTALLED: every 15 minutes.'
Write-Host "Log: $(Join-Path $state 'auto-test-deploy.log')"
Write-Host "Failure hold: $(Join-Path $state 'REQUIRES-REVIEW.txt')"
Write-Host 'LIVE and the two HTTPS routes have not been changed.'
Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
Write-Host 'First TEST update check requested; inspect task state and log for its outcome.'
