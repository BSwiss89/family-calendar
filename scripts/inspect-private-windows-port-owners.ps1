# READ-ONLY port-owner inventory for the future private multi-family TEST host.
# This script does not open SQLite, read process command lines/arguments,
# inspect credentials, touch Windows tasks, start/stop processes or modify
# LIVE/TEST/Tailscale, ports, firewall, or any service. GitHub CI does not
# execute this inventory against the actual family laptop.
param([switch]$SnapshotOnly)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$protected = @(443, 8443, 3001, 11434, 13001, 13002, 13003)
$listeners = @()
$enumerated = $false

try {
    $rows = @(Get-NetTCPConnection -State Listen -ErrorAction Stop |
        Where-Object { $protected -contains [int]$_.LocalPort })
    $enumerated = $true
    foreach ($row in $rows) {
        $address = [string]$row.LocalAddress
        $bind = 'external'
        if ($address -eq '0.0.0.0' -or $address -eq '::') {
            $bind = 'wildcard'
        } elseif ($address -match '^127\.' -or $address -eq '::1' -or
                  $address -match '^::ffff:127\.') {
            $bind = 'loopback'
        } elseif ([string]::IsNullOrWhiteSpace($address)) {
            $bind = 'unknown'
        }

        $ownerId = [int]$row.OwningProcess
        $name = $null
        $readable = $false
        if ($ownerId -gt 0) {
            try {
                $proc = Get-Process -Id $ownerId -ErrorAction Stop
                $safeName = [string]$proc.ProcessName
                if ($safeName -cmatch '^[a-zA-Z0-9_.-]{1,100}$') {
                    $name = $safeName
                    $readable = $true
                }
            } catch {
                # Unknown owner is a manual-review blocker, never a pass.
            }
        }
        $listeners += @{
            port = [int]$row.LocalPort
            pid = $ownerId
            bindClass = $bind
            processName = $name
            processReadable = $readable
        }
    }
} catch {
    $enumerated = $false
    $listeners = @()
}

$inventory = @{
    schemaVersion = 1
    platform = if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) {
        'win32'
    } else {
        'unsupported'
    }
    listenerEnumerationSucceeded = $enumerated
    inspectedPorts = @($protected)
    listeners = @($listeners)
}

$json = ConvertTo-Json -InputObject $inventory -Depth 5 -Compress
if ($SnapshotOnly) {
    $json
    return
}

$json | & node (Join-Path $PSScriptRoot 'assess-private-windows-port-owners.mjs')
if ($LASTEXITCODE -ne 0) {
    throw 'Read-only listener ownership snapshot could not be evaluated.'
}
