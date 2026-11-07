# Cursor provider port

The optional package is `src/cursor-provider`, provider ID `airules-cursor`. This is an original integration, not a redistributed Cursor runtime. Donor `lib/cursor-subscription.js` was inspected to identify SDK surface and DSH chunk mapping; proprietary SDK files stay outside the repository and staged distribution.

## Verified SDK contract

Local external metadata identifies `@cursor/sdk` 1.0.38, Node >=22.13, CJS entry `dist/cjs/index.js`, license `SEE LICENSE IN LICENSE.md`. The adapter checks that entry and version, hashes package-owned files, and requires explicit trust confirmation before loading. Transitive `node_modules` and optional native dependencies are not included in this package-owned digest; trust of their separately installed closure is an administrator responsibility. Changing an already loaded package needs process restart because Node caches CJS dependencies.

The actual public SDK namespace is `Cursor`, with `Cursor.auth.login`, `Cursor.models.list`, and `Cursor.me` (not the internal HTTP client's `getMe`). Actual login callback is **onLoginUrl**, not onAuthUrl. Login receives `store:null`, `openBrowser:false`, a cancellation signal and a validated cursor.com HTTPS callback. Only the resulting grant is written into this package's native DSH credential record. SDK/CLI auth stores and environment-derived accounts are never queried.

Each call creates `Agent.create({apiKey,model,tools,disallowedTools:['task'],mcpServers:{},agents:{},local:{cwd,dirs:[],settingSources:[],store,customTools,enableAgentRetries:false}})`. `JsonlLocalAgentStore` lives under a fresh private run directory. `agent.send` yields `run.stream`, completion via `run.wait`, termination via `run.cancel`, disposal via asyncDispose/close. Text/reasoning deltas and token usage are mapped to native DSH blocks. The entire existing DSH conversation is passed to a fresh SDK agent; no external conversations or project files are imported.

## Native rights and handoff

Native rc.5 has no service literally named ExternalAgentAccess. Its existing ACP policy equates external agent access to BUILD plus `danger-full-access`. This adapter uses that same concrete policy, retrieves planMode through the active agent preset, and additionally requires current agent identity, native branded agent-loop provenance, matching signal/session/model, and one-use dispatch authorization. Direct llm calls and provider rotation without that provenance fail closed. Changing native rights before dispatch also fails closed; no setting or UI action grants permissions.

The SDK allowlist contains only MCP custom tools if the native request supplied tools. SDK-native filesystem, shell, nested agents, configured MCP servers and project setting sources remain unavailable. The wrapper never calls DSH tools. Custom callbacks queue a proposed tool call and wait. Cancellation must acknowledge **before** callbacks are released; stream settlement and agent disposal must finish before any native tool-call chunk is emitted. The native DSH agent then processes the original tool name/JSON arguments through its usual sandbox and approval scheduler. Timeout prevents handoff and leaves the still-active private workspace in place; cleanup continues only when termination completes. SDK errors are replaced with fixed public errors; no raw messages or credentials enter the UI.

## Unified UI integration

Client module ID `airules-dsh-cursor-provider`; named export `CursorSettings` (optional ctx prop is harmless). Root plugin `airules-cursor-provider` injects llm, credentials, dshHomePath, agents, agentPresets and sandboxPolicy, and mounts optional authenticated HTTP control. The client exports only the settings component; parent integration owns navigation and provider grouping. No shared stager or unified UI files were modified by this change.

Control GET returns status, confirmed runtime pin, model cache and process CSRF token. POST actions: `inspect(packageRoot)` (reads bytes, no require/network), `configure(packageRoot,sha256)` (requires matching just-inspected pin), `login`, `cancel`, `refresh`, `logout`. Explicit refresh has a 30-second response deadline; browser login has a five-minute deadline. Account state changes cancel leases; stale auth completion cannot resurrect a logged-out credential. Catalog refresh is explicit, cached across restarts, and cannot hold boot waiting on the network.

## Limits and verification

Text-only, one own account; no automatic account imports/rotation. Model parameters are exact cached selections, including bounded variants. Unreported model context uses an explicitly estimated 128k budget; model-specific reasoning controls and max-output enforcement are not asserted beyond the SDK's own model selection. SDK quota reporting and actual paid account/inference behavior are not tested here. No new skill is needed for provider authentication: it is a DSH target concern, not portable airules policy.

Run `node --test tests/cursor-provider.test.mjs` and `node --check src/cursor-provider/lib/index.js` / `lib/client.js`. The tests disable fetch, read only real SDK metadata, and execute an original synthetic SDK fixture to check isolation, native authorization, tool handoff/cancellation order, redaction, auth races, hash pins and HTTP gates. No real network, login, model request, live profile modification or deployment occurs.
