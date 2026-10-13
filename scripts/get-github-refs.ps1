# Query GitHub with the same local Git/SSH configuration used by successful git pull.
# The isolated PowerShell job imposes a hard timeout, so a broken SSH agent cannot
# hang a scheduled task indefinitely. Does not fetch/modify any working tree.
function Get-FamilyCalendarGitHubRefs {
    param(
        [Parameter(Mandatory)][string]$Repository,
        [Parameter(Mandatory)][ValidateSet('Main','PullRequests')][string]$Type,
        [ValidateRange(5,120)][int]$TimeoutSeconds = 25
    )
    $job = Start-Job -ScriptBlock {
        param($repoPath, $referenceType)
        # Do not override core.sshCommand: the laptop's repo-local Git config is tested.
        Remove-Item Env:GIT_SSH_COMMAND -ErrorAction SilentlyContinue
        $env:GIT_TERMINAL_PROMPT = '0'
        if ($referenceType -eq 'Main') {
            & git -C $repoPath ls-remote origin refs/heads/main
        } else {
            & git -C $repoPath ls-remote origin 'refs/pull/*/merge' 'refs/pull/*/head'
        }
        if ($LASTEXITCODE -ne 0) {
            throw "GitHub remote query failed with exit code $LASTEXITCODE."
        }
    } -ArgumentList $Repository, $Type

    try {
        $finished = Wait-Job -Job $job -Timeout $TimeoutSeconds
        if (-not $finished) {
            Stop-Job -Job $job -ErrorAction SilentlyContinue
            throw "GitHub query did not finish within $TimeoutSeconds seconds."
        }
        $lines = @(Receive-Job -Job $job -ErrorAction Stop)
        if ($job.State -ne 'Completed') {
            throw "GitHub query ended in job state $($job.State)."
        }
        return $lines
    } finally {
        Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
    }
}
