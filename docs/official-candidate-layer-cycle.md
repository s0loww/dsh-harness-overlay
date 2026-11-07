# Official candidate layer cycle

`scripts/cycle-official-candidate.mjs` proves a complete rollback and re-apply
cycle on an isolated official Desktop candidate. It never accepts the live
installation or live `.dsh` profile: the candidate must be a direct child of
`var/candidate`.

The command is read-only unless `--execute` is present. Planning discovers all
integrity-checked `applied` UI and policy receipts, resolves the exact retained
artifact by manifest SHA-256, and derives the reverse dependency order from the
recorded before/after states. This matters after migrations: rolling back only
the latest dev4/dev7 receipts restores the older overlays, not the official
profile baseline.

```powershell
node scripts/cycle-official-candidate.mjs `
  --candidate-root "D:\AI_Projects\dsh_harness_overlay\var\candidate\official-desktop-rc5-02" `
  --ui-artifact "D:\AI_Projects\dsh_harness_overlay\dist\airules-ui-overlay-0.1.0-dev4" `
  --policy-artifact "D:\AI_Projects\dsh_harness_overlay\dist\airules-official-policy-0.12.0-dev7"
```

Review the printed order, stop every process launched from the candidate install,
then repeat with `--execute`.

Execution verifies ownership before every rollback, checks the official install
and the three clean profile files, requires no ready markers and an empty
`node_modules`, moves the rolled-back receipt trees into
`.airules-cycle-history/<run-id>/rolled-back`, applies UI then policy, and runs
the normal combined candidate preflight. The final report is
`.airules-cycle-history/<run-id>/cycle-report.json`.

The history move is intentional: installers refuse to overwrite an existing
receipt root, while the complete rolled-back receipt and backup tree must remain
available as evidence. Nothing under the live install or live profile is read or
written by this workflow.
