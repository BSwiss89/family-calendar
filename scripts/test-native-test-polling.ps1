# Disposable Windows-only regression for the native Set-ScheduledTask trigger API.
# Never accesses the user's Family Calendar tasks or LIVE/TEST data.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$taskName = 'Family Calendar CI Native Poll ' + [Guid]::NewGuid().ToString('N').Substring(0,12)
$created = $false
try {
    $action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\cmd.exe" -Argument '/c exit 0'
    $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(25) -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration (New-TimeSpan -Days 1)
    $null = Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -ErrorAction Stop
    $created = $true
    $beforeTask = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
    [xml]$beforeXml = Export-ScheduledTask -TaskName $taskName -ErrorAction Stop
    $beforeIntervals = @($beforeXml.SelectNodes("//*[local-name()='TimeTrigger']/*[local-name()='Repetition']/*[local-name()='Interval']"))
    if ($beforeIntervals.Count -ne 1 -or $beforeIntervals[0].InnerText -ne 'PT15M') {
        throw 'Disposable Windows fixture does not have the expected one-time repeating trigger.'
    }
    $triggers = @($beforeTask.Triggers)
    if ($triggers.Count -ne 1 -or $triggers[0].CimClass.CimClassName -ne 'MSFT_TaskTimeTrigger' -or
        $triggers[0].Repetition.Interval -ne 'PT15M') {
        throw 'Cannot read disposable native trigger without unexpected normalization.'
    }
    $triggers[0].Repetition.Interval = 'PT1M'
    $null = Set-ScheduledTask -TaskPath '\' -TaskName $taskName -Trigger $triggers -ErrorAction Stop
    $afterTask = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
    [xml]$afterXml = Export-ScheduledTask -TaskName $taskName -ErrorAction Stop
    $afterIntervals = @($afterXml.SelectNodes("//*[local-name()='TimeTrigger']/*[local-name()='Repetition']/*[local-name()='Interval']"))
    if ($afterIntervals.Count -ne 1 -or $afterIntervals[0].InnerText -ne 'PT1M') {
        throw 'Native Set-ScheduledTask did not persist the one-minute interval.'
    }
    $afterIntervals[0].InnerText = 'PT15M'
    if ($beforeXml.OuterXml -cne $afterXml.OuterXml) {
        throw 'Native Set-ScheduledTask unexpectedly modified another task XML field.'
    }
    if ($beforeTask.Principal.LogonType.ToString() -ne $afterTask.Principal.LogonType.ToString() -or
        $beforeTask.Principal.RunLevel.ToString() -ne $afterTask.Principal.RunLevel.ToString() -or
        $beforeTask.Principal.UserId -ne $afterTask.Principal.UserId -or
        $beforeTask.Actions.Count -ne $afterTask.Actions.Count) {
        throw 'Native Set-ScheduledTask changed a principal or action.'
    }
    Write-Host 'TEST_NATIVE_POLLING_FIXTURE=PASS | interval=PT1M | all_other_xml=UNCHANGED | principal=UNCHANGED | changes_to_real_tasks=NONE'
} finally {
    if ($created) {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop
    }
}