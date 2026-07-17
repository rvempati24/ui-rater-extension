param(
  [string]$Config = "$PSScriptRoot\trace-export.example.json",
  [ValidateSet("accepted", "audit")][string]$Mode = "accepted",
  [string]$RunId = "",
  [switch]$NoVideo,
  [switch]$UploadHf,
  [switch]$DryRun
)

$arguments = @("$PSScriptRoot\export_traces.py", "--config", $Config, "--mode", $Mode)
if ($RunId) { $arguments += @("--run-id", $RunId) }
if ($NoVideo) { $arguments += "--no-video" }
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
