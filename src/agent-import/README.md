# Import instructions and skills

Native DSH 0.2 settings integration; original implementation inspired by the
preview/apply organization of MIT-licensed dsh-movein 0.13.8. Donor code is not copied.

Claude Code, Codex, Cursor, OpenCode; standard project/user roots only. Native
AGENTS.md/CLAUDE.md already read from the project are shown as skipped. Rule
directories and skills use bounded scans. Selectable rows show content, byte/file
counts, destination and conflicts. No account/config/chat/MCP imports.

Explicit apply rechecks source/destination digests and uses a per-target lock.
Existing rules are preserved; imported rules append marked blocks to AGENTS.md.
Changed managed blocks and existing skill collisions are blocked for manual review.
Old AGENTS.md and an import receipt are stored privately under
DSH_HOME/agent-import/backups/<id>. Skill bundles are copied, never linked.
Documents, images and script source files are accepted. Preview lists the complete
file inventory and marks scripts; they are copied as data, never executed, and no
dependencies are installed. Bundles containing binaries, links or suspected
secrets are skipped whole rather than copied incompletely.
Script-bearing imports start disabled with the shared native disabled-shadow
format. Original SKILL.md bytes remain in SKILL.md.disabled with their SHA-256
recorded in the shadow. The Skills settings page validates and restores them on
explicit enable; repeat import recognizes this state as identical.

HTTP API requires the native connection gate and CSRF. Project writes require a
writable native session; global writes require danger-full-access. It does not
change native permission settings. Partial copy failures are reported explicitly
and existing files are never replaced; inspect remaining conflicts before retry.

After importing rules start a new session. Native skill filesystem watchers discover
new .dsh/skills (project) or DSH_HOME/skills (global) bundles.
