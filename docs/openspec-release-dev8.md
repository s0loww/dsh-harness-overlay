# OpenSpec integration — dev8

Date: 2026-11-04. Target: official Desktop `0.2.1-rc.5`.

## Installed

UI `0.1.0-dev5` + policy `0.12.0-dev8` are installed in the live Desktop
profile. The signed host installation still verifies against all five baseline
files. OpenSpec is enabled for `1c-airules` by default; explicit project
`integrations.openspec=false` disables it. Atlassian remains disabled.

The standalone `dsh-openspec-workflow@0.1.0-airules.1` adds the OpenSpec pane,
Markdown editor, task board, approval records, Git snapshot, selected-change
context, query tools and progress/handoff. `/opsx-explore`, `propose`, `apply`,
`apply-all`, `update`, `sync` and `archive` dispatch the six canonical airules
skills. The supplier's skill provider is not registered.

The private dependency tree includes OpenSpec CLI `1.12.0` and
`@j1nn0/agent-handoff` / `agent-progress` `0.1.1`, with 82 physical package
directories pinned by `upstream/openspec-closure.lock.json`. Staging verifies
hashes and copies the packages without lifecycle scripts or global installs.

The embedded rulepack includes 55 rules, 13 roles and 14 skills. It also
contains the hidden-desktop Vanessa instructions and updated tester evidence
contract from `project_rules`.

## Verification evidence

- Automated suite: 121 passed, 0 failed.
- Source rulepack build/verify: 309 files, 14 skills.
- Runtime tests cover explicit opt-out, native PLAN/read-only restrictions,
  actual HTTP handlers, CSRF, cold-session reads, stale revisions,
  traversal/junction rejection and cancelled tasks in progress/handoff.
- Actual private CLI runs `--version` as `1.12.0` in isolation.
- Candidate `official-desktop-rc5-05` passes hidden startup and visible startup.
- Candidate apply/rollback/reapply restores the baseline byte-for-byte:
  `.airules-cycle-history/2026-11-04T07-47-28-779Z-8a24d867-afae-4841-9d0d-c728c1874536/cycle-report.json`.
- Live UI lists BKI's four active changes and opens the existing
  `add-last-payment-exist-flag/proposal.md` with its process stages and actions.
  No model-driven apply, approval or archive was triggered. Selecting the
  change creates its normal `dsh-workflow.json` UI state file.
- Live receipt verifies 26 owned targets with no drift or pending cleanup:
  `var/live-promotion-backups/release-20261104-openspec-dev8/receipt.json`.

The first normal window close left DSH background processes alive; guarded
rollback encountered a file lock and restored every after-state unchanged.
After terminating only the exact official DSH executable's processes, rollback
and promotion passed. Always check background processes before future updates.

## Rollback

Close DSH completely, then run `installer/official-live/rollback.mjs` with the
dev8 receipt and **explicit** `--policy-artifact dist/airules-official-policy-0.12.0-dev8`
plus `--ui-artifact dist/airules-ui-overlay-0.1.0-dev5`. The installer requires
absolute install/profile/receipt paths and the documented acknowledgement.
CLI defaults intentionally still resolve the earlier dev7 artifact; do not use
them with the dev8 receipt.

The previous live receipt `release-20261104-0200` is now `rolled-back`.
Its retained artifacts and candidate remain available for recovery/reinstall.

## Limits

Integration tests exercised writes on temporary fixture projects; the BKI live
check read real artifacts and selected a change without modifying its planning
or source files. A user task can exercise the full proposal/apply/archive cycle.
Full upstream copyright/notice provenance for the supplied MIT-labelled vendor
plugin remains to be obtained before an external distribution is published;
the local port records this in `src/openspec-workflow/PROVENANCE.md`.
