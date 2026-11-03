# Static launcher inspection only: never execute a launcher or load its secrets.
function Get-SecureLiveLauncherPins([string]$LauncherPath) {
    $tokens=$null; $errors=$null
    $ast=[System.Management.Automation.Language.Parser]::ParseFile($LauncherPath,[ref]$tokens,[ref]$errors)
    if (@($errors).Count) { throw 'Secure launcher syntax is invalid' }
    $pins=@{}
    foreach ($table in $ast.FindAll({param($n) $n -is [System.Management.Automation.Language.HashtableAst]},$true)) {
        $fields=@{}
        foreach ($pair in $table.KeyValuePairs) {
            if ($pair.Item1 -isnot [System.Management.Automation.Language.StringConstantExpressionAst]) { continue }
            $key=$pair.Item1.Value
            if ($key -notin @('Path','Hash')) { continue }
            if ($pair.Item2 -isnot [System.Management.Automation.Language.PipelineAst]) {
                throw 'Launcher pin fields must contain one literal expression'
            }
            $expression=$pair.Item2.GetPureExpression()
            if ($expression -isnot [System.Management.Automation.Language.StringConstantExpressionAst]) {
                throw 'Launcher pin fields must be literal strings'
            }
            if ($fields.ContainsKey($key)) { throw 'Duplicate launcher pin field' }
            $fields[$key]=$expression.Value
        }
        if (-not $fields.ContainsKey('Hash')) { continue }
        if (-not $fields.ContainsKey('Path') -or $fields.Hash -notmatch '^[A-Fa-f0-9]{64}$') {
            throw 'Malformed launcher pin'
        }
        $relative=$fields.Path.Replace('\','/')
        if ($relative -notin @('Server/index.mjs','Server/family-auth.mjs','package-lock.json','dist/index.html') -or $pins.ContainsKey($relative)) {
            throw 'Unexpected or duplicate protected launcher path'
        }
        $pins[$relative]=$fields.Hash
    }
    if ($pins.Count -ne 4) { throw 'Expected all four secure launcher pins' }
    return $pins
}

function Assert-SecureLiveLauncherPins([string]$LauncherPath,[string]$Root) {
    $pins=Get-SecureLiveLauncherPins $LauncherPath
    foreach ($relative in $pins.Keys) {
        $path=Join-Path $Root $relative
        if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or
            (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $pins[$relative]) {
            throw "Secure launcher pin mismatch: $relative"
        }
    }
}

function New-SecureLiveLauncherPlan([string]$LauncherPath,[string]$CurrentRoot,[string]$CandidateRoot,[string]$CandidateDist,[string]$BackupRoot) {
    Assert-SecureLiveLauncherPins $LauncherPath $CurrentRoot
    $pins=Get-SecureLiveLauncherPins $LauncherPath
    foreach ($relative in @('Server/index.mjs','Server/family-auth.mjs','package-lock.json')) {
        if ((Get-FileHash -LiteralPath (Join-Path $CandidateRoot $relative) -Algorithm SHA256).Hash -ne $pins[$relative]) {
            throw "Frontend-only release changes protected source: $relative"
        }
    }
    $oldHash=$pins['dist/index.html']
    $newHash=(Get-FileHash -LiteralPath (Join-Path $CandidateDist 'index.html') -Algorithm SHA256).Hash
    $encoding=[Text.Encoding]::GetEncoding(28591)
    $bytes=[IO.File]::ReadAllBytes($LauncherPath)
    $text=$encoding.GetString($bytes)
    if ([regex]::Matches($text,[regex]::Escape($oldHash)).Count -ne 1) {
        throw 'Frontend pin must occur exactly once in launcher'
    }
    $oldFile=Join-Path $BackupRoot 'previous-secure-launcher.ps1'
    $newFile=Join-Path $BackupRoot 'candidate-secure-launcher.ps1'
    foreach ($file in @($oldFile,$newFile)) {
        if (Test-Path -LiteralPath $file) { throw 'Launcher backup path already exists' }
    }
    [IO.File]::WriteAllBytes($oldFile,$bytes)
    [IO.File]::WriteAllBytes($newFile,$encoding.GetBytes($text.Replace($oldHash,$newHash)))
    Assert-SecureLiveLauncherPins $oldFile $CurrentRoot
    $newPins=Get-SecureLiveLauncherPins $newFile
    if ($newPins['dist/index.html'] -ne $newHash -or
        (Get-FileHash -LiteralPath $oldFile).Hash -ne (Get-FileHash -LiteralPath $LauncherPath).Hash) {
        throw 'Launcher plan or rollback backup verification failed'
    }
    return @{Previous=$oldFile; Candidate=$newFile}
}

function Set-SecureLiveLauncher([string]$Source,[string]$Destination) {
    $bytes=[IO.File]::ReadAllBytes($Source)
    # Replacing file contents retains the restricted destination ACL.
    [IO.File]::WriteAllBytes($Destination,$bytes)
    if ((Get-FileHash -LiteralPath $Source).Hash -ne (Get-FileHash -LiteralPath $Destination).Hash) {
        throw 'Secure launcher write verification failed'
    }
}

function Assert-SecureLiveBaseline($Approval,[string]$CurrentSha) {
    if ($Approval.schema -ne 1 -or $Approval.kind -ne 'deployed-baseline' -or
        $Approval.repository -ne 'BSwiss89/family-calendar' -or
        $Approval.to_sha -cnotmatch '^[a-f0-9]{40}$' -or $Approval.to_sha -cne $CurrentSha -or
        @($Approval.files).Count -ne 0) {
        throw 'Deployed baseline must match LIVE exactly and authorize no file changes'
    }
}
