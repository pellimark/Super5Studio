$ErrorActionPreference = "Stop"

$taskName = "Super5 Studio results update"
$projectRoot = Split-Path -Parent $PSScriptRoot
$updaterPath = Join-Path $projectRoot "update-results.mjs"

if (-not (Test-Path -LiteralPath $updaterPath -PathType Leaf)) {
  throw "Could not find update-results.mjs in $projectRoot"
}

$node = Get-Command node.exe -ErrorAction Stop
$evening = (Get-Date).Date.AddHours(21)
$morning = (Get-Date).Date.AddHours(9)
$triggers = @(
  (New-ScheduledTaskTrigger -Weekly -DaysOfWeek Wednesday -At $evening),
  (New-ScheduledTaskTrigger -Weekly -DaysOfWeek Friday -At $evening),
  (New-ScheduledTaskTrigger -Weekly -DaysOfWeek Thursday -At $morning),
  (New-ScheduledTaskTrigger -Weekly -DaysOfWeek Saturday -At $morning)
)
$action = New-ScheduledTaskAction `
  -Execute $node.Source `
  -Argument "`"$updaterPath`"" `
  -WorkingDirectory $projectRoot
$principal = New-ScheduledTaskPrincipal `
  -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
  -LogonType Interactive `
  -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
  -MultipleInstances IgnoreNew `
  -RestartCount 1 `
  -RestartInterval (New-TimeSpan -Minutes 20)

Register-ScheduledTask `
  -TaskName $taskName `
  -Action $action `
  -Trigger $triggers `
  -Principal $principal `
  -Settings $settings `
  -Description "Checks the official Malta Super5 results archive and safely updates this local project." `
  -Force | Out-Null

Write-Host "Installed '$taskName' for this Windows account."
Write-Host "Checks run Wednesday and Friday at 21:00, with Thursday and Saturday 09:00 retries (Windows local time)."
