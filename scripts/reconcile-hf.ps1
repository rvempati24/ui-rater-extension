param(
  [string]$ParticipantsDir = "data\participants",
  [string]$HfRepo = "uxBench/ux-task-trace",
  [string]$HfRevision = "participant-v3-integrity"
)
$arguments = @("$PSScriptRoot\reconcile_hf.py", "--participants-dir", $ParticipantsDir, "--hf-repo", $HfRepo, "--hf-revision", $HfRevision)
if ($env:PYTHON) { & $env:PYTHON @arguments }
elseif (Get-Command py -ErrorAction SilentlyContinue) { & py -3 @arguments }
else { & python @arguments }
exit $LASTEXITCODE
