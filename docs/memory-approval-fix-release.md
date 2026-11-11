# Memory approval ordering and BL rule update

Date: 2026-11-11. Target host: official Desktop 0.2.2-rc.1.
Policy candidate: 0.17.1-memory1; UI stays 0.17.0-host022-ui1.

## BL rules

Updated the eight reviewed rules from canonical 0.16.0 / 82c10a4. All 55 rule
hashes and all 55 contract index links pass. AGENTS.md stays byte-exact.
The backup contains the prior manifest and 473 original project/rule/config files.
Eight rules changed; the other 465 protected files, including settings and MCP,
remain byte-exact. The two pre-existing local edits remain intact. Source version
is recorded as 0.16.0, with a separate project_rulepack inventory for rules/;
DSH ownership of AGENTS.md was not granted. Existing legacy inventory is retained.
No new skills, hooks or project code were installed, and no deployment occurred.

## Memory bug

The native approval gate is authoritative and remains required. Full filesystem
access does not turn approval policy never into a grant. The defect is routing
claim before Cognee authorization: a pre-dispatch refusal was persisted as an
unknown backend outcome, blocking a subsequent retry of the same note.

The fix must authorize before claiming a persistent write, retain exact execution
and destination binding, prevent duplicate approval grants, and keep real
post-dispatch uncertainty non-retryable. No live user note is re-sent as a test.

## Installed verification

1086 source tests passed, one obsolete test skipped; memory suite 141/141.
The actual installed-package candidate passed 274 native checks, rollback/reapply
and visible startup. Promoted policy 0.17.1-memory1 with 60 packages and 61 owned
after-states, zero drift. The three installed memory modules match tested source
bytes. The real Desktop restarted with its existing conversations intact.

Only the original rejected operation was recovered while Desktop was stopped.
Durable native session evidence linked the first remember call to rejected
approval and its exact result; the content-derived operation ID and the installed
reject-before-client code hash matched. The entire routing journal and sanitized
evidence were backed up, one entry removed by CAS, all other entries preserved.
No note was retried and native approval policy was unchanged. Under never,
future memory writes still fail approval; they no longer poison the routing journal.

Live installer receipt: `var/live-promotion-backups/release-20261111-memory0171/receipt.json`.
BL rule backup: `.rules-backups/rules-update-0.16.0-20261111T024252Z-4cc87e612f47424391ae5f2027ee7ea5/`.
Private recovery evidence and journal backup remain machine-local and are not committed.
