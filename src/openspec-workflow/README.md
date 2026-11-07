# OpenSpec runtime for airules

Standalone rc.5 adaptation of the supplied `dsh-openspec-workflow` package.
It registers the right-hand OpenSpec pane, activity HUD, local CLI queries,
Markdown editor, revision-fenced task board, approval records, Git status,
handoff/progress tools and `/opsx-*` commands. Canonical skills are provided by
the embedded airules rulepack; no parallel `opsx-*` skill provider is mounted.

Mount at host level with agents, commands, goals, subagents, systemPrompt,
tools, sessions, sessionPersistence and skills services. Web routes use the
optional webServer plus native connection admission and CSRF protection.

Enabled only for sessions whose `header.agentPreset` is `1c-airules`.
Project `.ai-rules.json` may set `integrations.openspec` to false or
`integrations.openspec.enabled` to false. Malformed bindings disable it.
There is no dependency on the supplier's projectPresets or 1C Full policy.

Writes from the UI require an attached session in native development mode;
plan state is read from the native agent service or logged plan projection.
Unknown mode fails closed. Native `sandboxPolicy.resolve({session})` must allow
workspace writes or full access; read-only mode is refused. Reads also resolve
the selected session's workspace, including persisted cold session headers
without resuming agents. Writes require an attached active session.
Existing workspaces are preserved; initialization is an explicit user action.

The exact CLI is resolved from this package's nested dependencies, avoiding
global `openspec` executables. Atlassian transport/settings are disabled;
generic ticket links on changes remain usable without a Jira connection.
