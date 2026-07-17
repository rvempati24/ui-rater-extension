param(
  [Parameter(Mandatory=$true)][string]$AttemptId,
  [Parameter(Mandatory=$true)][string]$Output,
  [string]$ParticipantsDir = "data\participants",
  [string]$HfRepo = "",
  [string]$HfRevision = "participant-v2",
  [string]$WebsiteSource = "",
  [switch]$NoVideo
)
$arguments = @("$PSScriptRoot\materialize_case.py", "--attempt-id", $AttemptId, "--output", $Output)
if ($HfRepo) { $arguments += @("--hf-repo", $HfRepo, "--hf-revision", $HfRevision) }
else { $arguments += @("--participants-dir", $ParticipantsDir) }
if ($WebsiteSource) { $arguments += @("--website-source", $WebsiteSource) }
if ($NoVideo) { $arguments += "--no-video" }
if ($env:PYTHON) { & $env:PYTHON @arguments }
elseif (Get-Command py -ErrorAction SilentlyContinue) { & py -3 @arguments }
else { & python @arguments }
exit $LASTEXITCODE
