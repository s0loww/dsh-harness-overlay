# UI dev16 / policy dev37: canonical airules and acceptance

Date: 2026-11-07. Installed host: official Desktop 0.2.1-rc.5.

The embedded rulepack was rebuilt from clean canonical airules commit
`243ce44d14b804c8eb1ac882d56cbb9c8eb8184f` as `0.12.0-g243ce44`:
55 rules, 13 roles, 48 skills, 360 files. DSH consumes the shared canonical
methodology. Native Codex lifecycle files remain in the Codex target.

Project instructions and explicit local exceptions take precedence over
overridable embedded defaults. Native permissions remain authoritative.
Project skills override bundled skills with the same name. The embedded
`airules_rule` tool still reads its verified package: a same-name project rule
does not silently replace it; the agent must read and resolve that exception.

## Verified release evidence

| Check | Result |
| --- | --- |
| Final source unit/integration suite including live-host guards and oracle mutations | 503 passed, zero skipped |
| Native candidate integration | 341 passed |
| Isolated BL source mechanics | 34 passed; overall PARTIAL, model orchestration not exercised by this mechanical probe |
| Candidate apply / rollback / reapply | Passed on official-desktop-rc5-24 |
| Candidate visible startup | Passed |
| Installed profile promotion | 46 operations, zero drift, no cleanup pending |
| Official immutable baseline | 5/5 unchanged |
| Installed Desktop startup | Observed loaded workspace, chat and composer after restart |

Local evidence, intentionally excluded from Git:

- `var/dsh-g243ce44-tests.log`
- `var/live-matrix-final-tests.log`
- `var/dsh-g243ce44-native.log`
- `var/candidate/official-desktop-rc5-24/smoke/wave2-native-summary.json`
- `var/project-acceptance/run-e5e60e8c-50df-4959-9723-9f13a6f66503/summary.json`
- `var/live-promotion-backups/release-20261107-airules243ce44-policy37/receipt.json`
- `var/airules243ce44-live-verification.json`

The BL mechanics probe copied one bounded source module and changed only two
comment spacing markers in the copy. Real BSL LS diagnostics fell from three
to one; the original hash remained unchanged. The remaining diagnostic, BOM
lexer warning and JVM compatibility warning are retained. This is not a
platform syntax check or business/project certification.

The known baseline composer-history 0.7.2 incompatibility remains visible;
its version guard was not bypassed.

## Expanded live-model acceptance

The user authorized four independent runs: DeepSeek Flash 4.1 High and
Sol 6.1 Medium, each without MCP and with read-only MCP. Each run must use a
fresh isolated source copy and a fresh session, real native delegation to
developer and tester, and evidence of the children's actual model and effort.
The tester must inspect the on-disk result and execute the bounded lint tool.
The MCP runs additionally require a real admitted tool call from the parent
and at least one subagent. The no-MCP runs must expose no MCP tools.

All four provider/MCP combinations completed real generation, native developer
and tester execution, actual local lint and preserved original-source hashes.
The MCP cases confirmed direct documentation calls from the parent and child.
The requested High/Medium settings were confirmed in actual native request
headers. These live runs are separate from the 503 offline tests above.

Full acceptance is not green: the native filesystem editor strips the copied
module's UTF-8 BOM. The strict first report remains FAIL; later expanded reports
are PARTIAL only when all functional checks pass. A repeat of the first case
uses the final event-order criteria; the original report remains unchanged.
See [live evidence](live-model-acceptance.md) and the
[native BOM finding](native-utf8-bom-finding.md).

No real deployment, database changes, original project writes or external
messages were performed. The official filesystem backend was not patched.

## Reproducible source inputs

The maintained overlay source is archived in the private repository
`s0loww/dsh-harness-overlay`, initially at `1c4a186`.
Supplied runtime components remain explicit external inputs. Policy staging
requires `--source-bundle` or `AIRULES_DSH_SOURCE_BUNDLE`; no workstation-specific
fallback remains. See [build prerequisites](BUILD-PREREQUISITES.md).
