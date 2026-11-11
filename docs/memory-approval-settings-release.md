# Configurable memory confirmations

Date: 2026-11-11. Target host: official Desktop 0.2.2-rc.1.
Policy: 0.17.2-approval1. UI overlay remains 0.17.0-host022-ui1.

## Behavior

Memory settings expose a recipient default and a project override for additional
confirmations. Global `approval` accepts `required` or `disabled`; project policy
also accepts `inherit`. Missing legacy fields normalize to required/inherit without
rewriting saved files. The default remains required.

The preference covers all supported memory operations, including remember,
processing and applying a saved processing-model profile. Reads already require
no additional mutation prompt. When disabled, the plugin omits its own browser
confirmation and additional approval request. Models receive the effective policy
and do not need to ask the same question again; confirm:true still represents an
explicit operation intent, not a separate user dialog.

Deletion is excluded. No deletion API was introduced; unsupported delete/remove/
forget operations are refused rather than becoming ordinary unconfirmed actions.
Independent native MCP permissions and backend access rules remain authoritative.

The setting does not grant read-only/subagents write access, relax project scope,
remove revision/receipt guards, or authorize arbitrary tools. Applying processing
models still requires full native lead authority, a pinned saved profile, trusted
fixed runners and backups. Its internal policy verifier is not a model or HTTP
argument and is checked again around mutation steps.

## Distribution

The feature belongs to persistent application/project policy, not an individual
chat. Existing accounts, provider settings, project contracts, MCP bindings and
memory content are preserved. The release does not toggle the preference on the
user's behalf or ingest/retry a note as an acceptance test.

## Validation

Memory tests: 163/163 PASS. Installed-byte native acceptance: 280 checks PASS,
including actual admitted HTTP policy saves, project inheritance, no extra ask,
single dispatch with separate receipt, rejection of caller-forged settings and
unsupported deletion, and restoration of required approval before sending.
Processing commands and memory writes use isolated stubs/fixtures in tests.
Candidate rollback/reapply and visible startup PASS.

Full suite: 1105 PASS, 3 transient Windows process-query errors, 1 obsolete skip.
Two installer files rechecked sequentially: 32 PASS, 2 transient process-query
errors. All five cases affected across these runs subsequently passed together
in a focused run (5/5). No failure was in a changed memory test; the live installer
still uses the unchanged fail-closed process guard. Test evidence is retained in
ignored var/git-maintenance logs; no production process check was bypassed.

## Installed acceptance

Promoted policy 0.17.2-approval1 with receipt
`var/live-promotion-backups/release-20261111-approval0172/receipt.json`.
60 packages, 61 owned after-states, zero drift. The installed memory client,
policy/workspace, tools and processing modules match tested source bytes.
Six fingerprints covering saved memory preferences and BL MCP/Codex settings
were unchanged. No memory preference was disabled automatically.

The real Desktop restarted and its Memory page visibly displayed both selectors:
recipient default required, project inherit, separate Save buttons and the deletion
exception. No live preference was saved, note uploaded, processing job triggered,
model API called or real deployment run during this UI acceptance.
