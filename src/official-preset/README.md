# Official Desktop `1c-airules` preset

This profile package declares one complete Agent composition through the public
`@deepseek-ai/dsh-agent-preset` extension point in Desktop `0.2.1-rc.5`.

The composition starts from the pinned official Standard capability set and
adds `airules-dsh-provider` and `dsh-lsp-actions` inside the preset scope.
Consequently the embedded prompts, read-only airules tools, packaged skills
and BSL diagnostics/actions exist only in `1c-airules`; Standard and user
presets do not inherit them. The host-level BSL editor is protected by a strict
`header.agentPreset === "1c-airules"` route gate applied during staging.

OpenSpec mounts at host level for its panel and session lifecycle. Its runtime
guards every session against `1c-airules` and the project's explicit
`integrations.openspec=false` override. Commands resolve the canonical
embedded `openspec-*` skills; a second vendor skill provider is not mounted.
The OpenSpec CLI is bundled as a private dependency.

The package contains no Oleg Full canon, MCP server, endpoint, credential,
deployment command, database mutation, project wizard or runtime state. MCP
bindings remain machine/project-owned. XML/EDT tree and BSL/XML editing come
from the separately inventoried official 1C mechanics package.
The default registry id is changed to `1c-airules`, but the official Standard
preset remains registered and selectable.

The composition is derived from the official rc.5 Standard preset whose source
SHA-256 is `0d398d2a6872a73a106cb3bd19303ecccf1637e1fcad4d0bf9d8a72d2c2c68f5`.
The YAML is release-pinned. Unknown host versions must be rejected by the
official policy artifact planner rather than loaded optimistically.
