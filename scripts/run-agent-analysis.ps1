param(
  [Parameter(Mandatory=$true)][string]$Case,
  [ValidateSet("evidence-only", "source-explore", "both")][string]$Condition = "both",
  [string]$Model = "gpt-5.6-sol",
  [ValidateSet("minimal", "low", "medium", "high", "xhigh")][string]$ReasoningEffort = "medium",
  [ValidateRange(1, 2147483647)][Nullable[int]]$MaxScreenshots
)
$arguments = @(
  "$PSScriptRoot\run_agent_analysis.py", "--case", $Case, "--condition", $Condition,
  "--reasoning-effort", $ReasoningEffort
)
if ($Model) {
  $arguments += @("--model", $Model)
}
if ($null -ne $MaxScreenshots) {
  $arguments += @("--max-screenshots", $MaxScreenshots)
}
if ($env:PYTHON) { & $env:PYTHON @arguments }
elseif (Get-Command py -ErrorAction SilentlyContinue) { & py -3 @arguments }
else { & python @arguments }
exit $LASTEXITCODE
