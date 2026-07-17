param(
  [Parameter(Mandatory=$true)][string]$Case,
  [ValidateSet("opencode", "claude")][string]$Adapter = "opencode",
  [string]$Command = ""
)
$arguments = @("$PSScriptRoot\run_agent_analysis.py", "--case", $Case, "--adapter", $Adapter)
if ($Command) { $arguments += @("--command", $Command) }
if ($env:PYTHON) { & $env:PYTHON @arguments }
elseif (Get-Command py -ErrorAction SilentlyContinue) { & py -3 @arguments }
else { & python @arguments }
exit $LASTEXITCODE
