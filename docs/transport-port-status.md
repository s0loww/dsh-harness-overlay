# Desktop integration rollout

Current installed release: [UI dev16 / policy dev37 — canonical airules and acceptance](airules-g243ce44-release.md).
Clean canonical source `243ce44`, explicit source-bundle input, project priority
contract and OpenAI native-runtime acceptance. 503 source tests and 341 native
checks passed; installed receipt has zero drift. Four live-model/MCP scenarios
completed functional checks; strict acceptance exposes native UTF-8 BOM loss.
Their separate evidence retains FAIL/PARTIAL rather than claiming full PASS.

Previous installed release: [UI dev16 / policy dev36 — wave 2 skills and local tools](wave2-skills-release.md).
26 additional skills, real local document/Office and Mermaid backends, opt-in
Caveman and 1C capability/investigation workflows. 481 source tests, 341 final
native checks, browser QA and 46-operation live receipt verified.

Previous installed release: [UI dev15 / policy dev31 — canonical skills](canonical-skills-release.md).
Five generic and three 1C testing skills are adapted in canonical airules and
installed; Python/Sysadmin share only the generic subset. 456 overlay tests,
300 native checks, 13 canonical checks and 10 offline procedural cases completed.

Previous installed release: [UI dev15 / policy dev29 — skill assignments](skill-assignments-release.md).
Task/role/native-access catalogue assignments, defaults and common/project overrides
are installed. 450 overlay tests, 107 native assignment checks and 45 import checks pass.
Supplier skill inventory is [available separately](oleg-skills-inventory.md); later adaptations are tracked by the current release above.

Previous installed release: [UI dev15 / policy dev27 — agent import and skills](import-skills-release.md).
Selective instruction/skill import and native skill management are installed.
436 overlay tests and 45 native checks pass; accounts and project bindings preserved.

Previous installed release: [UI dev14 / policy dev25 — complete workflow controls](workflow-complete-release.md).
Scenario selection, project save, persistent executor mode, server/file targets and
proof-based recovery are installed; all execution checks used isolated stubs.

Previous installed release: [UI dev14 / policy dev21 — deploy executor](deploy-executor-release.md).
Invocation-bound application reports, native process execution and target locks;
fixture-only installed. Seven real native fixture scenarios pass; no real deployment.

Previous installed release: [UI dev14 / policy dev19 — workflow setup repair](workflow-setup-release.md).
Read-only discovery/configuration wizard, truthful step readiness and actionable
blocking reasons. Real deploy execution remains unimplemented, not user-toggleable.

Previous installed release: [UI dev14 / policy dev17 — native workflows](workflow-native-release.md).
Native rights/sandbox, settings UI and project-runner adapters are installed.
297 overlay tests and 88 canonical tests pass. Actual deployment remains disabled.

Earlier workflow increment: [core and CLI](workflow-core-increment1.md).

Checks/deploy analysis (2026-11-04): [comparison and proposed port plan](checks-deploy-port-plan.md).
Oleg, Ecuador, KA2 and BL source audits completed; canonical ADR/contract proposed.
Historical analysis stage: no executor enabled or database operation performed.

Previous installed release: [UI dev13 / policy dev15](items-2-4-release.md),
237/237 checks passed; 1C environment, role bindings/rotation and Python/Sysadmin
presets are installed. Earlier sections below are retained historical evidence.

Current: [UI dev12 — native reasoning menu](reasoning-menu-ui12.md), policy
dev13. 206/206 checks passed; live effort switching confirmed by the user.

Latest: [UI dev10 API catalog fix](api-catalog-ui10.md) installed; 201/201 tests
passed, catalogue loading confirmed in live UI and by the user. Account and
model settings are preserved through guarded update.

Current update: **UI dev9 / policy dev13** is installed. See
[settings and runtime fixes](settings-release-dev13.md) for the current receipt,
192 passed checks, grouped settings, unified providers, project settings and
the HTTP 405/Kimi/balance fixes. The following retains dev12 evidence.

Date: 2026-11-04. Official host: `0.2.1-rc.5`; UI: `0.1.0-dev5`.
Final candidate policy: `0.12.0-dev12` (16 packages, 4961 files).

Installed in the official live profile. Automated suite: **172/172 passed**.
The official host still verifies against all five immutable baseline files.
Live receipt: `var/live-promotion-backups/release-20261104-next-dev12/receipt.json`.
Post-apply verification: 34 owned targets, zero drift, no pending cleanup.
Live startup is successful. Further UI inspection was stopped when user input
was detected; interactive Kimi login and the BKI metadata sidebar remain to be
checked with the user. The native sandbox mode contract was verified in the
pinned host source; XML/EDT/form extraction is covered by local tests.

Candidate `official-desktop-rc5-07` passes visible startup and complete
rollback/reapply; report:
`.airules-cycle-history/2026-11-04T08-45-41-400Z-b937108d-a3b9-429d-93fd-80cc49fdea40/cycle-report.json`.
Live UI shows Telegram, mobile access, Subscriptions and standalone MCP Manager
settings. MCP Manager rendered its empty configured-server list. Further UI
input was left to the user after their activity was detected in the window.
ACP inbound controls live under General; the native outbound adapter is
configured through its installed-plugin configuration panel.

## Feature boundary

| Feature | Ported behavior | User configuration |
| --- | --- | --- |
| Telegram | settings, protected token, one private owner, exact session restore, menus, files, follow-up, questions and one-time tool approvals | enter a dedicated bot token and numeric owner ID locally, then connect |
| ACP inbound | authenticated local pipe, current-user endpoint, native DSH sessions, independent autostart | explicitly enable and copy the generated client configuration |
| ACP outbound | native adapter settings, external models, Team, native permission policy | absolute installed adapter executable and args; no agents preconfigured |
| Subscriptions | Codex/Claude/Grok/Copilot accounts, defaults, catalogs, usage, reasoning/context, model visibility and same-provider pools | manual provider login; explicit-only Claude Code import |
| Mobile | HTTPS LAN/VPN relay, password, QR, port, pairing, revoke, stop and autostart | set password and explicitly enable; no listener by default |
| MCP Manager | independent machine configuration, native settings and hot reconnect | separately configured machine servers; project bindings stay external |
| Kimi | native PiAiAdapter, isolated OAuth and model catalog | explicit login in Additional providers; no boot-time login or account import |
| 1C inspector | selected-session local XML/EDT inventory, BSL paths, XML form elements/events | open Metadata 1C in the right sidebar of a 1c-airules session |

MCP Manager's actual separate store is `<DSH_HOME>/airules-mcp-servers.json`.
Its labels are now localized through the official locale API. The introductory
text points to this separate store and explains native admission plus CSRF.

No authentication data, bot tokens, endpoints, histories or user MCP bindings
are copied from the supplier profile. The optional listeners and Telegram
polling start only after explicit user configuration. Account login, real
Telegram delivery, paid model requests and phone LAN login are separate live
checks after configuration.

## Remaining scope

The supplier's remaining GLM/Qwen/OpenCode/Google/Muse/Cursor adapters
need individual review. Kimi is installed; real OAuth and generation remain
unverified until user login. Expanded 1C graph/long-operation panels and additional
editor conveniences remain separate work. 1C verification/deploy mechanics
are deferred until compared with the actual project deployment methods.

Assistant DSH, voice/OpenWhispr, Atlassian/Jira, supplier support/updater and
Live2D are excluded by the user. Captain Diesel and our guarded installer
remain in use.

## Operational constraints

Outbound ACP requires native BUILD and Native Agent Access: an external
executor cannot enforce the parent filesystem sandbox. This port never raises
the permission mode. Its human approval default is `ask`; executables are
explicit installed paths, with no automatic npm/npx/bootstrap.

Mobile access is for the trusted owner of this Desktop. Its direct URL filter
blocks the local integration administration endpoints. The transparent native
remote-mux transport retains the running Desktop's own privileges; the relay
does not promise to inspect individual RPC payloads. Firewall and certificate
trust settings are not changed.

The transport ports retain upstream license files and source provenance.
The supplied Telegram LICENSE differs from its metadata declaration, and some
standalone supplier modules lack a full copyright notice. Those details must
be clarified before an external distribution is published.

## Rebuild and recovery

Final policy staging opts into every selected integration explicitly:

```powershell
node scripts/stage-official-policy.mjs `
  --rulepack "D:\AI_Projects\project_rules\var\rulepack\airules-0.12.0-dev8" `
  --output "D:\AI_Projects\dsh_harness_overlay\dist\airules-official-policy-<new-version>" `
  --artifact-version <new-version> `
  --include-telegram true --include-acp true --include-subscriptions true `
  --include-mobile true --include-mcp-manager true `
  --include-additional-providers true --include-onec-panels true
```

The final artifact does not overwrite dev9/dev10; those remain development
evidence. The mobile denylist explicitly includes both `/airules/*` and the
separate `/airules-subscriptions-auth` channel plus `/mcp-manager`.

Installer migrations recognize only the fixed owned integration IDs. A foreign
neighbour or duplicate ID still blocks replacement. Apply/rollback now checks
that every process of the exact official executable is stopped, including tray
and background processes, before modifying profile files.

Rollback always needs the explicit matching `--policy-artifact` and receipt;
CLI defaults retain earlier minimal versions for legacy recovery.

Candidate06 was retained as diagnostic evidence: UI model selection changed
its Cordis file between applies. The rollback guard correctly stopped rather
than discarding that change. Candidate07 certifies dev12 without intervening
settings writes; do not reuse a rollback chain after interactive profile edits.
