# Manually deploys approved FRONTEND changes from GitHub.
# Preview is the default. Use -Apply only after reviewing the output.
# Does not stop/restart the server or change Server/data, Server/uploads, or the startup task.
# Backend or dependency changes are intentionally rejected.

param([switch]$Apply)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$live = Join-Path $env:USERPROFILE 'Projects\family-calendar'
$test = Join-Path $env:USERPROFILE 'Projects\family-calendar-test'
$remote = 'git@github.com:BSwiss89/family-calendar.git'
$backupParent = Join-Path $env:USERPROFILE 'Projects\family-calendar-release-backups'

if ([Security.Principal.WindowsIdentity]::GetCurrent().Name -eq 'NT AUTHORITY\SYSTEM') {
    throw 'Deploy from an interactive PowerShell session, not as SYSTEM.'
}

function Check-Repo([string]$folder, [string]$label) {
    if (-not (Test-Path (Join-Path $folder '.git'))) {
        throw "$label repository not found: $folder"
    }
    $url = (& git -C $folder remote get-url origin).Trim()
    if ($LASTEXITCODE -ne 0 -or $url -ne $remote) {
        throw "$label has an unexpected GitHub remote."
    }
    $branch = (& git -C $folder branch --show-current).Trim()
    if ($LASTEXITCODE -ne 0 -or $branch -ne 'main') {
        throw "$label must be on the main branch."
    }
    $changes = @(& git -C $folder status --porcelain)
    if ($LASTEXITCODE -ne 0 -or $changes.Count -ne 0) {
        throw "$label has uncommitted changes. Resolve them before deployment."
    }
}

function Get-Plan {
    Check-Repo $live 'Live'
    Check-Repo $test 'Test'

    $from = (& git -C $live rev-parse HEAD).Trim()
    $to = (& git -C $test rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Unable to read Git commit IDs.' }

    & git -C $test merge-base --is-ancestor $from $to
    if ($LASTEXITCODE -ne 0) {
        throw 'Live commit is not an ancestor of test. Resolve divergent commits before deploying.'
    }

    $changed = @(& git -C $test diff --name-only "$from..$to")
    if ($LASTEXITCODE -ne 0) { throw 'Could not compare versions.' }

    $allowed = '^(src/|public/|\.github/|scripts/|docs/|index\.html$|README\.md$|\.gitignore$|eslint\.config\.js$|vite\.config\.ts$|tsconfig(?:\.[^/]+)?\.json$)'
    $blocked = @($changed | Where-Object { $_ -notmatch $allowed })
    if ($changed -contains 'package.json') {
        & node (Join-Path $test 'scripts\check-pwa-prebuild-only.mjs') $test $from $to
        if ($LASTEXITCODE -eq 0) {
            $blocked = @($blocked | Where-Object { $_ -ne 'package.json' })
        }
    }

    [pscustomobject]@{
        From = $from
        To = $to
        Changed = $changed
        Blocked = $blocked
    }
}

if ($Apply) {
    Check-Repo $live 'Live'
    Check-Repo $test 'Test'
    $updateTest = Join-Path $test 'scripts\update-test.ps1'
    if (-not (Test-Path $updateTest)) { throw 'Test update script is missing.' }

    Write-Host 'Updating and rebuilding the separate test copy first...'
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $updateTest
    if ($LASTEXITCODE -ne 0) { throw 'Test build failed. Live calendar unchanged.' }
}

$plan = Get-Plan

Write-Host ''
Write-Host "Live commit: $($plan.From.Substring(0, 7))"
Write-Host "Test commit: $($plan.To.Substring(0, 7))"
Write-Host 'Changed files:'
$plan.Changed | ForEach-Object { Write-Host "  $_" }

if ($plan.Blocked.Count -gt 0) {
    Write-Host 'Backend, dependencies, or other files require a separate deployment procedure:'
    $plan.Blocked | ForEach-Object { Write-Host "  $_" }
    throw 'Frontend-only deployment blocked; live calendar unchanged.'
}

if ($plan.From -eq $plan.To) {
    Write-Host 'Live is already at the tested commit. Nothing to deploy.'
    return
}

if (-not $Apply) {
    Write-Host ''
    Write-Host 'PREVIEW ONLY. Nothing changed. Run with -Apply to deploy approved frontend code.'
    return
}

$testDist = Join-Path $test 'dist'
$liveDist = Join-Path $live 'dist'
if (-not (Test-Path (Join-Path $testDist 'index.html'))) {
    throw 'Missing test build output; live calendar unchanged.'
}
if (-not (Test-Path (Join-Path $liveDist 'index.html'))) {
    throw 'Missing live build output; live calendar unchanged.'
}

# Ensure the live server works before touching it.
$health = Invoke-WebRequest 'http://127.0.0.1:3001/api/health' -UseBasicParsing -TimeoutSec 10
if ($health.StatusCode -ne 200) { throw 'Live server health check failed before deployment.' }

# Make sure GitHub has not changed since the test build.
& git -C $live fetch origin main
if ($LASTEXITCODE -ne 0) { throw 'Could not fetch the live repository; nothing deployed.' }
$remoteHead = (& git -C $live rev-parse origin/main).Trim()
if ($LASTEXITCODE -ne 0 -or $remoteHead -ne $plan.To) {
    throw 'GitHub main differs from the tested commit. Re-test before deploying.'
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupDir = Join-Path $backupParent "$stamp-$($plan.From.Substring(0, 7))"
$oldDist = Join-Path $backupDir 'dist'
$stage = Join-Path $backupParent "stage-$stamp-$PID"
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null

Copy-Item -LiteralPath $testDist -Destination $stage -Recurse -Force
if (-not (Test-Path (Join-Path $stage 'index.html'))) {
    throw 'Staging copy failed; live calendar unchanged.'
}
Set-Content -LiteralPath (Join-Path $backupDir 'previous-commit.txt') -Value $plan.From

$advanced = $false
$oldMoved = $false

try {
    & git -C $live merge --ff-only origin/main
    if ($LASTEXITCODE -ne 0) { throw 'Live source update failed.' }
    $advanced = $true

    Move-Item -LiteralPath $liveDist -Destination $oldDist
    $oldMoved = $true
    Move-Item -LiteralPath $stage -Destination $liveDist

    $sourceHash = (Get-FileHash (Join-Path $testDist 'index.html') -Algorithm SHA256).Hash
    $liveHash = (Get-FileHash (Join-Path $liveDist 'index.html') -Algorithm SHA256).Hash
    if ($sourceHash -ne $liveHash) { throw 'Deployed HTML differs from tested HTML.' }

    $page = Invoke-WebRequest 'http://127.0.0.1:3001/' -UseBasicParsing -TimeoutSec 10
    $expectedHtml = [System.IO.File]::ReadAllText((Join-Path $liveDist 'index.html'))
    if ($page.StatusCode -ne 200 -or $page.Content.Trim() -ne $expectedHtml.Trim()) {
        throw 'Live calendar did not return the newly built HTML.'
    }

    $health = Invoke-WebRequest 'http://127.0.0.1:3001/api/health' -UseBasicParsing -TimeoutSec 10
    if ($health.StatusCode -ne 200) { throw 'Post-deployment health check failed.' }

    Write-Host ''
    Write-Host "DEPLOYED frontend commit $($plan.To.Substring(0, 7))"
    Write-Host "Previous frontend saved in: $oldDist"
    Write-Host 'Node.js server remains running. Refresh the calendar page to load the new frontend.'
} catch {
    $problem = $_.Exception.Message
    Write-Warning "Deployment failed: $problem"
    $rollbackProblems = @()

    if ($oldMoved) {
        try {
            if (Test-Path $liveDist) {
                $failedDist = Join-Path $backupDir 'failed-dist'
                Move-Item -LiteralPath $liveDist -Destination $failedDist
            }
            Move-Item -LiteralPath $oldDist -Destination $liveDist
        } catch {
            $rollbackProblems += "Frontend restoration: $($_.Exception.Message)"
        }
    }

    if ($advanced) {
        try {
            $head = (& git -C $live rev-parse HEAD).Trim()
            $changes = @(& git -C $live status --porcelain)
            if ($head -eq $plan.To -and $changes.Count -eq 0) {
                & git -C $live reset --hard $plan.From
                if ($LASTEXITCODE -ne 0) { throw 'Git reset failed.' }
            } else {
                throw 'Repository changed during deployment; manual inspection required.'
            }
        } catch {
            $rollbackProblems += "Git restoration: $($_.Exception.Message)"
        }
    }

    if ($rollbackProblems.Count -gt 0) {
        throw "Deployment failed; rollback INCOMPLETE. $($rollbackProblems -join '; ')"
    }
    throw "Deployment failed; previous frontend and Git version restored. $problem"
} finally {
    if (Test-Path $stage) {
        Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
    }
}
