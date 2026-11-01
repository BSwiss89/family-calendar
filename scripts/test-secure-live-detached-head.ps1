# Regression test: Git's detached HEAD reports no branch on Windows PowerShell.
$ErrorActionPreference='Stop'
$script=Join-Path $PSScriptRoot 'secure-live-auto-deploy.ps1'
$text=Get-Content -LiteralPath $script -Raw
if(-not $text.Contains('$branchOutput=@(& git -C $live branch --show-current)')){throw 'Detached HEAD guard is missing from controller'}
if($text.Contains('([string](& git -C $live branch --show-current)).Trim()')){throw 'Original null-unsafe Git check returned'}
$dir=Join-Path ([IO.Path]::GetTempPath()) ("fc-detached-head-"+[guid]::NewGuid().ToString('N'))
try{
 New-Item -ItemType Directory -Path $dir -ErrorAction Stop | Out-Null
 & git init -q $dir
 if($LASTEXITCODE -ne 0){throw 'Git test repository creation failed'}
 & git -C $dir -c user.name='CI' -c user.email='ci@example.invalid' commit -q --allow-empty -m fixture
 if($LASTEXITCODE -ne 0){throw 'Git fixture commit failed'}
 & git -C $dir checkout --quiet --detach HEAD
 if($LASTEXITCODE -ne 0){throw 'Git detached checkout failed'}
 $branchOutput=@(& git -C $dir branch --show-current)
 if($LASTEXITCODE -ne 0 -or (($branchOutput -join '').Trim() -ne '')){throw 'Detached HEAD returned a nonempty branch'}
 Write-Host ('DETACHED HEAD NULL-SAFE REGRESSION PASS: '+(Get-Date -Format o))
}finally{
 if(Test-Path -LiteralPath $dir){Remove-Item -LiteralPath $dir -Recurse -Force}
}
