param(
    [Parameter(Mandatory=$true)][string]$ResultRoot,
    [Parameter(Mandatory=$true)][ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$')][string]$ProjectId,
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9-]{36}$')][string]$RunId,
    [Parameter(Mandatory=$true)][ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$')][string]$StepId,
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$SourceDigest,
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$TargetDigest,
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$ProfileDigest,
    [ValidateSet('pass','fail-before','partial','no-report','stale','timeout')][string]$Outcome='pass',
    [switch]$Recovery,
    [ValidatePattern('^[a-f0-9-]{36}$')][string]$RecoveryId=''
)
# Built-in executor fixture. No platform, database, credential or service APIs.
$ErrorActionPreference = 'Stop'
$started = [DateTime]::UtcNow
$marker = Join-Path $ResultRoot 'simulated-target.json'
if ($Recovery) {
    if (-not $RecoveryId) { throw 'FIXTURE_RECOVERY_ID_REQUIRED' }
    $original = Join-Path (Join-Path $ResultRoot ('workflow-' + $RunId)) $StepId
    $beforePath = Join-Path $original 'target.before.json'
    $before = Get-Content -LiteralPath $beforePath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($before.schemaVersion -ne 1 -or $before.runId -ne $RunId -or $before.stepId -ne $StepId) { throw 'FIXTURE_BACKUP_INVALID' }
    $recoveryDir = Join-Path $ResultRoot ('recovery-' + $RecoveryId)
    [void](New-Item -ItemType Directory -Path $recoveryDir -Force)
    # Exclusive OS handle also excludes a surviving recovery child after a host restart.
    $recoveryLock = [IO.File]::Open((Join-Path $recoveryDir 'restore.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    try {
        if ($before.existed -and ($before.previous.runId -notmatch '^[a-f0-9-]{36}$' -or $before.previous.state -notin @('applied','partial'))) { throw 'FIXTURE_BACKUP_INVALID' }
        $current = $null
        if (Test-Path -LiteralPath $marker) { $current = Get-Content -LiteralPath $marker -Raw -Encoding UTF8 | ConvertFrom-Json }
        $alreadyRestored = if ($before.existed) { $current -and $current.runId -eq $before.previous.runId -and $current.state -eq $before.previous.state } else { $null -eq $current }
        if (-not $alreadyRestored) {
            if (-not $current -or $current.runId -ne $RunId -or $current.state -notin @('applied','partial')) { throw 'FIXTURE_TARGET_CHANGED' }
            if ($before.existed) {
                @{ runId=$before.previous.runId; state=$before.previous.state } | ConvertTo-Json | Set-Content -LiteralPath $marker -Encoding UTF8
            } else { Remove-Item -LiteralPath $marker }
        }
        if ($before.existed) {
            $restored = Get-Content -LiteralPath $marker -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($restored.runId -ne $before.previous.runId -or $restored.state -ne $before.previous.state) { throw 'FIXTURE_RESTORE_FAILED' }
        } elseif (Test-Path -LiteralPath $marker) { throw 'FIXTURE_RESTORE_FAILED' }
        @{ schemaVersion=1; recoveryId=$RecoveryId; runId=$RunId; restored=$true } | ConvertTo-Json |
            Set-Content -LiteralPath (Join-Path $recoveryDir 'result.json') -Encoding UTF8
    } finally {
        $recoveryLock.Dispose()
    }
    exit 0
}
$directory = Join-Path (Join-Path $ResultRoot ('workflow-' + $RunId)) $StepId
if (Test-Path -LiteralPath $directory) { throw 'FIXTURE_REPORT_ALREADY_EXISTS' }
[void](New-Item -ItemType Directory -Path $directory)
$before = @{ schemaVersion=1; runId=$RunId; stepId=$StepId; existed=$false; previous=$null }
if (Test-Path -LiteralPath $marker) {
    $previous = Get-Content -LiteralPath $marker -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($previous.runId -notmatch '^[a-f0-9-]{36}$' -or $previous.state -notin @('applied','partial')) { throw 'FIXTURE_TARGET_INVALID' }
    $before.existed=$true; $before.previous=@{runId=$previous.runId;state=$previous.state}
}
$before | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $directory 'target.before.json') -Encoding UTF8
# The only simulated target is a marker next to these fixture reports, inside the workspace.
if ($Outcome -ne 'fail-before') {
    @{ runId=$RunId; state= $(if ($Outcome -eq 'partial') { 'partial' } else { 'applied' }) } |
        ConvertTo-Json | Set-Content -LiteralPath $marker -Encoding UTF8
}
if ($Outcome -eq 'timeout') { Start-Sleep -Seconds 30; exit 2 }
if ($Outcome -eq 'no-report') { exit 0 }
$code = 0; $state = 'applied'; $status = 'ok'
if ($Outcome -eq 'fail-before') { $code = 2; $state = 'not-applied'; $status = 'error' }
if ($Outcome -eq 'partial') { $code = 3; $state = 'unknown'; $status = 'error' }
$reportedRun = $RunId
if ($Outcome -eq 'stale') { $reportedRun = [Guid]::NewGuid().ToString() }
$report = [ordered]@{
    schemaVersion = 1; projectId = $ProjectId; command = 'deploy'; apply = $true
    startedAtUtc = $started.ToString('o'); finishedAtUtc = [DateTime]::UtcNow.ToString('o'); exitCode = $code
    steps = @(@{ name='deploy.apply'; status=$status })
    workflow = @{ schemaVersion=1; runId=$reportedRun; stepId=$StepId; sourceDigest=$SourceDigest;
        targetDigest=$TargetDigest; profileDigest=$ProfileDigest; mutationState=$state }
}
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $directory 'result.json') -Encoding UTF8
exit $code
