# Regression test: Windows Scheduled Tasks have no interactive SSH agent.
# Verify the secure LIVE controller clones the approved public repo via HTTPS.
$ErrorActionPreference='Stop'
$controller=Join-Path $PSScriptRoot 'secure-live-auto-deploy.ps1'
$text=Get-Content -LiteralPath $controller -Raw
$source="https://github.com/BSwiss89/family-calendar.git"
if(-not $text.Contains("$"+"readOnlySource='"+$source+"'")){
  throw 'HTTPS read-only candidate source missing'
}
if(-not $text.Contains('git -c credential.interactive=never clone --quiet --no-checkout --single-branch --branch feature/auth-current-calendar-two-sites $readOnlySource $stage')){
  throw 'Noninteractive Git clone command does not use the approved HTTPS source'
}
if($text.Contains('branch feature/auth-current-calendar-two-sites $origin $stage')){
  throw 'LIVE SSH origin is still used for unattended clone'
}
if($text -match 'git\s+(-C\s+\$live\s+)?remote\s+set-url'){
  throw 'Controller must never modify LIVE Git origin'
}
$previous=$env:GIT_TERMINAL_PROMPT
try{
  $env:GIT_TERMINAL_PROMPT='0'
  $refs=@(& git -c credential.interactive=never ls-remote $source 'refs/heads/feature/auth-current-calendar-two-sites')
  if($LASTEXITCODE -ne 0 -or $refs.Count -ne 1 -or $refs[0] -notmatch '^[0-9a-f]{40}\s+refs/heads/feature/auth-current-calendar-two-sites$'){
    throw 'Read-only HTTPS branch lookup failed without interactive credentials'
  }
}finally{
  if($null -eq $previous){Remove-Item Env:\GIT_TERMINAL_PROMPT -ErrorAction SilentlyContinue}
  else{$env:GIT_TERMINAL_PROMPT=$previous}
}
Write-Host ('SECURE LIVE SCHEDULED HTTPS GIT REGRESSION PASS: '+(Get-Date -Format o))
