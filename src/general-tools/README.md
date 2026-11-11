# AIRules general tools for DSH

Maintained source for scoped Caveman lite and local Mermaid PNG rendering. Mount
this package once in the host for the settings/backend service; mount `/tools`
only inside the `1c-airules`, `python-airules` and `sysadmin-airules` Agent
compositions. It does not globally alter Standard or donor/vendor files.

## Contract

- Root injects webServer, connection, sessions, sessionPersistence,
  sessionProjections, sandboxPolicy, sandbox, subprocess, agentPresets, tools;
  provides `airulesGeneralTools`. Config `nodePath` defaults empty.
- `/tools` injects tools/systemPrompt/airulesGeneralTools; registers
  `craft_mermaid_render({input,outDir,theme?})` and a dynamic prompt section.
- Settings section `airules-general-tools`, label `Краткость ответов`.
- GET `/airules/general-tools?sessionId=...` returns native admitted session state
  and CSRF. POST same path accepts only sessionId/mode/revision and CSRF header.
  There is deliberately no HTTP execution route.
- Style is `off` by default. Explicit `lite` is shared by the project through
  `.dsh/response-style.json`, protected by compare-and-swap, and read by every
  conversation in that project. Changing it requires a writable lead context;
  read-only contexts can inspect it. Missing or invalid data fails off. Legacy
  per-session files are preserved and are not imported automatically.
- Rendering requires real active agent, workspace-write/full native policy and
  matching project root. It snapshots a bounded UTF-8 .mmd into a fresh artifact
  folder inside the project, invokes fixed renderer argv through native confinement
  and subprocess, and checks actual PNG and output paths. No arbitrary script,
  shell string, remote renderer, dependency installation or MCP requirement.
- Default Node comes from the official `load_workspace_dependencies` native tool
  under the real agent execution token. The source/runtime manifest and install
  roots must be configured by the host. No dependency on PATH Node. `nodePath`
  is an explicit administrator absolute override, not model input.

## Packaging

`runtime/mermaid` is an exact generated copy of canonical
`project_rules/core/skills/craft-mermaid` scripts/assets/references/LICENSE/NOTICE.
Do not patch this copy. Canonical sources keep the Apache-2.0 provenance. Renderer
pins beautiful-mermaid 1.1.3 and @resvg/resvg-js 2.6.2 in its lockfile. Packaging
must include this verified runtime closure plus the target-platform optional
native resvg package (`@resvg/resvg-js-win32-x64-msvc` for current Windows x64).
Install closure at package construction time with npm ci --ignore-scripts; never
run dependency installation on a user's render request. Runtime sources remain
included in the receipt fingerprint, including native binaries and lockfile.

## Validation

`node --test tests/general-tools.test.mjs` covers persistent opt-in/CAS, isolated
presets, read-only metadata, CSRF/admission, native runtime authority, path/policy
rejection, confinement/cancel, canonical equality and an actual PNG. The six-type
renderer smoke is `node runtime/mermaid/scripts/runtime/smoke-test.mjs` from this
package. Test process adapters do not represent a native sandbox attestation;
perform a mounted official-host probe before installation and visual review of
actual PNG. No LLM calls, real deploy or external messages are needed.
