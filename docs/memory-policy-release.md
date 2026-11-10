# Persistent memory policy and remaining donor candidates

Release: rulepack 0.15.0, official Desktop 0.2.2-rc.1. Runtime acceptance and installed receipt are recorded below after verification.

## Delivered behavior

- Memory selection is a global preference: Cognee, Memoria, or both. A project's `.dsh/memory.json` can inherit or override it; all conversations in that project use the same preference. An open conversation is only the native execution context for project operations, not the owner of the preference. Global preferences and model/key settings remain available without a usable chat.
- Both-store recall retains each backend's provenance, IDs and separate availability. Missing Memoria or an unavailable Cognee is a partial result, never an empty successful search. Scores are not combined. `auto` writes facts/handoffs to Memoria and documents to Cognee when both are selected. An explicit saved write destination is enforced; a call cannot silently bypass it. Explicit double writes keep separate durable receipts, stop after unknown outcomes, and never retry successful destinations.
- Memoria uses a project-selected namespace and typed mappings to registered native MCP schemas. No facade is required and no server credentials are copied. Managed memory MCP calls go through the router and native permission/tool pipeline. The configured schemas alone do not certify a working server.
- Cognee embedding and relationship-extraction models are independent. Supported choices: installed FastEmbed/GLiNER; Ollama or LM Studio; OpenRouter. Local catalogue rows describe installed/loaded/cached state and actual embedding width. OpenRouter discovery is public metadata only. Saving preferences does not start a model, restart Docker or make an inference request.
- Applying a saved profile uses a full-access native lead, approval, fixed local Docker commands, private backups and a machine binding. Keys use DSH's native credential store and a private server environment; they never enter conversation messages, receipts or configuration responses. Recall/processing require an attested applied profile. Changing embedding models while data exists requires a separate reindex operation; existing datasets are never deleted or mixed automatically.
- Reviewed facts can publish to explicitly chosen Cognee or Memoria through the same router. Genuine user approval, configuration/policy revision checks and unknown-outcome receipts remain. Procedures and rules belong to airules and are not automatically rewritten or published as memory facts.

## Remaining candidates: disposition

| Candidate | Result |
|---|---|
| History recall | Already integrated: bounded original-event search/read with source IDs. |
| Compaction recovery | Already integrated: canonical continuity contract plus native restore and provenance. |
| Reviewed knowledge | Integrated, now also supports typed Memoria publication and persistent memory policy. |
| Skill evaluation | Already integrated: isolated active/previous/no-skill comparison and fixture reports. |
| Evidence links | Added `airules_links`: project ledger linking task/file/test evidence, native FS/CAS, hashes and stale state. References only; no duplicate semantic index. |
| Vision fallback | Added explicit `airules_describe_image`: separately selected image-capable native model, exact images, native approval and bounded one-shot request. Disabled by default. Main conversation model is unchanged. |
| Keep awake | Added optional task-scoped inhibitor; released when work ends or the plugin is unloaded. Disabled by default; no power-plan changes. |
| Rewind/checkpoints | Existing installed `dsh-rewind-plugin` 0.19.2 owns this area. Donor implementation was compared and not duplicated; see the separate audit. |
| State backup | Settings/rules export is a possible separate future feature; donor workspace/session restore is not imported over the existing Rewind owner. Installer rollback receipts continue to cover the owned installation. |
| PII masking | Separate compatibility/privacy decision, not enabled as part of this release. |

Assistant DSH, voice, Atlassian/Jira, donor support/updater and Live2D remain excluded. Transferable memory routing, reviewed lessons, evidence links and vision procedures were adapted into canonical airules 0.15.0 (commit 72ed6f6).

## Acceptance boundaries

Native SDK and mounted-release acceptance use isolated projects and synthetic memory tools/providers. Real deployment is forbidden. No paid inference is needed for installation acceptance. Live Memoria connectivity requires a real project binding; no automatic account migration is attempted. Reindexing existing embeddings is intentionally a separate operation.


## Release evidence

- UI `0.15.0-host022-ui1`, policy `0.15.0-dev6`; canonical rulepack `0.15.0`, commit `72ed6f6`, 55 rules / 13 roles / 53 skills.
- Full source suite: 944 passed, zero failures; one obsolete pre-upgrade-only live migration test skipped. Final runtime-panel mount/render/styling regression: 12/12 passed. Canonical rulepack/Codex/DSH tests: 24/24 passed and layer check passed.
- Mounted installed-byte SDK022 acceptance: 166 checks; isolated fake MCP preserves native parent/token, typed namespace, policy gates and durable receipts. No real memory backend writes in that probe.
- Candidate rollback/reapply and visible Electron startup passed. The synthetic compaction fixture now emits valid start/summary/end metadata and restores in Electron.
- Real native Windows sleep inhibitor remained alive until release, exited with code 0 and left no managed processes. No power-plan changes.
- Installed Cognee authenticated status and both cached local model catalogues were checked through the actual settings UI. The server profile is observed and matches selected FastEmbed / GLiNER models. No paid inference or real deployment.
- Installed receipt: `var/live-promotion-backups/release-20261111-memory015-polish/receipt.json` (chains to `release-20261111-memory015`, then the previous 0.14 release). Machine processing binding is private outside the package, and contains no credentials. Existing connection configuration is unchanged.
- Global preference was saved as Cognee to preserve the existing choice. Project_BL continues inheriting it; acceptance did not change its project files. Memoria mapping and an OpenRouter key require actual recipient/project configuration; neither is inferred from unrelated accounts.

- Final live UI acceptance: global Cognee/Memoria/both options, unchanged Cognee preference save, authenticated Cognee status, both installed local model catalogues and matching server profile passed. The final “Работа и изображения” panel was inspected after restart: theme controls, vertical fields, Russian idle state and both features disabled. Public OpenRouter metadata discovery returned 40 embedding and 450 text-model entries without credentials or inference.
- Final installed integrity verification passed: 57 owned after-states, zero drift, original Cognee connection configuration preserved, 11 existing synthetic memory rows and no active processing jobs.
