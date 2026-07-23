param(
  [Parameter(Mandatory=$true)][string]$Bundle,
  [Parameter(Mandatory=$true)][string]$OutputRoot,
  [string]$Policy = "",
  [string]$Calibration = ""
)
$arguments = @("$PSScriptRoot\materialize_method3_case.py", "--bundle", $Bundle, "--output-root", $OutputRoot)
if ($Policy) { $arguments += @("--policy", $Policy) }
if ($Calibration) { $arguments += @("--calibration", $Calibration) }
if ($env:PYTHON) { & $env:PYTHON @arguments }
elseif (Get-Command py -ErrorAction SilentlyContinue) { & py -3 @arguments }
else { & python @arguments }
exit $LASTEXITCODE
