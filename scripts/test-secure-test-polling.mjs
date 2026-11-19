// Static, non-mutating safety contract for the optional TEST polling/reporting helpers.
// Real Windows task preflight and installation still require a separate owner review.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const polling = readFileSync(new URL('./configure-secure-test-polling.ps1', import.meta.url), 'utf8');
const report = readFileSync(new URL('./report-secure-test-deployment.ps1', import.meta.url), 'utf8');
const updater = readFileSync(new URL('./secure-test-auto-deploy.ps1', import.meta.url), 'utf8');

test('schedule change is explicit, one minute and only for existing TEST updater', () => {
  assert.match(polling, /param\(\[switch\]\$Apply,\[switch\]\$ApplyNative,\[switch\]\$SelfTestPrincipal\)/);
  assert.match(polling, /if \(!\$changeRequested -or \$before\.Interval -eq 'PT1M'\)/);
  assert.match(polling, /'Family Calendar Secure TEST Auto Deploy'/);
  assert.match(polling, /& schtasks\.exe \/Change \/TN \$taskName \/RI 1/);
  assert.match(polling, /\$originalErrorAction = \$ErrorActionPreference/);
  assert.match(polling, /\$ErrorActionPreference = 'Continue'/);
  assert.match(polling, /\$changeOutput = @\(& schtasks\.exe \/Change \/TN \$taskName \/RI 1 2>&1\)/);
  assert.match(polling, /\$changeExitCode = \$LASTEXITCODE/);
  assert.match(polling, /\$changeError = "schtasks exit code \$changeExitCode; Windows says: \$changeDetails"/);
  assert.match(polling, /\$ErrorActionPreference = \$originalErrorAction/);
  assert.doesNotMatch(polling, /\$changeError = 'Windows rejected the task update'/);
  assert.match(polling, /\$changeRequested = \[bool\]\(\$Apply -or \$ApplyNative\)/);
  assert.match(polling, /if \(\$Apply -and \$ApplyNative\)/);
  assert.match(polling, /\$triggers = @\(\$before\.Task\.Triggers\)/);
  assert.match(polling, /CimClassName -ne 'MSFT_TaskTimeTrigger'/);
  assert.match(polling, /Repetition\.Duration -ne 'P3650D'/);
  assert.match(polling, /Repetition\.Interval = 'PT1M'/);
  assert.match(polling, /Set-ScheduledTask -TaskPath '\\' -TaskName \$taskName -Trigger \$triggers -ErrorAction Stop/);
  assert.match(polling, /\$changeError = "Set-ScheduledTask rejected trigger-only update:/);
  assert.match(polling, /if \(\$changeError -and \$after\.Interval -eq 'PT1M'\)/);
  assert.match(polling, /\$safe = Same-ExceptInterval \$before \$after/);
  assert.doesNotMatch(polling, /-User\s| -Password\s|-Principal\s|-Action\s|-Settings\s/);
  assert.match(polling, /'PT15M','PT1M'/);
  assert.match(polling, /current=\$\(\$before\.Interval\).*changes_made=NONE/);
  assert.doesNotMatch(polling, /(?:Register|Unregister|Start|Stop|Disable|Enable)-ScheduledTask/);
  assert.doesNotMatch(polling, /\/RU\b|\/RP\b|Read-Host|GetNetworkCredential|SecureStringToBSTR/);
  assert.doesNotMatch(polling, /\/Create\b|\/Delete\b|\/F\b/);
});

test('deployment scheduling cannot change account, action, original runner or LIVE', () => {
  assert.match(polling, /\$task\.Principal\.UserId/);
  assert.match(polling, /Test-TaskPrincipalIsCurrentUser/);
  assert.match(polling, /Security\.Principal\.NTAccount/);
  assert.match(polling, /Translate\(\[Security\.Principal\.SecurityIdentifier\]\)/);
  assert.match(polling, /GetCurrent\(\)\.User/);
  assert.match(polling, /throw 'Could not independently verify the scheduled-task account SID\.'/);
  assert.match(polling, /TEST_TASK_PRINCIPAL_SID_SELFTEST=PASS/);
  assert.doesNotMatch(polling, /\[string\]::Equals\(\[string\]\$task\.Principal\.UserId,\$identity/);
  assert.match(polling, /\$task\.Principal\.LogonType\.ToString\(\) -ne 'Password'/);
  assert.match(polling, /\$task\.Principal\.RunLevel\.ToString\(\) -ne 'Highest'/);
  assert.match(polling, /\$task\.Settings\.MultipleInstances\.ToString\(\) -ne 'IgnoreNew'/);
  assert.match(polling, /Same-ExceptInterval/);
  assert.match(polling, /Export-ScheduledTask/);
  assert.match(polling, /Global\\FamilyCalendarSecureTestAutoDeploy/);
  assert.match(polling, /REQUIRES-REVIEW\.txt/);
  assert.match(polling, /IN-PROGRESS\.txt/);
  assert.match(polling, /POLLING_CHANGE_HOLD/);
  assert.match(polling, /Get-FileHash -LiteralPath \$runner -Algorithm SHA256/);
  assert.match(polling, /Get-Head \$live/);
  assert.match(polling, /branchState\.protected -ne \$true/);
  assert.match(polling, /requiredContexts -contains 'frontend-build'/);
  assert.match(polling, /Get-Head \$test/);
});

test('status reporter cannot mutate deployment, tasks or local data', () => {
  assert.match(report, /# Read-only one-line report/);
  assert.match(report, /Get-ScheduledTask/);
  assert.match(report, /Export-ScheduledTask/);
  assert.match(report, /REQUIRES-REVIEW\.txt/);
  assert.match(report, /IN-PROGRESS\.txt/);
  assert.match(report, /TEST AUTO DEPLOY SUCCESS/);
  assert.match(report, /installed_sha_not_receipted/);
  assert.match(report, /last_backup_unverified/);
  assert.match(report, /\/api\/health/);
  assert.match(report, /\/api\/auth\/status/);
  assert.match(report, /\/api\/events/);
  assert.match(report, /StatusCode -ne 401/);
  assert.match(report, /TEST_DEPLOY_REPORT=\$status/);
  assert.doesNotMatch(report, /(?:Set|Register|Unregister|Start|Stop|Disable|Enable)-ScheduledTask/);
  assert.doesNotMatch(report, /New-Item|Set-Content|Remove-Item|Copy-Item|git\s+(?:reset|checkout|fetch|merge|pull)|schtasks\.exe/);
});

test('existing TEST updater keeps CI, overlap, backup and rollback gates', () => {
  assert.match(updater, /Global\\FamilyCalendarSecureTestAutoDeploy/);
  assert.match(updater, /if \(\(Test-Path \$holdFile\) -or \(Test-Path \$journal\)\)/);
  assert.match(updater, /head_sha=\$targetSha/);
  assert.match(updater, /\$matching\[0\]\.conclusion -ne 'success'/);
  assert.match(updater, /merge-base --is-ancestor \$oldSha \$targetSha/);
  assert.match(updater, /Dependency changes need a separate reviewed installation/);
  assert.match(updater, /Backup source missing/);
  assert.match(updater, /TEST database backup integrity check failed/);
  assert.match(updater, /Wait-Healthy/);
  assert.match(updater, /Anonymous calendar event access was allowed/);
  assert.match(updater, /Automatic TEST update failed at/);
});
