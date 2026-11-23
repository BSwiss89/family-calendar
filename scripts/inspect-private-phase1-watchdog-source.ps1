# Read-only AST assessment of a local Windows PowerShell recovery script.
# Never executes the script, resolves its secrets or changes scheduled tasks.
# Reports only code-pattern counts, known Family Calendar task names and SHA256.
param([Parameter(Mandatory=$true)][string]$ScriptPath)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$item=Get-Item -LiteralPath $ScriptPath -ErrorAction Stop
if($item.PSIsContainer -or $item.Extension -cne '.ps1'){throw 'A readable .ps1 file is required.'}
$tokens=$null
$parseErrors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile($item.FullName,[ref]$tokens,[ref]$parseErrors)
if(@($parseErrors).Count -ne 0){throw 'The script has PowerShell parse errors; manual review required.'}
$allCommands=@($ast.FindAll({param($x) $x -is [System.Management.Automation.Language.CommandAst]},$true))
$allStrings=@($ast.FindAll({param($x) $x -is [System.Management.Automation.Language.StringConstantExpressionAst]},$true))
$known=@('Family Calendar Server','Family Calendar Ollama Server','Family Calendar Watchdog','Family Calendar Secure TEST','Family Calendar Secure TEST Auto Deploy','Family Calendar Auto Deploy','Family Calendar Auto Preview','Family Calendar Backup Ack Processor','Family Calendar Backup Catchup Sender','Family Calendar Backup Cleanup','Family Calendar Backup Sender','Family Calendar Local STT','Family Calendar Monthly Restart','Family Calendar Project Backup','Family Calendar Secure LIVE Auto Deploy')
$targets=@($allStrings | ForEach-Object {$_.Value} | Where-Object {$known -ccontains $_} | Sort-Object -Unique)
$names=@($allCommands | ForEach-Object {$_.GetCommandName()})
$control=@('Start-ScheduledTask','Stop-ScheduledTask','Enable-ScheduledTask','Disable-ScheduledTask','Register-ScheduledTask','Set-ScheduledTask','Restart-Service','Start-Service','Stop-Service','Restart-Computer','Stop-Computer','Stop-Process','Start-Process','Invoke-Command','Invoke-Expression','Invoke-CimMethod','Start-Job','schtasks','taskkill','shutdown','shutdown.exe','powershell','powershell.exe','pwsh','pwsh.exe')
$mutations=@($names | Where-Object {$null -ne $_ -and $control -icontains $_})
$dynamic=@($allCommands | Where-Object {$null -eq $_.GetCommandName()})
$scriptLiteralCount=@($allStrings | Where-Object {$_.Value -match '(?i)\.ps1$'}).Count
$explicitTest=@($allStrings | Where-Object {$_.Value -match '(?i)(?:secure[\s_-]*test|family-calendar-test|test-security-stage|13002|13003)'}).Count
$processInspect=@($names | Where-Object {@('Get-Process','Get-CimInstance','Get-WmiObject','Get-NetTCPConnection') -icontains $_}).Count
$hash=(Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
$targetLabel=if($targets.Count){$targets -join ','}else{'none-detected'}
$mutationLabel=if($mutations.Count){(@($mutations | Sort-Object -Unique) -join ',')}else{'none-detected'}
Write-Output ('SCRIPT_SHA256='+$hash+' | COMMANDS='+$allCommands.Count+' | KNOWN_TASK_LITERALS='+$targetLabel+' | TASK_PROCESS_CONTROL_COMMANDS='+$mutationLabel+' | DYNAMIC_COMMANDS='+$dynamic.Count+' | PS1_LITERALS='+$scriptLiteralCount+' | TEST_HINT_STRINGS='+$explicitTest+' | PROCESS_INSPECTION_COMMANDS='+$processInspect)
Write-Output 'SOURCE_SCOPE=ADVISORY_ONLY | WATCHDOG_TEST_EXCLUSION_PROVEN=NO | TEST_DEPLOY_AUTHORIZED=NO | READ_ONLY=YES | SCRIPT_EXECUTED=NO'
