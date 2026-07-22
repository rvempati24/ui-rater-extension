param(
  [Parameter(Mandatory=$true)][string]$AttemptId,
  [Parameter(Mandatory=$true)][string]$Output,
  [string]$ParticipantsDir = "data\participants",
  [string]$HfRepo = "",
  [string]$HfRevision = "participant-v3-integrity",
  [string]$Policy = "",
  [string]$Calibration = ""
)
$arguments = @("$PSScriptRoot\materialize_method3_case.py", "--attempt-id", $AttemptId, "--output", $Output)
if ($HfRepo) { $arguments += @("--hf-repo", $HfRepo, "--hf-revision", $HfRevision) }
else { $arguments += @("--participants-dir", $ParticipantsDir) }
if ($Policy) { $arguments += @("--policy", $Policy) }
if ($Calibration) { $arguments += @("--calibration", $Calibration) }
if ($env:PYTHON) { & $env:PYTHON @arguments }
elseif (Get-Command py -ErrorAction SilentlyContinue) { & py -3 @arguments }
else { & python @arguments }
exit $LASTEXITCODE
