# Project ownership of style and skill preferences

Persistent presentation and skill-task defaults belong to the project. Session IDs remain transport/execution context for existing native controls; they are not storage keys.

| Preference | Project file | Schema |
|---|---|---|
| Caveman response style | `.dsh/response-style.json` | `{ "schemaVersion": 1, "mode": "off" or "lite" }` |
| Skill task-type default | `.dsh/skill-context.json` | `{ "schemaVersion": 1, "taskType": "auto", "all", or a supported type }` |
| Skill-specific assignments | `.dsh/skill-assignments.json` | Existing shared project overrides, unchanged |

All conversations in one project read the same files, including a newly opened conversation. Other projects remain independent. Files contain no session IDs or machine-specific absolute roots and can travel with the project. Defaults remain `off` and `auto` when absent.

The native planning state and an exact managed delegate role take precedence over the project task-type default. Thus a project default of documentation does not narrow a tester's catalog to documentation skills. The project default applies to ordinary chats. Native access modes and tool/skill invocation policy remain authoritative; catalog selection never grants execution permissions. Runtime status and emitted catalog evidence remain session-specific because they describe actual execution and journal provenance.

Saving these project files requires a writable native lead context. Read-only and subagent contexts may read but cannot change project preferences. Current scope/root/mode is pinned and rechecked through asynchronous saves; storage retains existing link/hardlink checks, locks, backups and revision-based conflict handling.

Old per-session files in DSH home (`general-tools/styles/` and `skill-assignments/sessions/`) are preserved and ignored. They may conflict between conversations; no arbitrary winner is copied into project settings. The user can explicitly choose the project preference in its host control. No real user project files are modified by tests.

Validation: `node --test tests/general-tools.test.mjs tests/skill-assignments.test.mjs tests/skills-integration.test.mjs`. Coverage includes cross-chat sharing, unrelated projects, CAS, legacy-file preservation, read-only/subagent denial, and policy revocation before a queued write. Canonical Caveman instructions now explain host project preference scope without prescribing a DSH-specific mechanism.
