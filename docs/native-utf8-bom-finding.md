# Native edit loses UTF-8 BOM

Observed during real model acceptance on 2026-11-07. Repaired and installed
in [policy39](native-bom-release.md), with four full strict live PASS results.
The reproduction and historical failure evidence below remain unchanged.

Target: `@deepseek-ai/dsh-fs-local@0.2.1-rc.5`. Inspected `lib/index.js` SHA-256:
`63fbb41d2c33e07111884b798be507e68c2752acab8249c821c20ade436e894f`.

## Reproduction and impact

A copied 340-byte UTF-8 BOM module contains five CRLF line endings. Two
comment-spacing fixes should add two spaces and produce 342 bytes. Native
`edit` produces 339 bytes: the original three-byte BOM disappears. Restoring
only that BOM gives exactly the expected result, with all CRLFs unchanged.
The real source project remains unchanged.

The native decoder uses `TextDecoder` with its default BOM handling.
`readForEdit` retains line-ending metadata but no BOM flag; `editText` restores
line endings and atomically writes the decoded text, losing the BOM. The loss
is independent of the chosen model. Whole-file `write` writes the provided
string verbatim; a native read followed by a model-generated whole-file write
can therefore also lose the original BOM unless explicitly supplied.

## Acceptance treatment

The original first-run report retains its strict byte-comparison failure.
Later reports expose `exactCommentChanges: false`,
`semanticCommentChanges: true`, and `encodingDelta: bom-removed`. They can be
PARTIAL only when every separate functional check passes. BOM normalization
never counts as full PASS, and other content or line-ending drift remains FAIL.

## Implemented repair boundary

The managed compatibility patch preserves a BOM flag in `readForEdit` and
restores the original BOM during `editText` writeback. Model-facing text,
observations, version checks, native locks, sandbox admission and atomic
replacement remain intact. Deliberate whole-file write semantics are unchanged.

The version- and hash-guarded package passed candidate apply/rollback/reapply
and was promoted through the transactional profile installer. Official ASAR
bytes were not modified. There is no tool-result rewriting or post-call file
repair. Regression cases cover BOM/no-BOM, LF/CRLF, repeated edits without
extra BOMs, expected-version conflicts and sandbox refusals.
