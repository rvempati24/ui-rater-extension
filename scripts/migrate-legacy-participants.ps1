param([string]$DataDir = "data", [switch]$Apply)
$arguments = @("$PSScriptRoot\migrate_legacy_participants.py", "--data-dir", $DataDir)
if ($Apply) { $arguments += "--apply" }
if ($env:PYTHON) { & $env:PYTHON @arguments }
elseif (Get-Command py -ErrorAction SilentlyContinue) { & py -3 @arguments }
else { & python @arguments }
exit $LASTEXITCODE
