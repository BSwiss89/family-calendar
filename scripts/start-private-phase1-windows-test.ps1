# Existing Secure TEST task action candidate. Does not register or enable tasks.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$code=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if([IO.Path]::GetFileName($code) -cne 'family-calendar-phase1-test-code' -or [IO.Path]::GetFileName([IO.Path]::GetDirectoryName($code)) -ine 'Projects'){throw 'Unexpected TEST launcher path.'}
if(-not [string]::Equals([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')),$code,[StringComparison]::OrdinalIgnoreCase)){throw 'Unexpected TEST launcher path.'}
$node='C:\ProgramData\FamilyCalendar\Runtime\node-v24.22.1\node.exe'
foreach($key in @('NODE_OPTIONS','NODE_PATH','NODE_USE_ENV_PROXY','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','ELECTRON_RUN_AS_NODE')){
 if([Environment]::GetEnvironmentVariable($key)){throw 'Unexpected TEST launch environment.'}
}
Set-Location -LiteralPath $code
& $node (Join-Path $PSScriptRoot 'start-private-phase1-windows-test.mjs')
exit $LASTEXITCODE
