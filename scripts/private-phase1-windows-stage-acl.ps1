# Private Phase 1 data directory creation/verification on Windows PowerShell 5.1.
# Create only a NEW empty directory with a protected DACL at creation time.
# Never repair permissions on an existing stage, change tasks or start services.
[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][ValidateSet('Create','Verify')][string]$Mode,
 [Parameter(Mandatory=$true)][ValidateSet('windows-inactive-stage','disposable-acl-fixture')][string]$Scope,
 [Parameter(Mandatory=$true)][string]$Directory
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
function Refuse { throw 'Private Phase 1 Windows directory ACL verification refused.' }
function PhysicalFolder([string]$p){
 $item=Get-Item -LiteralPath $p -Force
 if(-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){Refuse}
 return $item.FullName.TrimEnd('\')
}
function SamePath([string]$a,[string]$b){
 return [string]::Equals([IO.Path]::GetFullPath($a).TrimEnd('\'),[IO.Path]::GetFullPath($b).TrimEnd('\'),[StringComparison]::OrdinalIgnoreCase)
}
function AsSid([string]$identity){
 try{
  if($identity -match '^S-\d-'){return ([Security.Principal.SecurityIdentifier]::new($identity)).Value}
  return ([Security.Principal.NTAccount]::new($identity)).Translate([Security.Principal.SecurityIdentifier]).Value
 }catch{Refuse}
}
$user=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$system='S-1-5-18'
$admins='S-1-5-32-544'
$allowed=@(@($user,$system,$admins) | Select-Object -Unique)
$root=[IO.Path]::GetFullPath($Directory).TrimEnd('\')
$parent=PhysicalFolder ([IO.Path]::GetDirectoryName($root))
if($Scope -ceq 'windows-inactive-stage'){
 if(-not (SamePath $parent (PhysicalFolder (Join-Path $env:USERPROFILE 'Projects'))) -or
    -not (SamePath $root (Join-Path $parent 'family-calendar-phase1-test-data'))){Refuse}
 $task=@(Get-ScheduledTask -TaskName 'Family Calendar Secure TEST' -TaskPath '\' -ErrorAction Stop)
 if($task.Count -ne 1){Refuse}
 $principal=AsSid ([string]$task[0].Principal.UserId)
 if(@($user,$system) -cnotcontains $principal){Refuse}
}else{
 $temp=PhysicalFolder ([IO.Path]::GetTempPath())
 if(-not (SamePath $parent $temp) -or [IO.Path]::GetFileName($root) -cnotmatch '^fc-phase1-acl-fixture-[a-f0-9]{32}$'){Refuse}
}
function InspectAcl([string]$p,[bool]$isRoot,[bool]$isFolder){
 $acl=Get-Acl -LiteralPath $p
 if($allowed -cnotcontains $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value){Refuse}
 if($isRoot -and -not $acl.AreAccessRulesProtected){Refuse}
 $rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
 if($rules.Count -lt 1){Refuse}
 foreach($rule in $rules){
  if($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $allowed -cnotcontains $rule.IdentityReference.Value){Refuse}
 }
 foreach($sid in $allowed){
  $full=@($rules|Where-Object {
   $_.IdentityReference.Value -ceq $sid -and
   ($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl -and
   ($_.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0
  })
  if($full.Count -lt 1){Refuse}
  if($isFolder -and @($full|Where-Object {
    ($_.InheritanceFlags -band [Security.AccessControl.InheritanceFlags]::ContainerInherit) -ne 0 -and
    ($_.InheritanceFlags -band [Security.AccessControl.InheritanceFlags]::ObjectInherit) -ne 0 -and
    $_.PropagationFlags -eq [Security.AccessControl.PropagationFlags]::None
  }).Count -lt 1){Refuse}
 }
}
# The direct parent must not grant an untrusted identity delete/modify rights
# that could replace the protected child. No parent ACL is changed.
$pa=Get-Acl -LiteralPath $parent
if($allowed -cnotcontains $pa.GetOwner([Security.Principal.SecurityIdentifier]).Value){Refuse}
$writeMask=[Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
foreach($rule in @($pa.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))){
 if($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
    $allowed -cnotcontains $rule.IdentityReference.Value -and
    ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0 -and
    ($rule.FileSystemRights -band $writeMask) -ne 0){Refuse}
}
if($Mode -ceq 'Create'){
 if(Test-Path -LiteralPath $root){Refuse}
 $security=[Security.AccessControl.DirectorySecurity]::new()
 $security.SetAccessRuleProtection($true,$false)
 $security.SetOwner([Security.Principal.SecurityIdentifier]::new($user))
 foreach($sid in $allowed){
  $rule=[Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),[Security.AccessControl.FileSystemRights]::FullControl,([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
  $security.AddAccessRule($rule)
 }
 $null=[IO.Directory]::CreateDirectory($root,$security)
 if(@(Get-ChildItem -LiteralPath $root -Force).Count -ne 0){Refuse}
}
if(-not (SamePath (PhysicalFolder $root) $root)){Refuse}
InspectAcl $root $true $true
$pending=New-Object 'System.Collections.Generic.Queue[string]'
$pending.Enqueue($root)
$count=0
while($pending.Count -gt 0){
 $dir=$pending.Dequeue()
 foreach($item in @(Get-ChildItem -LiteralPath $dir -Force)){
  if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or (++$count -gt 50000)){Refuse}
  InspectAcl $item.FullName $false $item.PSIsContainer
  if($item.PSIsContainer){$pending.Enqueue($item.FullName)}
 }
}
Write-Output 'PHASE1_WINDOWS_STAGE_ACL=PASS | PRIVATE_DACL=YES | TASKS_CHANGED=NO | DEPLOYMENT_AUTHORIZED=NO'
