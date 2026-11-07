# Final official Desktop release audit

Audit date: 2026-11-04.

## Verified evidence

- The immutable official Desktop installation verifies as `0.2.1-rc.5`.
- Candidate `official-desktop-rc5-04` uses an isolated `DSH_HOME`, profile and
  Electron user-data directory and does not copy the live profile.
- Final candidate preflight is ready: 28 packages and 52 unique Cordis IDs.
- UI `0.1.0-dev5` and policy `0.12.0-dev7` receipts and ready markers verify.
- The policy artifact excludes MCP bindings, credentials and runtime state.
  No MCP binding is mounted by either artifact.
- The complete automated suite passes (110 tests).
- The hidden and visible startup smokes pass. The visible report is correctly
  labelled `passed-visible-startup`.
- A complete apply/rollback/reapply cycle on `official-desktop-rc5-03` restores
  the clean profile byte-for-byte before applying UI then policy again.
- Live promotion uses a separate certification-gated installer. Its staging
  directory is created on the profile volume, so promotion and recovery remain
  atomic when the evidence directory is on another drive.
- The official live profile was promoted successfully. Receipt:
  `D:\AI_Projects\dsh_harness_overlay\var\live-promotion-backups\release-20261104-0200\receipt.json`.
- Post-promotion UI smoke verifies the default `1С` preset, Russian timer UI,
  Plugins, the read-only degraded balance HUD and Captain Diesel companion.

## Release state

All release gates are complete. The signed application installation itself is
unchanged; only the guarded Desktop profile overlay was promoted. MCP endpoints,
credentials and project bindings remain outside the distributable artifacts.

Known cosmetic limitation: the native Electron `Application` / `Edit` menu and
some descriptions supplied by experimental third-party plugins remain English.
They are outside the public locale provider and are intentionally not patched in
the signed host bundle.

## Required rollback ordering

Apply order is UI, then policy. Rollback must always be the exact reverse:
policy, then UI. Each receipt owns the complete after-state of
`cordis.patch.yml`; reversing that order is required for ownership validation.

The development candidate has a migration chain rather than a clean two-layer
install. If it ever needs to be returned to its original clean profile, the
receipt order is:

1. policy `0.12.0-dev7`;
2. UI `0.1.0-dev4`;
3. policy `0.12.0-dev`;
4. UI `0.1.0-dev`.

Do not use that development candidate for final release proof. Fresh candidates
make the rollback evidence unambiguous.

## Fresh two-candidate release proof

Set `$UiArtifact` to the new immutable localization build before running this
sequence. These commands never target the live profile.

```powershell
$Repo = "D:\AI_Projects\dsh_harness_overlay"
$Source = "C:\Users\S0lo\AppData\Local\Programs\DeepSeek Harness"
$UiArtifact = "$Repo\dist\airules-ui-overlay-<final-version>"
$PolicyArtifact = "$Repo\dist\airules-official-policy-0.12.0-dev7"
$RollbackRoot = "$Repo\var\candidate\official-desktop-rc5-final-rollback"
$FinalRoot = "$Repo\var\candidate\official-desktop-rc5-final"

Set-Location $Repo

node scripts\create-official-candidate.mjs --source $Source --candidate-root $RollbackRoot
node installer\official-ui\plan.mjs --candidate-root $RollbackRoot --artifact $UiArtifact
node installer\official-ui\apply.mjs --candidate-root $RollbackRoot --artifact $UiArtifact
node installer\official-policy\plan.mjs --candidate-root $RollbackRoot --artifact $PolicyArtifact
node installer\official-policy\apply.mjs --candidate-root $RollbackRoot --artifact $PolicyArtifact
node scripts\smoke-official-candidate.mjs --candidate-root $RollbackRoot --ui-artifact $UiArtifact --policy-artifact $PolicyArtifact
node scripts\smoke-official-candidate.mjs --candidate-root $RollbackRoot --ui-artifact $UiArtifact --policy-artifact $PolicyArtifact --launch --timeout-ms 20000

$PolicyReceipt = Join-Path $RollbackRoot ".airules-policy-backups\airules-official-policy-overlay-0.12.0-dev7\receipt.json"
$UiReceipt = Join-Path $RollbackRoot ".airules-ui-backups\airules-dsh-ui-overlay-<final-version>\receipt.json"
node installer\official-policy\rollback.mjs --candidate-root $RollbackRoot --artifact $PolicyArtifact --receipt $PolicyReceipt
node installer\official-ui\rollback.mjs --candidate-root $RollbackRoot --artifact $UiArtifact --receipt $UiReceipt

node scripts\create-official-candidate.mjs --source $Source --candidate-root $FinalRoot
node installer\official-ui\apply.mjs --candidate-root $FinalRoot --artifact $UiArtifact
node installer\official-policy\apply.mjs --candidate-root $FinalRoot --artifact $PolicyArtifact
node scripts\smoke-official-candidate.mjs --candidate-root $FinalRoot --ui-artifact $UiArtifact --policy-artifact $PolicyArtifact
node scripts\smoke-official-candidate.mjs --candidate-root $FinalRoot --ui-artifact $UiArtifact --policy-artifact $PolicyArtifact --launch --timeout-ms 20000
```

After the rollback candidate is restored, verify its three profile files against
the hashes in `candidate-manifest.json`, verify that `node_modules` is empty,
and verify that `ui-ready.json` and `policy-ready.json` are absent. Preserve the
rolled-back receipts as release evidence.
