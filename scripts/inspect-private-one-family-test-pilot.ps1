# READ-ONLY ONE-FAMILY TEST PILOT DIAGNOSTIC. Run from a separately
# checked-out development branch, NEVER from the installed LIVE or TEST checkout.
# Reads sanitized Git/task/listener metadata only. Does NOT read SQLite or
# task actions, acquire backups, install tasks, stop services, deploy or route.
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-f0-9]{40}$')]
    [string]$ExpectedCommitSha
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$live = [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE 'Projects\family-calendar')).TrimEnd('\')
$test = [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE 'Projects\family-calendar-test')).TrimEnd('\')
if ([string]::Equals($root, $live, [StringComparison]::OrdinalIgnoreCase) -or
    [string]::Equals($root, $test, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Run the one-family preflight only in a separate development checkout.'
}
$rootInfo = Get-Item -LiteralPath $root -Force
if ($rootInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw 'Candidate checkout links require review.'
}
$head = @(& git -C $root rev-parse HEAD 2>$null)
if ($LASTEXITCODE -ne 0 -or $head.Count -ne 1 -or
    $head[0] -cne $ExpectedCommitSha) {
    throw 'Candidate Git HEAD is not the explicitly reviewed commit.'
}
if (!(Test-Path -LiteralPath (Join-Path $root '.git'))) {
    throw 'An isolated candidate Git checkout is required.'
}

$hostInspector = Join-Path $PSScriptRoot 'inspect-private-test-host.ps1'
$portInspector = Join-Path $PSScriptRoot 'inspect-private-windows-port-owners.ps1'
foreach ($filename in @($hostInspector, $portInspector)) {
    if (!(Test-Path -LiteralPath $filename -PathType Leaf)) {
        throw 'Required existing read-only Windows inspector was not found.'
    }
}
$hostSnapshot = @(& $hostInspector -SnapshotOnly)
$portSnapshot = @(& $portInspector -SnapshotOnly)
if ($hostSnapshot.Count -ne 1 -or $portSnapshot.Count -ne 1) {
    throw 'Read-only Windows inspection did not return exactly one snapshot.'
}
# ConvertFrom-Json/ConvertTo-Json do not save files; do not print raw snapshots.
$payload = @{
    schemaVersion = 1
    mode = 'existing-test-single-household'
    candidateCommitSha = $ExpectedCommitSha
    hostInventory = ConvertFrom-Json -InputObject $hostSnapshot[0]
    portInventory = ConvertFrom-Json -InputObject $portSnapshot[0]
} | ConvertTo-Json -Depth 12 -Compress
$payload | & node (Join-Path $PSScriptRoot 'assess-private-one-family-test-pilot.mjs')
if ($LASTEXITCODE -ne 0) {
    throw 'One-family diagnostic refused unverified information; no site changed.'
}
