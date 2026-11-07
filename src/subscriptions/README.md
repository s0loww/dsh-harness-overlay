# Subscription model providers

Standalone adaptation of `dsh-plugin-subscriptions@0.8.0` for official DSH
`0.2.1-rc.5`. Settings → Subscriptions provides Codex, Claude, Grok and GitHub
Copilot accounts, manual OAuth/device login, default account, model visibility,
reasoning/context preferences, usage and same-provider account pools.

No credentials are shipped or imported at startup. State is isolated under
`DSH_HOME/plugins/airules-subscriptions/`. The previous router/subscriptions
stores are not migrated or deleted. Claude Code import is available only
through its explicit Import action; ordinary Claude Connect starts OAuth.
Accounts and authentication are configured by the user through provider UI.

Auxiliary image/video/X-search tools are not registered. Normal model tool calls
remain governed by the active DSH session. Hiding a model updates the native
provider catalog while preserving all existing session/history selections.

Kimi/GLM/Qwen/OpenCode/Google/Muse/Cursor supplier adapters are separate
components and are not included in this package. This port does not install
provider CLIs, override authentication barriers or automate account login.
