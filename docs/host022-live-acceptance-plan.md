# Planned live acceptance on DSH 0.2.2-rc.1

Acceptance completed on 2026-11-10 after the parent session announced the four runs. All four rows passed: 14 / 16 / 15 / 17 requests, total 62. Exact role order, BOM, BSL diagnostics, direct MCP and unchanged original source passed. Reports: `var/host-upgrade/rc022/model-matrix-summary.json`. Runs exercised UI5/policy49; final policy50 adds only declared native `jobs` injection to continuity, verified separately through all three mounted native compact lifecycles.

Use `scripts/probe-live-model-orchestration.mjs`, one fresh process per row, with explicit final certified `--candidate-root`, `--policy-artifact`, `--ui-artifact`, `--native-modules` and `--release-lock`. Old defaults remain rc5; mixing 022 lock with rc5 SDK is refused before native boot. Credential/auth stores are explicit existing paths supplied privately at invocation; the runner does not copy their contents and reports no account/token values.

| Run | Route | MCP |
|---|---|---|
| deepseek-local | DeepSeek Flash 4.1 (`deepseek-flash`), high | absent |
| deepseek-mcp | DeepSeek Flash 4.1 (`deepseek-flash`), high | direct 1C-docs only |
| openai-local | GPT-6.1-Sol, medium | absent |
| openai-mcp | GPT-6.1-Sol, medium | direct 1C-docs only |

Same previous fixture: `D:/AI_Projects/Project_BL/src_bl/CommonModules/ккОбменДаннымиERPЗУП/Ext/Module.bsl`, 340 bytes, UTF-8 BOM, SHA256 `7fa6089cea992e7f7126cfd0e5f45d3b2c2e955cfaa3bbe9a2a59e96e7b3ed8e`. Preparation verified current source bytes match. Each run copies only that file into a fresh isolated repository. The original project remains read-only.

The parent must delegate to exactly one developer, wait for completion, then delegate to exactly one tester. Developer changes only `//+`→`// +` and `//-`→`// -`; all other bytes, BOM and line endings remain intact. Tester personally rereads the saved file and runs real bounded BSL analysis. Expect diagnostics 3→1: `SpaceAtStartComment` disappears; `MissingReturnedValueDescription` remains. Parent source writes are denied. Tester must not edit; final acceptance rejects any successful tester edit. Handoff must state project correctness NOT_CERTIFIED and deploy NOT_RUN.

In MCP rows, parent and at least one native child must each call only `mcp__1C-docs-mcp__docinfo` with fixed `Массив.Найти` arguments (`top_k=1`, `max_items=1`, `max_chars=3000`, `detail_level=compact`). No facade is required. Local rows require zero registered MCP tools. No shell, database, deployment, COM, arbitrary URL/tool, external messaging, third role or nested delegation is permitted. Native sandbox and a separate deny guard enforce tool, path, parent-write and MCP limits independently of the prompt. Final acceptance additionally requires exactly two children, the correct order and no tester edits.

Limits: 24 model requests per row, 4096 output tokens per request, 10-minute run timeout, 60-second BSL process timeout, 30-second MCP call timeout. Maximum planned matrix budget is 96 model requests; no automatic retry is planned. A failure must be investigated before another paid attempt.

New 022 route selection uses actual `Agent.model.select` before step preparation. A scoped pre-step assertion verifies the frozen provider/model/effort, and each actual request independently verifies the same route and shared request count. Native child policy must match the isolated workspace. Tools use the host's native batch executor; product nested helper retains parent authority.

Prior successful reports are in ignored `var/live-model-acceptance/`: `deepseek-local-f5c4e1a7-5a02-4fae-918f-77c4f3933c08` (16 requests), `deepseek-mcp-2f7e5e01-58eb-4029-b72b-fa0338ad4ffc` (16), `openai-local-a5b9d0f8-7ad8-4907-9dbf-8f302f1a58c3` (18), `openai-mcp-0b262172-3512-4c65-a833-049659f3b33b` (19). These certify the previous rc5 run only; 022 acceptance results are recorded above; those older reports remain rc5 evidence only.
