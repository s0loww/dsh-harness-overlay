# DSH official Desktop overlay — release report

Date: 2026-11-11
Target: DeepSeek Harness Desktop `0.2.2-rc.1`

Current release: [Project-owned settings and shared native project context](project-bindings-release.md).
UI `0.16.0-host022-ui1`, policy `0.16.0-dev4`, canonical airules `82c10a4` / 0.16.0.
984 source tests passed (one packaging network failure passed on the complete 5-test retry),
one obsolete pre-upgrade test skipped; native mounted candidate acceptance passed 195 checks.
Candidate rollback/reapply and visible startup passed. No paid model request or real deployment.

Previous release: [Persistent memory policy and remaining candidates](memory-policy-release.md),
UI `0.15.0-host022-ui1` / policy `0.15.0-dev6`, canonical `72ed6f6` / 0.15.0.

Previous release: [Memory panel, original history and reviewed lessons](memory-improvements-release.md),
UI 0.14.0-host022-ui1 / policy 0.14.0-dev3.

Previous host upgrade: [DSH 0.2.2 / UI5 / policy50 — continuity and local memory](host022-continuity-release.md).
Official signed NSIS completed, Windows registration and uninstaller verified.
774 source tests passed before install; finalizer regression 14/14 and the
four live model routes passed (62 requests). Native mounted continuity,
Cognee connection, visible installed UI and 55 owned after-states pass.
Canonical airules d563128: 55 rules, 13 roles, 53 skills. User conversations,
MCP configuration and appearance preserved; only conflicting legacy RU
autoload disabled with a backup. No real 1C deployment.

Previous memory release: [UI23 / policy43](memory-workspace-release.md).

Previous release: [UI22 / policy41 — specialized components](specialized-components-release.md).
628 source tests, 73 native checks, actual browser/Ctrl+R, candidate cycle and
installed Desktop restart pass. Receipt integrity and 50 after-states verified;
no real deployment or new paid model calls. Canonical airules g247add5 contains
55 rules, 13 roles and 52 DSH skills.

Previous release: [UI dev16 / policy dev39 — native BOM fix](native-bom-release.md).
Four actual model/MCP scenarios passed on that version.

Previous release: [UI dev16 / policy dev36 — wave 2 skills and local tools](wave2-skills-release.md).
26 skills added: 48 in 1C, 18 shared across custom presets. Real local document/Office
and Mermaid execution, session Caveman control and capability/investigation tools.
481 source tests and 341 final native checks pass; browser and live receipt verified.
No real 1C/MCP/project runner/deployment or Telegram message was executed.

Previous release: [UI dev15 / policy dev31 — canonical skills](canonical-skills-release.md).
The accepted eight-skill set is canonical in project_rules, rendered into Claude
and DSH, and available in scoped DSH compositions. 456 overlay tests and 300
native checks pass; independent offline cases and canonical gates are recorded.

Previous release: [UI dev15 / policy dev29 — skill assignments](skill-assignments-release.md).
Assignments adapt 13 task types and 13 managed roles to the native catalogue.
450 overlay tests and 152 native assignment/import checks pass; direct skill access,
SKILL.md policies and sandbox permissions are preserved.

Previous release: [UI dev15 / policy dev27 — agent import and skills](import-skills-release.md).
436 overlay tests and 45 native checks pass. Import preview/apply and real native
skill availability controls are installed; no model, MCP or deployment calls.

Previous release: [UI dev14 / policy dev25 — complete workflow controls](workflow-complete-release.md).
410 overlay tests and 112 canonical tests pass. Scenario save, persistent mode,
file/server targets and recovery are implemented; no real deployment was run.

Previous release: [UI dev14 / policy dev21 — deploy executor](deploy-executor-release.md).
Native deploy execution is implemented and verified on stubs; fixture-only is installed.

Previous release: [UI dev14 / policy dev19 — workflow setup repair](workflow-setup-release.md).
Discovery and configuration preparation are available; deploy execution remains unimplemented.

Previous release: [UI dev14 / policy dev17 — native workflow integration](workflow-native-release.md).
Native permissions/sandbox, workflow UI and project-runner adapters are installed;
297 overlay tests and 88 canonical tests pass. Real deployment remains disabled.

Previous release: [UI dev13 / policy dev15 — items 2–4](items-2-4-release.md).

Earlier evidence: [native reasoning selection](reasoning-menu-ui12.md),
[API catalogue](api-catalog-ui10.md), [settings](settings-release-dev13.md).

Update: Telegram, ACP, subscriptions, mobile access and standalone MCP Manager
plus Kimi and the local 1C inspector are installed with policy dev12. See [the current integration report](transport-port-status.md)
for its receipt and 172-test result. [The OpenSpec report](openspec-release-dev8.md)
retains its live BKI smoke. The sections below retain the initial dev7 evidence.

## Installed result

- UI artifact: `airules-ui-overlay-0.1.0-dev5`.
- Policy artifact: `airules-official-policy-0.12.0-dev7`.
- Default visible preset: `1С` (`1c-airules`).
- Embedded policy: 55 rules, 13 roles and 12 skills.
- Russian locale: 216 namespaces and 24,320 strings.
- MCP endpoints, credentials and project bindings are not embedded.
- The signed application installation was not patched; the overlay is installed
  into the guarded Desktop profile.

## Verification

- Official installation baseline verified: 5 immutable files.
- Automated suite: 110 passed, 0 failed.
- Candidate preflight: 28 packages and 52 unique Cordis IDs.
- Hidden startup, visible startup and full apply/rollback/reapply cycle passed.
- Live UI smoke passed for a new session, preset `1С`, Plugins, Russian timer UI,
  balance HUD degraded mode and Captain Diesel.

Candidate evidence:

- `var/candidate/official-desktop-rc5-03/.airules-cycle-history/2026-11-04T01-53-34-995Z-e1f2d3a3-d619-47cd-a2ec-1a33e7959fb2/cycle-report.json`
- `var/candidate/official-desktop-rc5-04/smoke/launch-report.json`

## Recovery

Live receipt:

`var/live-promotion-backups/release-20261104-0200/receipt.json`

The live rollback command is intentionally acknowledgement-gated. Review the
receipt and use `installer/official-live/rollback.mjs` as documented in
`installer/official-live/README.md`. Rollback verifies every owned after-state
before writing and restores the profile from the receipt-bound backup.

## Known limitation

The native Electron `Application` / `Edit` menu and some third-party
experimental plugin descriptions remain English. They are not exposed through
the official locale provider, and the signed host bundle is intentionally not
monkeypatched.
