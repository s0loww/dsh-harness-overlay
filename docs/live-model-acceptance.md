# Live DSH model orchestration acceptance

This is a bounded integration probe of the real native DSH agent loop and real provider adapters. It is separate from mock transport tests and does not certify the original 1C project.

## Explicit routes

| Run | Provider | Discovered model ID | Effort | MCP |
|---|---|---|---|---|
| deepseek-local | deepseek-account | deepseek-flash (DeepSeek-V4.1-Flash) | high | absent |
| deepseek-mcp | deepseek-account | deepseek-flash | high | direct read-only docs |
| openai-local | codex | gpt-6.1-sol | medium | absent |
| openai-mcp | codex | gpt-6.1-sol | medium | direct read-only docs |

Native metadata discovery confirmed these exact IDs and advertised efforts. Native API readiness returned only safe booleans: OpenAI account present/usable/expiration available and DeepSeek credential present. Catalog membership alone is not evidence of successful model generation.

## Host and storage boundary

Run each matrix row in a fresh Node process. Set isolated DSH_HOME and DSH_AGENTS_HOME before importing the native SDK. Boot a disposable candidate profile, disable other account adapters, Telegram, remote access, automatic LLM titles, telemetry and retry execution, and explicitly mount the selected native providers. Never boot the actual user profile, copy auth/history files, or log tokens/account identifiers.

DeepSeek uses the actual native LocalCredentialProvider with an explicit credentials-store path and watch disabled, and the native platform-account and account-LLM APIs. OpenAI uses the maintained subscription adapter with `apply(ctx, config, {authStorePath})`. This optional internal host argument preserves the usual default auth path; it is not a user-visible profile setting. Account refresh remains the normal adapter operation against its existing store. Provider settings and session history belong to the isolated host.

The subscription source and dependency packages may be copied/linked into the isolated host; existing credential/profile/history files are never copied. The pinned subscription transport is undici 7.29.1 from policy37. This tests maintained adapter source plus the pinned native SDK/candidate host, not an untouched installed binary.

## Execution and evidence

Copy exactly one explicitly selected real BSL module into a fresh workspace. The original 340-byte BL module remains read-only and its SHA-256 is checked afterward. The parent must call real `airules_delegate` for developer followed by tester. The developer reads and fixes two comment-spacing markers; the tester independently reads the final disk file and runs installed BSL Language Server through a fixed native subprocess adapter. The unresolved MissingReturnedValueDescription diagnostic must remain; actual diagnostics must change from 3 to 1.

The native workspace-write sandbox remains authoritative. An additional monotonic native tool guard denies shell, arbitrary paths, parent writes to the module, unknown tools, nested delegation and all other MCP calls. Tool visibility is restricted separately. The lint tool accepts no arbitrary command or parameters. No database, deployment, COM or external messaging is permitted.

MCP rows mount only the direct 1C-docs-mcp endpoint from the project configuration, without modifying that file. The exact allowed call is docinfo for the public Array.Find platform symbol, top_k=1, max_items=1, max_chars=3000, detail_level=compact. Both parent and at least one real child must perform it. The isolated project AGENTS explicitly permits this exception. Local rows must register zero MCP tools.

Per run, at most 24 parent+child native model requests, 4096 output tokens per request and a 10-minute timeout are allowed. Native retry execution is disabled. Report actual canonical request headers, native child start/end/completed events, inherited workspace sandbox, successful tool names, final-source lint hashes, original hash, retained diagnostics, handoff, elapsed time and bounded counts. Raw credentials, MCP results and reasoning traces are not persisted in the summary.

## Live results (2026-11-07)

All four primary rows used the same final expanded oracle and a fresh copy of the same BOM-bearing 340-byte BL module. Each row performed exactly two real native child activations in the order developer completed, then tester started. Canonical parent and child request headers matched the explicit provider/model/effort. Original source SHA-256 remained unchanged, native inherited sandbox stayed workspace-write with the copied workspace, actual local diagnostics changed from 3 to 1, and no deployment ran.

| Primary row | Native model requests | Seconds | Completed native children | Successful docs MCP calls | Result |
|---|---:|---:|---:|---:|---|
| Flash High, no MCP | 14 | 54.432 | 2 | 0 | PARTIAL: BOM removed |
| Flash High, direct docs MCP | 19 | 74.014 | 2 | 3 | PARTIAL: BOM removed |
| Sol Medium, no MCP | 15 | 94.766 | 2 | 0 | PARTIAL: BOM removed |
| Sol Medium, direct docs MCP | 20 | 125.798 | 2 | 2 | PARTIAL: BOM removed |

Primary evidence, relative to the repository root:

- `var/live-model-acceptance/deepseek-local-7c02cc64-a4fc-44b5-996b-0238ad4f1f70/summary.json`
- `var/live-model-acceptance/deepseek-mcp-9ea55e89-286c-4cfd-8446-ee613f644370/summary.json`
- `var/live-model-acceptance/openai-local-eb3e7d61-5576-4819-8759-894f0773dbc5/summary.json`
- `var/live-model-acceptance/openai-mcp-d684e663-db50-481a-8e90-72aeb0b77a5d/summary.json`

The initial Flash local attempt remains immutable at `var/live-model-acceptance/deepseek-local-3bc8ba5a-fe40-487e-8a07-b35b9c906573/summary.json`: strict FAIL, 14 model requests, 63.295 seconds, two completed native children and zero MCP calls. Its initial oracle found the BOM loss before lifecycle-order fields were added. It was repeated once under the uniform final oracle; its original report was not rewritten or upgraded.

Totals across all five actual attempts: **82 native model requests, 10 completed native child activations, 5 successful actual docs MCP calls, zero deployments and zero changes to the original project**. Four primary rows account for 68 requests and eight children. These timings include host and local-lint overhead and are not comparative model benchmarks. Each OpenAI row had one out-of-allowlist read rejected by the guard, then completed the scenario; no successful parent/tester source writes occurred.

Every primary row retained a failed strict byte check. Native edit removed the copied file's three-byte leading UTF-8 BOM: 340 input bytes became 339 bytes instead of the expected 342 after adding two spaces. CRLF stayed unchanged. Excluding only that leading BOM, the file matches exactly the two requested comment-spacing changes. `semanticCommentChanges=true` and `encodingDelta=bom-removed` are explicit analysis fields; they do not turn the strict byte oracle into a pass. No core monkeypatch, post-processing repair or report rewrite was used. See [native UTF-8 BOM finding](native-utf8-bom-finding.md).

The native BSL process also reported lexer/parser warnings and JVM compatibility warnings in the captured warning categories, before and after editing. The real JSON diagnostics and metrics were observed, but this does not establish clean parsing or whole-project correctness. MissingReturnedValueDescription remained in every final report; it was not hidden or fixed. No full 1C configuration validation, database execution or business test took place.

Numeric native usage was collected after its observer was added: final Flash local input excluding cache 6263, output 3715, cache-read 188416; Sol local 52165/2556/130048 with reasoning 169; Sol MCP 59635/3550/219008 with reasoning 295. Earlier Flash attempts have no usage counters in their summaries; absence is not zero usage. Reasoning is adapter-reported detail, not an additional charge calculation.

Offline validation after the final changes: 503/503 tests passed, including 12 targeted seam/admission/oracle tests. The live result remains PARTIAL because of the independent BOM issue. This establishes real DSH delegation/provider/MCP execution on the bounded fixture, not readiness certification for an arbitrary 1C project.

The live host was `var/candidate/official-desktop-rc5-24` with the extracted pinned `0.2.1-rc.5` native SDK, maintained subscription source containing the explicit auth seam, and the policy37 transport closure. It was not an untouched installed desktop binary. Optional incompatible composer-history/onec-lsp plugins were disabled by the native loader; product telemetry was not activated. Existing actual account stores were accessed only through the native provider/subscription storage APIs.

## Reproduction

Use scripts/probe-live-model-orchestration.mjs with explicit --run, --candidate-root, --project-root, --source-relative, --bsl-ls, --auth-store and --credentials-store arguments. MCP rows additionally require --mcp-config. The script emits a sanitized summary path under var/live-model-acceptance. Metadata-only mode accepts --metadata-only true and --output and makes no completion requests.

Each recipient installation owns its OpenAI/DeepSeek login, optional MCP connections and project paths. These are not bundled with the portable rule pack. OpenAI models inside DSH continue to use DSH native tools, sessions, sandbox and delegation; Codex-specific agent files, hooks and configuration are not installed as DSH execution machinery.
