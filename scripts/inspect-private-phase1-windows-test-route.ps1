# READ-ONLY Windows TEST route evidence for a FUTURE private Phase 1 release.
# Does not open SQLite, print process args/tokens, install tasks, change Git,
# open ports, stop services, modify portproxy/Funnel, or approve a deployment.
# This script recognizes the existing LEGACY TEST baseline ONLY.
param(
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{40}$')]
  [string]$ExpectedCandidateSha,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{40}$')]
  [string]$ExpectedInstalledTestSha,
  [Parameter(Mandatory=$true)][ValidatePattern('^100\.(?:[0-9]{1,3}\.){2}[0-9]{1,3}$')]
  [string]$ExpectedLegacyTestAddress,
  [int]$GatewayPort = 13004
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$protected = @(443,8443,3001,11434,13001,13002,13003)
if($GatewayPort -lt 1024 -or $GatewayPort -gt 65535 -or
  $protected -contains $GatewayPort) {
  throw 'Unreviewed private gateway port.'
}
$candidate = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$installed = [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE 'Projects\family-calendar-test-security-stage')).TrimEnd('\')
$live = [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE 'Projects\family-calendar')).TrimEnd('\')
if([string]::Equals($candidate,$installed,[StringComparison]::OrdinalIgnoreCase) -or
   [string]::Equals($candidate,$live,[StringComparison]::OrdinalIgnoreCase)) {
  throw 'Read-only inspector must run from a separate candidate checkout.'
}
if(-not [IO.Directory]::Exists($candidate) -or
   -not [IO.Directory]::Exists($installed)) {
  throw 'Candidate or installed TEST source directory missing.'
}
$candidateSha = ((& git -C $candidate rev-parse HEAD 2>$null)|Out-String).Trim()
if($LASTEXITCODE -ne 0 -or $candidateSha -cne $ExpectedCandidateSha) {
  throw 'Unpinned development candidate.'
}
$installedSha = ((& git -C $installed rev-parse HEAD 2>$null)|Out-String).Trim()
if($LASTEXITCODE -ne 0 -or $installedSha -cne $ExpectedInstalledTestSha) {
  throw 'Installed TEST does not match baseline receipt.'
}
$taskNames = @('Family Calendar Secure TEST','Family Calendar Secure TEST Auto Deploy',
  'Family Calendar Watchdog')
foreach($taskName in $taskNames) {
  $matching = @(Get-ScheduledTask -TaskName $taskName -ErrorAction Stop)
  if($matching.Count -ne 1 -or
     @('Running','Ready') -cnotcontains ([string]$matching[0].State)) {
    throw 'Protected TEST task identity/state changed; manual review required.'
  }
}
$liveUpdater = @(Get-ScheduledTask -TaskName 'Family Calendar Auto Deploy' -ErrorAction Stop)
if($liveUpdater.Count -ne 1 -or ([string]$liveUpdater[0].State) -cne 'Disabled') {
  throw 'LIVE automatic deployment state must remain disabled.'
}
# Require a complete export across ALL portproxy families, not just v4tov4.
# A hidden v6tov4 or other mixed-family forward could bypass the reviewed
# single TEST entry even if the original v4tov4 rule still looks correct.
$allFamilyShow = @(& netsh interface portproxy show all)
if($LASTEXITCODE -ne 0 -or $allFamilyShow.Count -lt 1) {
  throw 'Complete Windows portproxy table unavailable; manual review required.'
}
$allFamilyDump = @(& netsh interface portproxy dump)
if($LASTEXITCODE -ne 0 -or $allFamilyDump.Count -lt 1) {
  throw 'Complete Windows portproxy-family export unavailable; manual review required.'
}
$repeatAllFamilyShow = @(& netsh interface portproxy show all)
if($LASTEXITCODE -ne 0 -or [string]::Join("`n",[string[]]$repeatAllFamilyShow) -cne [string]::Join("`n",[string[]]$allFamilyShow)) {
  throw 'Windows portproxy changed while collecting read-only evidence; manual review required.'
}
$allFamilyEvidence = @{
  dump = [string]::Join("`n", [string[]]$allFamilyDump)
  showAll = [string]::Join("`n", [string[]]$allFamilyShow)
  installedTestSha = $ExpectedInstalledTestSha
  legacyTestAddress = $ExpectedLegacyTestAddress
} | ConvertTo-Json -Depth 4 -Compress
$allFamilyEvidence | & node (Join-Path $PSScriptRoot 'review-private-phase1-portproxy-all-families.mjs')
if($LASTEXITCODE -ne 0) {
  throw 'An unreviewed IPv4/IPv6 Windows forwarding rule may bypass TEST.'
}
$raw = @(& netsh interface portproxy show v4tov4)
if($LASTEXITCODE -ne 0){ throw 'Windows portproxy enumeration failed.' }
$rules = @()
$ipv4row = '^\s*(\d{1,3}(?:\.\d{1,3}){3})\s+(\d{1,5})\s+(\d{1,3}(?:\.\d{1,3}){3})\s+(\d{1,5})\s*$'
foreach($line in $raw) {
  if($line -match $ipv4row) {
    $rules += @{
      listenAddress = [string]$Matches[1]
      listenPort = [int]$Matches[2]
      connectAddress = [string]$Matches[3]
      connectPort = [int]$Matches[4]
    }
  }elseif($line -match '^\s*\S+\s+\d{2,5}\s+\S+\s+\d{2,5}\s*$') {
    throw 'Unexpected portproxy rule format; manual review required.'
  }
}
$ports = @(13002,13003,$GatewayPort)
$found = @(Get-NetTCPConnection -State Listen -ErrorAction Stop |
  Where-Object { $ports -contains [int]$_.LocalPort })
$listeners = @()
foreach($socket in $found) {
  if(([string]$socket.LocalAddress) -notmatch '^\d{1,3}(?:\.\d{1,3}){3}$') {
    throw 'Protected listener has an unexpected IPv6 or wildcard format.'
  }
  $role = if($socket.LocalPort -eq 13002){'legacy-test'}elseif(
    $socket.LocalPort -eq 13003){'portproxy'}else{'private-gateway'}
  $listeners += @{
    address = [string]$socket.LocalAddress
    port = [int]$socket.LocalPort
    role = $role
  }
}
$test = @($found | Where-Object {$_.LocalPort -eq 13002})
if($test.Count -ne 1 -or
   ([string]$test[0].LocalAddress) -cne $ExpectedLegacyTestAddress) {
  throw 'Observed legacy TEST listener no longer matches baseline.'
}
$proc = Get-CimInstance Win32_Process -Filter ("ProcessId = "+$test[0].OwningProcess) -ErrorAction Stop
if($null -eq $proc -or $proc.Name -cne 'node.exe' -or
   $proc.CommandLine -notlike '*family-calendar-test-security-stage*') {
  throw 'Protected TEST listener process source mismatch.'
}
# No command lines, environment variables, credentials or raw task actions
# enter the JSON snapshot or console. Only sanitized port metadata.
$payload = @{
  schemaVersion = 1
  site = 'existing-secure-test'
  phase = 'baseline'
  installedTestSha = $ExpectedInstalledTestSha
  legacyTestAddress = $ExpectedLegacyTestAddress
  gatewayPort = $GatewayPort
  portproxyRules = @($rules)
  listeners = @($listeners)
} | ConvertTo-Json -Depth 8 -Compress
$payload | & node (Join-Path $PSScriptRoot 'review-private-phase1-windows-test-route.mjs')
if($LASTEXITCODE -ne 0) {
  throw 'Read-only Phase 1 route review requires operator attention.'
}
Write-Output 'WINDOWS_PHASE1_ROUTE_EVIDENCE=PASS | BASELINE_ONLY=YES | DEPLOYMENT_AUTHORIZED=NO | SERVICES_CHANGED=NO'
