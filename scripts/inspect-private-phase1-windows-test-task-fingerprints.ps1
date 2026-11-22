# READ-ONLY Phase 1 Windows TEST scheduler definition fingerprint inventory.
# Protects the one LIVE and one TEST. No services/tasks/processes are changed.
# Sensitive action commands, account names, passwords, arguments and task XML
# are NEVER emitted: their stable SHA256 digests are the only evidence.
# A matching digest cannot establish that Watchdog excludes legacy TEST,
# that the old process has exited, or that cutover is safe.
param(
  [Parameter(Mandatory=$true)]
  [ValidatePattern('^[a-f0-9]{40}$')][string]$ExpectedInstalledTestSha,
  [ValidateSet('baseline','maintenance-fenced')]
  [string]$Stage = 'baseline'
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$testSource=Join-Path $env:USERPROFILE 'Projects\family-calendar-test-security-stage'
if(-not [IO.Directory]::Exists($testSource)){throw 'Installed TEST checkout missing.'}
$actual=((& git -C $testSource rev-parse HEAD 2>$null)|Out-String).Trim()
if($LASTEXITCODE -ne 0 -or $actual -cne $ExpectedInstalledTestSha){
  throw 'Installed TEST source does not match independently reviewed baseline SHA.'
}
function Get-Digest([string]$raw) {
  $sha=[Security.Cryptography.SHA256]::Create()
  try{
    $bytes=[Text.Encoding]::UTF8.GetBytes($raw)
    $hash=$sha.ComputeHash($bytes)
    return ([BitConverter]::ToString($hash).Replace('-','').ToLowerInvariant())
  }finally{$sha.Dispose()}
}
function Xml-Fragment([xml]$xml,[string]$name){
  $nodes=@($xml.SelectNodes("//*[local-name()='$name']"))
  if($nodes.Count -ne 1){throw "Protected scheduler XML section missing or ambiguous."}
  return [string]$nodes[0].OuterXml
}
$all=@(Get-ScheduledTask -ErrorAction Stop)
$tasks=@()
foreach($task in $all){
  if([string]$task.TaskName -cnotmatch '^Family Calendar(?:[ -][a-zA-Z0-9 -]+)?$'){
    continue
  }
  $name=[string]$task.TaskName
  $path=[string]$task.TaskPath
  if($path -cne '\'){throw 'Unexpected Family Calendar task path; manual review required.'}
  $xmlString=[string](Export-ScheduledTask -TaskName $name -TaskPath $path -ErrorAction Stop)
  [xml]$xml=$xmlString
  $state=[string]$task.State
  if(@('Ready','Running','Disabled') -cnotcontains $state){
    throw 'Unexpected protected task state; manual review required.'
  }
  $restart=$task.Settings.RestartCount
  $repeat=[string]$task.Settings.MultipleInstances
  if($null -eq $restart -or [int]$restart -lt 0){throw 'Missing restart setting.'}
  $tasks+=@{
    name=$name;path=$path;state=$state;enabled=($state -cne 'Disabled')
    actionDigest=Get-Digest (Xml-Fragment $xml 'Actions')
    principalDigest=Get-Digest (Xml-Fragment $xml 'Principals')
    triggerDigest=Get-Digest (Xml-Fragment $xml 'Triggers')
    triggerCount=@($task.Triggers).Count
    restartCount=[int]$restart
    multipleInstances=$repeat
  }
}
if($tasks.Count -lt 6){throw 'Protected task enumeration incomplete.'}
$payload=@{
  schemaVersion=1;site='existing-secure-test';stage=$Stage
  installedTestSha=$ExpectedInstalledTestSha
  enumerationSucceeded=$true;tasks=@($tasks)
}
$payload|ConvertTo-Json -Depth 6 -Compress
