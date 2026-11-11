# Git sources, project rollout and harness update

Date: 2026-11-11. Target: official Desktop 0.2.2-rc.1.
UI: 0.17.0-host022-ui1. Policy: 0.17.0-git2.
Canonical airules stays 0.16.0 / 82c10a443fe25144a6a5a47bd29918d092b43c82.

## Included

- Settings pages for project rules and harness updates, using the shared project context.
- GitHub/local/embedded airules sources pinned to a commit. Fetches use a managed cache; user repositories are not pulled or modified.
- Project preview, file comparison, conflicts, reviewed apply and exact receipt-based rollback. MCP and user instructions are preserved. Skills copying is optional.
- Public GitHub release discovery and bounded archive verification. A source-only repository is reported honestly; a published installable release is required for download.
- Certified local candidate preparation using the existing installer engine. Installation waits for Desktop exit, with receipts, backup, verification and restart. Pending update/rollback can be cancelled even after rights are revoked.
- Captain preview displays the real bubble above settings, with corrected placement and interval explanation.

## Verification

Full source suite: 1066 PASS, one obsolete test skipped, zero failures.

Native installed-package acceptance: 274 checks PASS. Nine actual trusted Python calls exercised preview/verify/apply/rollback for 55 rules on an isolated fixture. Exact rollback, CAS, rights, conflicts and preservation of BOM/MCP/user files passed.
Host/updater tests: 29/29 PASS. Source, rollout, candidate and Captain tests: 40/40 PASS.
No paid inference, external requests, MCP calls, project runners or real 1C deployment in native acceptance.

## Operational limits

GitHub sources are public. Git source availability does not mean a binary release has been published. Update archives require matching artifact manifests and the current official host version.
The trusted installer engine and its artifact/backup store are machine settings. They are not downloaded from an incoming Git checkout. Personal paths are configured locally and absent from the portable payload.
Maintenance mutations require an active registered project executor with native full access. GUI actions use native authenticated admission, CSRF and an explicit reviewed action; non-UI execution uses native approval. Cancelling an existing pending operation reduces activity and does not require renewed execution authority.
Project rollout was verified only on fixtures; existing working projects were not changed by this release.

## Live installation

Installed with receipt `var/live-promotion-backups/release-20261111-git017/receipt.json`.
60 packages, 61 owned after-states, zero drift. Candidate rollback/reapply and
visible startup passed. Installed Desktop restarted and both maintenance pages
were visibly opened. The real GitHub check fetched the public harness branch and
correctly reported that no installable GitHub release had been published.

The existing BL project has a legacy `.airules-manifest.json` with
`version/installed_at/files/placeholders` and 468 entries, including Claude paths.
It is not the managed DSH rollout schema. Current rollout refuses this manifest
(`ROLLOUT_MANIFEST_INVALID`) rather than assuming ownership or overwriting it.
Legacy manifest migration and a clearer UI diagnostic remain follow-up work;
no BL rule files or MCP settings were changed.

Follow-up: [BL legacy manifest migration](legacy-manifest-migration.md) now
normalizes the accounting format with a verified backup. The installed DSH panel
reads it without error. A distribution upgrade and instruction adoption remain
separate reviewed actions.
