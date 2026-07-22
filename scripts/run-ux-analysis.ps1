param(
  [Parameter(Mandatory=$true)][string]$Case,
  [string]$BaseUrl = "",
  [string]$Model = "",
  [string]$ReasoningEffort = ""
)
$arguments = @("$PSScriptRoot\run_direct_analysis.py", "--condition", "full", "--case", $Case)
if ($BaseUrl) { $arguments += @("--base-url", $BaseUrl) }
if ($Model) { $arguments += @("--model", $Model) }
if ($ReasoningEffort) { $arguments += @("--reasoning-effort", $ReasoningEffort) }
if ($env:PYTHON) { & $env:PYTHON @arguments }
elseif (Get-Command py -ErrorAction SilentlyContinue) { & py -3 @arguments }
else { & python @arguments }
exit $LASTEXITCODE
