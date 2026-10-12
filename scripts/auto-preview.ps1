# Automatic browser preview of the newest mergeable OPEN GitHub pull request.
# Scheduled under the authorized laptop account. Does not deploy to live.
# GitHub's refs/pull/N/merge refs identify open, mergeable PRs; PRs with conflicts
# may need a manual preview or conflict resolution before appearing.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$homePath = 'C:\Users\bobby'
$test = Join-Path $homePath 'Projects\family-calendar-test'
$live = Join-Path $homePath 'Projects\family-calendar'
$runner = Join-Path $test 'scripts\preview-pr.ps1'
$stateFolder = Join-Path $homePath 'AppData\Local\FamilyCalendar\auto-preview'
$activeFile = Join-Path $stateFolder 'active.json'
$failedFile = Join-Path $stateFolder 'failed.json'
$logFile = Join-Path $stateFolder 'auto-preview.log'
$expectedOrigin = 'git@github.com:BSwiss89/family-calendar.git'
$sshKey = Join-Path $homePath '.ssh\id_ed25519_github'
$previewPort = 13002

$id = [Security.Principal.WindowsIdentity]::GetCurrent()
if ([string]::Equals($id.Name, 'NT AUTHORITY\SYSTEM', [StringComparison]::OrdinalIgnoreCase) -or
    -not [string]::Equals($env:USERPROFILE, $homePath, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Automatic preview must run as the laptop user, never as SYSTEM.'
}

New-Item -ItemType Directory -Path $stateFolder -Force | Out-Null
$mutex = [System.Threading.Mutex]::new($false, 'Global\FamilyCalendarAutoPreview')
$locked = $false
$transcribing = $false
$priorSsh = [Environment]::GetEnvironmentVariable('GIT_SSH_COMMAND', 'Process')

function Run-Preview([string[]]$parameters) {
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $runner @parameters
    if ($LASTEXITCODE -ne 0) { throw "Isolated preview command failed (exit code $LASTEXITCODE)." }
}

try {
    try { $locked = $mutex.WaitOne(0) }
    catch [System.Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { return }
    Start-Transcript -LiteralPath $logFile -Append | Out-Null
    $transcribing = $true
    Write-Host ("PR PREVIEW CHECK " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))

    foreach ($folder in @($test, $live)) {
        if (-not (Test-Path (Join-Path $folder '.git'))) { throw "Missing Git checkout: $folder" }
        $remote = (& git -C $folder remote get-url origin).Trim()
        if ($LASTEXITCODE -ne 0 -or $remote -ne $expectedOrigin) { throw "Unexpected Git remote: $folder" }
        $dirty = @(& git -C $folder status --porcelain)
        if ($LASTEXITCODE -ne 0 -or $dirty.Count -ne 0) { throw "Checkout is not clean: $folder" }
    }
    if (-not (Test-Path $runner) -or -not (Test-Path $sshKey)) {
        throw 'Preview script or existing GitHub SSH key missing.'
    }

    # Prevent background SSH credential prompts. Transient network/auth errors are retried.
    $env:GIT_SSH_COMMAND = 'C:/Windows/System32/OpenSSH/ssh.exe -i C:/Users/bobby/.ssh/id_ed25519_github -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=20'
    $refs = @(& git -C $test ls-remote origin 'refs/pull/*/merge' 'refs/pull/*/head')
    if ($LASTEXITCODE -ne 0) {
        Write-Warning 'GitHub is currently unavailable without prompting. No preview change.'
        return
    }

    $heads = @{}
    $open = [System.Collections.Generic.List[int]]::new()
    foreach ($line in $refs) {
        if ($line -match '^([a-f0-9]{40})\s+refs/pull/([0-9]+)/(head|merge)$') {
            $number = [int]$Matches[2]
            if ($Matches[3] -eq 'head') { $heads[$number] = $Matches[1] }
            if ($Matches[3] -eq 'merge') { $open.Add($number) }
        }
    }

    $selected = @($open | Sort-Object -Unique -Descending | Where-Object { $heads.ContainsKey($_) } | Select-Object -First 1)
    $active = $null
    if (Test-Path -LiteralPath $activeFile) {
        try { $active = Get-Content -LiteralPath $activeFile -Raw | ConvertFrom-Json }
        catch { Write-Warning 'Invalid preview state; rechecking the actual preview server.' }
    }

    if ($selected.Count -eq 0) {
        if ($null -ne $active) {
            Write-Host 'No open mergeable PR remains; stopping prior preview.'
            Run-Preview @('-Stop')
            Remove-Item -LiteralPath $activeFile -Force
        } else {
            Write-Host 'No open mergeable PR to preview.'
        }
        return
    }

    $number = [int]$selected[0]
    $sha = [string]$heads[$number]

    if (Test-Path -LiteralPath $failedFile) {
        $failed = Get-Content -LiteralPath $failedFile -Raw | ConvertFrom-Json
        if ([int]$failed.number -eq $number -and [string]$failed.sha -eq $sha) {
            Write-Host "PR #$number preview failed previously at this commit; no repeated build until it changes."
            return
        }
        Remove-Item -LiteralPath $failedFile -Force
    }

    $tailscale = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
    if (-not (Test-Path $tailscale)) { throw 'Tailscale not installed.' }
    $ips = @(& $tailscale ip -4)
    if ($LASTEXITCODE -ne 0 -or $ips.Count -ne 1) {
        Write-Warning 'Tailscale address unavailable. Will retry next check.'
        return
    }
    $hostIp = [string]$ips[0]

    if ($null -ne $active -and [int]$active.number -eq $number -and [string]$active.sha -eq $sha) {
        try {
            $health = Invoke-RestMethod "http://$($hostIp):$previewPort/api/health" -TimeoutSec 4
            if ($health.status -eq 'ok') {
                Write-Host "PR #$number is already previewable at http://$($hostIp):$previewPort"
                return
            }
        } catch {
            Write-Warning 'Existing preview not healthy; attempting controlled restart.'
        }
    }

    Write-Host "Starting isolated browser preview for PR #$number, commit $($sha.Substring(0,7))"
    try {
        Run-Preview @('-PullRequest', [string]$number)
        # Check the checkout actually matches the observed GitHub PR head.
        $checkedOut = (& git -C (Join-Path $homePath 'Projects\family-calendar-preview') rev-parse HEAD).Trim()
        if ($LASTEXITCODE -ne 0 -or $checkedOut -ne $sha) {
            throw 'PR changed while preview was building; will not mark it ready.'
        }
        [pscustomobject]@{number=$number;sha=$sha;url="http://$($hostIp):$previewPort"} |
            ConvertTo-Json | Set-Content -LiteralPath $activeFile -Encoding UTF8
        Write-Host "AUTOMATIC PR PREVIEW READY: http://$($hostIp):$previewPort (PR #$number)"
    } catch {
        $errorMessage = $_.Exception.Message
        [pscustomobject]@{number=$number;sha=$sha;error=$errorMessage;when=(Get-Date -Format o)} |
            ConvertTo-Json | Set-Content -LiteralPath $failedFile -Encoding UTF8
        Write-Warning "Preview could not be started for this commit: $errorMessage"
        throw
    }
} finally {
    [Environment]::SetEnvironmentVariable('GIT_SSH_COMMAND', $priorSsh, 'Process')
    if ($transcribing) { Stop-Transcript | Out-Null }
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
