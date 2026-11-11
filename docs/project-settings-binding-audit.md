# Project ownership of settings — audit 2026-11-11

The user requested project selection instead of selecting individual conversations in settings. This audit separates durable ownership from native execution context. A project choice must not silently select broader permissions, execute a model, or create a visible conversation.

## Inventory

| Area | Current ownership and source | Change |
|---|---|---|
| Documents and Office | The library/index is project-root scoped; `document-workbench/lib/client.js` selects a session, while `lib/session.js` derives its cwd and policy. Office execution still needs an active native agent. | Select one native project; obtain its root from the workspace registry and resolve an executor separately. Keep caches/indexes project scoped. |
| 1C environment/settings | `.dev.env` belongs to the project; `project-settings/lib/client.js` exposes two session selectors. `lib/session.js` supports bounded cold native projection. | Project selector and shared selection, preserving file CAS and native write permissions. |
| 1C checks/deploy | `workflow-integration/lib/client.js` exposes a session selector; project workflow bindings/runners are already root scoped. | Project selection; approvals, execution/cancellation and native jobs remain tied to the actual operation/agent. Do not turn this into permission escalation or real deployment. |
| 1C workbench/specialized tools | Project metadata and binding are root scoped; client derives an active session (`onec-panels`, `onec-specialized`). Native tools require actual scoped execution. | Reuse selected project, with executor status separate from project identity. |
| Import from other agents | Preview/apply target project root; `agent-import/lib/client.js` asks for session. Global import also checks full access. | Project selector for target ownership; preserve explicit global/project scope and existing permission checks. |
| Skills: available/enabled and assignments | Skills and `.dsh/skill-assignments.json` are already project scoped, with shared user defaults. Client currently asks for session. | Select project. Runtime status/catalog snapshots remain execution evidence for the actual agent. |
| Skills: selected task type | **Genuinely session persisted:** `skills-integration/lib/assignments.js` writes `skill-assignments/sessions/<sha(sessionId)>.json` with `sessionId/taskType`; `catalog.js` reads this during each step. | Move the explicit settings preference to project identity. Native planning and delegated role remain per-task runtime inputs. Do not copy session permissions or generated history across projects. Legacy disagreements need an explicit deterministic migration policy rather than last-writer guessing. |
| Caveman / answer brevity | **Genuinely session persisted:** `general-tools/lib/style.js` writes `general-tools/styles/<sha(sessionId)>.json`; system prompt reads by agent session. | Project-level preference, inherited by conversations of that project, with global default if desired. Explicit user requests for detail still take precedence. Preserve style-only semantics. |
| Memory | Latest version has global preference plus `.dsh/memory.json` override; only project operation executor remains session scoped. | Adopt shared native project selector; do not restore the old per-operation store selector. |
| OpenSpec selection | Files/ticket source are project owned, but `openspec-workflow/lib/openspec-workspace.js` caches workspace instances by `sessionId + root`, so selected change/stage/path are per chat. | Share project selection data while retaining an independent workspace execution instance and immutable caller session identity. |
| OpenSpec drafts | `lib/client.js` has `openSpecPanelDrafts` keyed by sessionId. It contains local text plus generated-edit drafts. Ticket handoff events are also session keyed. | File drafts keyed by canonical project root + relative file. Keep generated dispatch, approval evidence, original user nonce and ticket-to-agent delivery tied to their source session. Never mutate another chat's executor to share UI state. |
| Model roles/rotation settings | `model-orchestration/settings.json` owns global role/pool settings. `runtime.sessions` stores committed provider-route pins per conversation. | Settings are already global. Keep runtime pins per conversation: this prevents history/provider mismatch and repeats after failover. Project defaults can be added separately; do not rewrite committed model history as part of settings ownership. |
| Provider model/effort/speed controls | Native composer selection and subscription speed use sessionId; provider account/catalog configuration is global. | These are actual per-conversation execution selections, not project settings. Keep native behavior; optionally expose project defaults independently, without changing existing conversations automatically. |
| Telegram | Bot token/owner/autostart are global. `telegram-control.js` deliberately persists a concrete `workspaceId/sessionId` remote-chat binding; the bridge continues exactly that conversation. | Bot settings remain global. A project-level entry may choose the project's conversation automatically, but do not broadcast incoming messages into arbitrary chats or change the existing binding without an explicit routing action. This is transport/execution identity. |
| History recall, handoffs, reviewed lessons, task IDs | Source event IDs, genuine-user approval, receipt IDs and compaction namespaces intentionally belong to conversations/operations. | Keep provenance/execution scoped. Project settings must not merge histories, nonces or operation receipts. |

## Native project service

SDK022 already supplies one authoritative native workspace registry:

- Host: `ctx.workspaceRegistry.list()` and `.get(id)` return entities with stable `id`, canonical `path`, `title` and verified `sessionIds`. Their paths use realpath identity, and the native registry filters session membership against its header index. Archive information belongs to the registry, not a copied list.
- Client: `ctx.workspaces.list.getSnapshot()` returns `{items, archivedSessionIds, pinnedSessionIds, state, phase, error}`. Rows include `workspaceId`, `path`, `title`, `sessionIds`; `.subscribe(listener)` is the native feed.
- The native workspace feed has no selected/current-workspace field. Derive the initial project from the retained `mainView` session, then keep an explicit shared project choice so switching chats inside a project does not reset settings panes.

Use registered workspace IDs, not arbitrary client-supplied roots. An executor is resolved separately and must match canonical project root, requested preset and current native policy. No least-restricted-agent search, hidden permission escalation, unarchive, new model turn, or copied account credentials. Read-only settings can be shown without a running task; operations must state which required capability is unavailable when no valid executor exists.

## Implementation priorities

1. Shared native project context and selector, used consistently across settings.
2. Documents/Office, project environment, workflows, imports and skills selector migration.
3. Genuine persisted Caveman and explicit task-type preferences to project ownership.
4. Share bounded OpenSpec project selection and project file drafts while preserving execution/provenance boundaries.
5. Regression: two conversations of the same project share settings; another project stays isolated; changing active chat never silently changes a manually selected project; closed/archived/large sessions and insufficient rights never become broader authority.

## OpenSpec implementation evidence

`createProjectSelectionStore` now shares selected change/stage/path/fragment by canonical realpath identity, bounded to 128 projects. Each execution workspace remains separate: its session ID, model dispatch, approvals, nonce baseline and MCP ticket snapshot are not shared. Snapshots expose the verified canonical project root. File drafts use that root; a full draft cache refuses new ownership instead of silently evicting unsaved edits. Generated AI-edit delivery state stays with the conversation that issued it. Project ticket settings use the shared project picker and keep the same editor key when the automatic executor changes.

`tests/openspec-project-binding.test.mjs` plus the existing runtime regressions pass 10/10 checks: two chats share navigation and file drafts; another project remains separate; native caller session identity and read-only rights remain unchanged; ticket settings follow project identity rather than executor identity. No model, backend or deployment was executed.
