# Native edit loses UTF-8 BOM

Observed during real model acceptance on 2026-11-07. This is an open native
filesystem finding, not a repaired or installed compatibility patch.

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

## Proposed repair boundary

Preserve a BOM flag in `readForEdit`, then restore the original BOM during
`editText` writeback. Keep model-facing text, observations, version checks,
native locks, sandbox admission and atomic replacement intact. A deliberate
whole-file write needs its own explicit encoding contract.

Ship any repair as a version- and hash-guarded compatibility patch with
candidate apply/rollback evidence. Do not edit the official installation in
place, rewrite tool results, or repair files after a successful tool call.
Regression cases must cover BOM/no-BOM, LF/CRLF, duplicate-BOM prevention,
expected-version conflicts and sandbox refusals.
