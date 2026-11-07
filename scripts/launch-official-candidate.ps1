param(
    [string]$CandidateRoot = "D:\AI_Projects\dsh_harness_overlay\var\candidate\official-desktop-rc5-02",
    [string]$UiArtifactRoot = "D:\AI_Projects\dsh_harness_overlay\dist\airules-ui-overlay-0.1.0-dev4",
    [string]$PolicyArtifactRoot = "D:\AI_Projects\dsh_harness_overlay\dist\airules-official-policy-0.12.0-dev7",
    [switch]$Visible,
    [ValidateRange(5, 60)]
    [int]$TimeoutSeconds = 20
)

$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'smoke-official-candidate.mjs'
if (-not (Test-Path -LiteralPath $script -PathType Leaf)) {
    throw 'Candidate smoke runner is missing.'
}

$arguments = @(
    $script,
    '--candidate-root', [System.IO.Path]::GetFullPath($CandidateRoot),
    '--ui-artifact', [System.IO.Path]::GetFullPath($UiArtifactRoot),
    '--policy-artifact', [System.IO.Path]::GetFullPath($PolicyArtifactRoot),
    '--launch',
    '--timeout-ms', ([string]($TimeoutSeconds * 1000))
)
if ($Visible) { $arguments += '--visible' }

& node @arguments
if ($LASTEXITCODE -ne 0) {
    throw "Candidate smoke failed with exit code $LASTEXITCODE."
}
