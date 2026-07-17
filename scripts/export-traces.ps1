param(
  [string]$Config = "$PSScriptRoot\trace-export.example.json",
  [switch]$UploadHf,
  [switch]$DryRun
)

$arguments = @("$PSScriptRoot\export_traces.py", "--config", $Config)
if ($UploadHf) { $arguments += "--upload-hf" }
if ($DryRun) { $arguments += "--dry-run" }

if ($env:PYTHON) {
  & $env:PYTHON @arguments
} elseif (Get-Command py -ErrorAction SilentlyContinue) {
  & py -3 @arguments
} else {
  & python @arguments
}
exit $LASTEXITCODE
