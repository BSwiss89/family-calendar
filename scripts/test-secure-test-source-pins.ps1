# Fully disposable supervisor pin/rollback regression test. Never opens a real server.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'secure-test-source-pins.ps1')
$root=Join-Path $env:TEMP ('family-calendar-pin-fixture-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root -Force | Out-Null
try {
    $test=Join-Path $root 'fake-calendar'
    $backend=Join-Path $test 'Server'
    New-Item -ItemType Directory -Path $backend -Force | Out-Null
    $index=Join-Path $backend 'index.mjs'
    $auth=Join-Path $backend 'family-auth.mjs'
    [System.IO.File]::WriteAllText($index,'old index')
    [System.IO.File]::WriteAllText($auth,'old auth')
    $indexOld=(Get-FileHash $index -Algorithm SHA256).Hash
    $authOld=(Get-FileHash $auth -Algorithm SHA256).Hash
    $supervisor=Join-Path $root 'supervisor.ps1'
    $text = @'
$preview = 'C:\Users\bobby\Projects\family-calendar-test-security-stage'
$indexHash = 'INDEX_TOKEN'
$authHash = 'AUTH_TOKEN'
if ($false) { throw 'Server source changed. Refusing unreviewed startup.' }
if ($false) { throw 'Authentication code changed. Refusing unreviewed startup.' }
'@
    $text=$text.Replace('INDEX_TOKEN',$indexOld).Replace('AUTH_TOKEN',$authOld)
    [System.IO.File]::WriteAllText($supervisor,$text,[System.Text.UTF8Encoding]::new($true))
    $snapshot=Join-Path $root 'supervisor-previous.ps1'
    Copy-Item $supervisor $snapshot
    Assert-SecureTestSourcePins $supervisor $test
    [System.IO.File]::WriteAllText($index,'new index')
    [System.IO.File]::WriteAllText($auth,'new auth')
    $indexNew=(Get-FileHash $index -Algorithm SHA256).Hash
    $authNew=(Get-FileHash $auth -Algorithm SHA256).Hash
    $changed=Set-SecureTestSourcePins $supervisor $snapshot $indexNew $authNew
    if (!$changed) { throw 'Supervisor update did not report new hashes.' }
    Assert-SecureTestSourcePins $supervisor $test
    $pins=Get-SecureTestSourcePins $supervisor
    if ($pins.Index -ne $indexNew -or $pins.Auth -ne $authNew) { throw 'New pins not saved.' }
    Restore-SecureTestSupervisor $supervisor $snapshot
    [System.IO.File]::WriteAllText($index,'old index')
    [System.IO.File]::WriteAllText($auth,'old auth')
    Assert-SecureTestSourcePins $supervisor $test
    if ((Get-FileHash $supervisor).Hash -ne (Get-FileHash $snapshot).Hash) {
        throw 'Restored supervisor did not match original bytes.'
    }
    [System.IO.File]::WriteAllText($index,'tampered')
    try {
        Assert-SecureTestSourcePins $supervisor $test
        throw 'Expected pin mismatch was not rejected.'
    } catch {
        if ($_.Exception.Message -match '^Expected pin mismatch was not rejected') { throw }
    }
    Write-Host 'PASS: isolated approved-hash update, supervisor rollback, and tampering rejection.'
} finally {
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
