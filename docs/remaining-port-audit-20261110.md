# Remaining donor ports after UI22 / policy41

Status update 2026-11-11: memory policy/model profiles, history, continuity,
reviewed knowledge, skill evaluation, evidence links and runtime utilities now
have implementations. See [current release](memory-policy-release.md) and the
[installed Rewind comparison](checkpoint-rewind-audit-20261111.md). The text below
is the original audit baseline; its uncompleted-status statements are historical.

Read-only audit dated 2026-11-10. Baseline: `specialized-components-release.md`.
Donor source: the user's `DSH-Desktop-1C-0.1.0` release, package `dsh-1c-bundle`.
This audit does not execute donor services, migrate state or certify live accounts.

The main uncompleted feature is project memory: Cognee connector/workspace and its
relation to the recipient's existing Memora. The prior implementation audit is
`oleg-cognee-memory-audit.md`. Local deployment and integration are separate work.

## Useful next candidates

| Priority | Donor source | Value and adaptation boundary |
|---|---|---|
| 1 | `lib/history-recall.js:64,171` | Bounded `history_search/history_read` over original current-chat events with IDs; excludes reasoning and recursive recall. A source evidence tool, separate from persistent memory. |
| 1 | `lib/context-restore.js:20,63,71`, `recent-file-context.js`, `skill-continuity.js` | Adapt our existing airules rule/orchestration/session-map reminders and BL PreCompact snapshot to native DSH events; add bounded lost-file/instruction/job/artifact restoration from the donor. Verified `session.surface.nodes` exists in pinned rc.5; the removed API was `session.nodes`. See `context-continuity-comparison.md`. |
| 2 | `lib/knowledge.js:278,515,519`, `knowledge-core.js:13` | Draft/review/approve lifecycle, provenance, applicability and stale/superseded knowledge. Reuse UX over the chosen memory owner; avoid adding a third independent `.ai-rules/knowledge` store or bypassing reviewed rule changes. |
| 2 | `lib/skill-eval-core.js`, `skill-eval-runner.js:53` | Compare active/previous/no-skill on two or three tasks with tool/read traces. Portable method is useful for airules. Rework execution isolation: donor runner inherits ambient env and host DSH_HOME; temporary LOCALAPPDATA alone does not isolate projects/accounts. |
| 3 | `lib/vision-fallback.js:13` | Explicit image-capable model describes screenshots for a text model. Preserve selected model, image permission and cost evidence; do not inherit provider-specific prohibitions. |
| 3 | `lib/keep-awake.js:13,39` | Holds sleep inhibitor only while work is active and releases it afterwards. Small optional convenience, not a system sleep-settings rewrite. |
| Separate choice | `lib/pii-privacy.js:184,188,226`, `vendor/ru-pii-core` | Local model-bound text masking; changes attachment and external-agent behavior. Evaluate compatibility and user requirements before enabling; not part of installing memory. |

These custom runtime tools were not found in the overlay's owned source/staging
configuration during this audit. Native host features may overlap; inspect them
before adding an implementation or second orchestration owner.

## Secondary operations to assess

Donor `dsh-checkpoint-rewind` and `lib/state-backup.js:171,189` are not in our UI
package set. Checkpoint/rewind is workspace/session runtime recovery; installer
receipts solve a different problem. The donor state backup excludes credentials
and session storage, and does not restore conversation history. Do not present it
as a complete DSH backup or enable a destructive rewind without its own review.

## Already ported or intentionally bounded

Telegram/mobile/ACP, provider settings, OpenSpec, imports/skills, documents/Office,
role routing/rotation, repository/AI-merge/v8unpack and native jobs/code-graph
panels already have implementations and release evidence. Remaining live runtime
acceptance is verification work, not an unported feature. AI-merge intentionally
covers source comparison/CFE planning, not donor metadata/support parsing or
automatic platform application; see `onec-specialized-port.md`.

Assistant DSH, voice, Atlassian/Jira, donor support/updater and Live2D remain
excluded. No real deployment is authorized by this audit.
