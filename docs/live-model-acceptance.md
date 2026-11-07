# Live DSH model orchestration acceptance

This is a bounded integration probe of the real native DSH agent loop and real provider adapters. It is separate from mock transport tests and does not certify the original 1C project.

**Current result: four strict PASS rows with policy39 after the native BOM fix.** See [post-fix results](#post-fix-results-policy39). The policy37 results below remain unchanged historical evidence.

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

## Historical live results before the BOM fix (policy37)

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


## Post-fix results (policy39)

On 2026-11-07 the same four routes were repeated sequentially on `var/candidate/official-desktop-rc5-25`, with UI16 and `airules-official-policy-0.12.0-dev39`. The copied original module, prompts, exact two-space byte oracle, native permission guard, 24-request limit and 4096 output-token cap per request were unchanged. No model or harness instruction added a BOM, and no post-run repair modified a file or report.

| Route | Native model requests | Seconds | Completed native children | Successful docs MCP calls | Read denials | Strict result |
|---|---:|---:|---:|---:|---:|---|
| Flash High, no MCP | 16 | 64.785 | 2 | 0 | 0 | PASS |
| Flash High, direct docs MCP | 16 | 77.967 | 2 | 3 | 0 | PASS |
| Sol Medium, no MCP | 18 | 117.715 | 2 | 0 | 1 | PASS |
| Sol Medium, direct docs MCP | 19 | 120.494 | 2 | 2 | 1 | PASS |

Current evidence, relative to the repository root:

- `var/live-model-acceptance/deepseek-local-f5c4e1a7-5a02-4fae-918f-77c4f3933c08/summary.json`
- `var/live-model-acceptance/deepseek-mcp-2f7e5e01-58eb-4029-b72b-fa0338ad4ffc/summary.json`
- `var/live-model-acceptance/openai-local-a5b9d0f8-7ad8-4907-9dbf-8f302f1a58c3/summary.json`
- `var/live-model-acceptance/openai-mcp-0b262172-3512-4c65-a833-049659f3b33b/summary.json`

All thirteen strict checks passed in every row. Each real developer read and edited the copied module; each real tester started only after developer completion, read the final disk file and ran the real installed local BSL analyzer on its final SHA-256. Parent and both child canonical headers retained the exact requested model and effort. In both MCP rows the parent and at least one child actually called the whitelisted direct docs tool; local rows registered and called zero MCP tools. The inherited native workspace-write sandbox and additional deny guard remained active.

Each input was 340 bytes with its UTF-8 BOM; each final file was exactly 342 bytes, retained that BOM and the original CRLF line endings, and differed only by the two intended comment spaces. `exactCommentChanges=true`, `encoding.originalHasBom=true`, `encoding.finalHasBom=true`, `encodingDelta=none` and original-project SHA-256 unchanged are recorded in every summary. The previous FAIL/PARTIAL reports were neither rewritten nor relabeled.

Post-fix totals: **69 native model requests, eight completed native child activations, five actual docs MCP calls, zero deployments and zero original-project changes**. Across the five historical attempts and four post-fix rows: 151 requests, 18 native children and 10 docs MCP calls. Boot-only filesystem attestation attempts made zero model requests and are not counted as model runs. These are integration timings, not a model-performance benchmark.

The two Sol runs each had one read rejected by the extra path guard. In the local Sol run, inspection of only tool-call arguments in its own newly generated isolated native session log confirmed that the rejected target was the fixture's `AGENTS.md`, outside the module/artifacts read allowlist. Native project instructions were already supplied through the instruction pipeline. No original-project or credential read escaped the guard. The MCP Sol denial is retained as a generic rejected read; its precise target was not inferred. A rejected read that the scenario recovered from is not reported as zero denials.

### Actual native filesystem proof

The fix is a profile-managed `airules-dsh-native-fs` package. It preserves the original native SandboxedFileSystem implementation, changing only its LocalFileSystem import to the packaged pinned implementation. The local implementation retains the original BOM flag alongside line-ending metadata and restores that flag inside the existing atomic edit critical section. Native containment, authority checks, version fencing, per-target locks and atomic publication remain in the native implementations.

The original `fs-sandbox` row is disabled using its exact native-name assertion, and the managed provider is inserted under the distinct `airules-native-fs` ID. Renaming an existing row through a patch is not supported: policy38 staging exposed that assertion-only behavior, and the runtime check correctly rejected its unpatched service before any completion request. Policy39 fixes that composition. No SDK file or global Node filesystem function was mutated.

Every post-fix host checked the profile-resolved service before submitting a prompt. After unwrapping only the public Cordis `original` symbol, the actual service constructor had to equal the candidate package's SandboxedFileSystem export, and its superclass/instance had to be the patched LocalFileSystem from the same package. Both actual candidate module hashes had to match the policy39 payload. The recorded owner was `airules-native-fs` / `airules-dsh-native-fs`:

- sandbox `lib/index.js`: `61c08dd59494f543ea78fc01386599bfd2e50d33a4842ce8ba74ac8a3dfb03aa`
- patched `lib/local.js`: `e8e6be094b6358ba76037f7bea19dce133b460ade9993cbbe28436d460820bc8`

The separate zero-request proof is `var/live-model-acceptance/fs-proof-fe221c3d-1fda-42f1-b63a-08ce305e8b2b/proof.json`. Every successful live summary also contains its own `runtimeProof`. The host therefore exercised the managed patched sandbox service, not the unmodified extracted SDK filesystem or an unverified shim. The live host was still an isolated candidate with maintained subscription source and explicit native auth-store injection, rather than an untouched installed desktop binary.

### Limits and reproduction after the fix

Actual diagnostics still changed from three to one, preserving MissingReturnedValueDescription. Lexer/parser and JVM compatibility warning categories remained observed in all four rows. Strict PASS means this bounded orchestration/encoding/MCP acceptance passed; it does not mean a clean whole-project parse, successful business tests, a validated 1C database, or deployment certification. No real 1C deploy was performed.

Final offline verification: 527/527 overall tests and 27 focused filesystem/package tests passed; the seam/admission/oracle/runtime-attestation subset passed 13/13. Reproduction uses the same explicit CLI parameters documented above, with `--candidate-root` pointing to the isolated candidate25 and `--policy-artifact` / `--ui-artifact` pointing to policy39 / UI16. The pinned subscription transport is selected from the explicit policy artifact, not hardcoded to policy37. Each matrix row runs in a fresh process so native home identity is fixed before module imports. Existing installation credentials are passed only as native storage paths; they are never copied into the artifact or printed.
