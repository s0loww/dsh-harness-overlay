# UI dev16 / policy39: preserve BOM in native edit

Date: 2026-11-07. Official host: 0.2.1-rc.5. Canonical rulepack remains
`0.12.0-g243ce44` from clean airules source.

The native filesystem decoder consumes the original UTF-8 BOM. The repair
remembers that flag next to the existing line-ending metadata and restores it
inside native atomic edit writeback. Read presentation, lock scope, version
checks, native sandbox fences and deliberate whole-file write semantics are
unchanged. There is no after-the-fact file repair or tool-result rewrite.

The managed `airules-dsh-native-fs` package contains the pinned native sandbox
class and the patched local superclass. Only the sandbox import changes.
Both upstream MIT licenses are retained. The seven-package Windows x64 closure
is hash-locked, including the existing Koffi platform binary; staging downloads
nothing and rejects other source versions or module hashes.

## Native composition

Cordis id-targeted `name` is an assertion rather than a replacement. Rejected
development artifact policy38 attempted a name override; actual-service
attestation caught the unchanged backend before any model request. It was
rolled back on the candidate and was never promoted.

Policy39 uses native supported composition: disable the asserted original
`fs-sandbox` row and insert exactly one managed sandbox provider. Tests exercise
the public native `composeEntries` API, verify one active provider, preserve
user configuration/comments and refuse conflicting filesystem overrides.

The official ASAR and all five immutable baseline files remain unchanged.
Installation uses the existing transactional profile installer and receipt.

## Verification

- Full offline suite: 527/527 passed, zero skips.
- Native integration: 341/341 passed on candidate24 upgraded from policy37.
- Candidate25 policy39 install / rollback / reapply: passed.
- Candidate24 visible startup: passed.
- Runtime attestation: actual native sandbox service identity, patched local
  superclass identity and both module SHA-256 values match the policy payload.
- All four real model/MCP scenarios: full strict PASS.
- Installed profile: policy39 applied, receipt integrity valid, 47 operations,
  zero drift, zero cleanup pending. Desktop startup observed after restart.

| Model | MCP | Requests | Seconds | Children | Result |
| --- | --- | ---: | ---: | ---: | --- |
| Flash 4.1 High | absent | 16 | 64.785 | 2 | PASS |
| Flash 4.1 High | direct docs | 16 | 77.967 | 2 | PASS |
| Sol 6.1 Medium | absent | 18 | 117.715 | 2 | PASS |
| Sol 6.1 Medium | direct docs | 19 | 120.494 | 2 | PASS |

Each copied file retains its original BOM and all CRLFs: 340 bytes become
exactly 342 after adding the two requested spaces. All original source hashes
remain unchanged. Native developer and tester complete in order with the
requested model/effort and inherited workspace boundary. The tester's actual
lint hash matches the final file; diagnostics change from three to one as
specified. The MCP cases have successful parent and child documentation calls.
Totals: 69 real requests, eight completed native children and five docs calls.
Each Sol case has one correctly denied read; there is no successful boundary
escape or extra source mutation.

The previous FAIL/PARTIAL reports remain unchanged. The post-fix evidence and
individual run paths are in [live model acceptance](live-model-acceptance.md).
Neither the strict oracle nor the scenario was weakened to obtain PASS.

Local evidence (not committed): `var/native-bom-final-tests.log`,
`var/native-bom-wave2-tests.log`, `var/candidate/official-desktop-rc5-24/smoke/`,
and candidate25 cycle report
`.airules-cycle-history/2026-11-07T14-49-05-916Z-61fec2dd-987f-4ca4-98c5-abc9589d727c/cycle-report.json`.
Installed receipt:
`var/live-promotion-backups/release-20261107-native-bom-policy39/receipt.json`;
post-apply verification: `var/native-bom-live-verification.json`.

The bounded live scenario is separate from project business certification.
It keeps the expected unresolved lint diagnostic and existing parser/JVM
warning categories visible. No deployment, COM or database operation is part
of this release's acceptance.
