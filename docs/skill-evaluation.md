# Skill evaluation core

Source: `src/skill-evaluation`; donor reference: `lib/skill-eval-core.js` and
`lib/skill-eval-runner.js` in the user's DSH-1C bundle. No donor code is executed.

The donor compares active against either previous or baseline. This core always
includes `no-skill`, adds `previous` when available, and uses the exact current
revision. Plans require two or three explicit fixture tasks, including a positive
case and a near-miss. File byte equality and final-text markers provide objective
checks. Skill loading is reported separately, including unnecessary near-miss
loading. A passing fixture harness does not establish that a skill improves an
actual model's answers.

## API

`planEvaluation({current, previous?, tasks, modelId?})` is pure and immutable. Each
skill is `{name, description, files: {'SKILL.md': '...', ...}, revision?}`. Optional
revision must match SHA-256 of the normalized file map. No automatic filesystem
discovery or environment lookup occurs. A task contains `id`, `kind` (`positive`
or `near-miss`), `prompt`, an explicit relative `files` map, `expectedFiles`, and
optional `finalIncludes`. At least one objective assertion is required. The
SHA-256 `planId` includes every prompt, fixture byte, skill, model and limit.

`runEvaluation({plan, runner, authorization?, signal?, timeoutMs?})` produces an
immutable report. Its runner receives only `{task, variant, tools, limits,
signal}`; no host path, environment, original project, expected result or raw
credentials. Capability tools are `read(path)`, `write(path, text)` and
`readSkill(path = 'SKILL.md')`. They operate on independent in-memory copies,
preserve BOM bytes represented in fixture strings, reject absolute/parent/ADS
paths, and enforce file, call, read, write and time limits. A tool violation stays
a failure even if the executor catches it. Closed tools reject late writes.

`createFixtureRunner(execute)` in `lib/fixture-runner.js` runs trusted deterministic
harness callbacks, without model calls or process creation. It is for verifying
the harness and fixtures, not for declaring model quality PASS.

For a model runner, the trusted host supplies
`{kind: 'model', modelId, execute, cancel}`. `runEvaluation` rejects it unless
`authorization` equals `{run: true, planId: plan.planId, modelId: plan.modelId}`.
Mutated plans are rejected before the executor runs. Abort/timeout closes tools,
invokes `cancel`, and stops the matrix; failed cancellation is surfaced. The host
must treat this authorization as a one-shot user action and must not silently
fall back to another model/provider. Planning never authorizes a paid run.

Limits: 2–3 tasks, 4–9 sessions, 24 files per map, 256 KiB fixture input, 128 KiB
skill input, 96 tool calls, 128 KiB reads/writes, 60 seconds per session, 4 KiB
final excerpt. Traces store sequence, tool name, relative path, byte count and
success only. They exclude reasoning, file bodies, provider errors and arbitrary
runner metadata. Reports are returned to the caller; the core does not create a
third state store or write to projects. Final text and relative paths remain
task content: use synthetic fixtures rather than copying private project data.

## Native host integration

The pure core has no SDK dependency. Native entries declare their actual peer
dependencies; the model factory is explicitly guarded to SDK `0.2.2-rc.1`.
Planning and deterministic fixture execution remain compatible with rc.5. A
temporary HOME or an in-process callback is not an OS security boundary.
`execute` is trusted code. Never evaluate arbitrary JavaScript supplied by a skill.

`./native-factory` implements fresh native sessions: an independent Cordis
Context for every case, native SessionStore/SessionProjectionRegistry,
AgentRegistry/AgentLoop, SystemPrompt, LlmRuntime and ToolsService with
NativeToolExecutor. The authenticated selected provider adapter is borrowed
without copying credentials. The new tree has no filesystem, shell, MCP,
native skill discovery, project hooks, persistence or credential service. Only
`eval_fixture_read`, `eval_fixture_write`, `eval_skill_read` are installed, with
scoped restrictions. Parent authority and cancellation are checked before
creation, after awaits, before provider dispatch, per streamed chunk and per
tool call. `agent.model.select` binds the exact provider/model/effort. Auto
effort permits the adapter's native default and pins it for subsequent requests
within the case. Provider replacement fails closed. The selected project and
model are not changed. No process is spawned and no real deploy exists.

Settings UI can import `planEvaluation`, `runEvaluation`, and
`renderEvaluationReport` from `airules-dsh-skill-evaluation`. Present the task
matrix, exact model, number of model sessions and expected cost before an
explicit Run action. Offer the deterministic fixture mode independently.
The native tool already exposes this implementation. No shared staging/package
files were changed by this module's implementation.

The installable `./agent` entry registers `airules_skill_eval` with actions
`status`, `plan`, `review`, `fixture`, `run-model`, and `report`. Add it only to the three custom
`1c-airules`, `python-airules`, `sysadmin-airules` presets. It declares native
`tools`, `systemPrompt`, `agents`, `agentPresets`, `sandboxPolicy`, `llm`,
`sessionQuery`, `approval` injections and
checks the live agent registry, exact session, project and native policy before
every action and again after awaited evaluation. Cancellation/revocation drops
the pending result. Plans and reports are agent-local weakly referenced state;
another agent knowing the plan ID cannot read or run them. `plan` without
`specJson` creates a synthetic six-case BOM/comment/near-miss demonstration.
Custom tasks may supply at most 24 declarative `fixtureSteps`: `read`,
`read-skill`, `write`, `replace`, `final`; these cannot execute code or commands.
`fixture` and `report` require the exact `planId`. All fixture reports explicitly
state that zero model requests were made. `run-model` is lead-only and requires
the selected model to match the plan. `review` returns a single-use exact phrase
bound to plan/model/scope and a fresh nonce. The user must send it as the next
original text-only native `user/message`; recalled, inherited, runtime or
model-authored text cannot approve. Native approval is additionally requested.
The original latest-user checkpoint is reread after approval, its live Session
journal cursor is checked synchronously before authorization commit, and pinned
through execution. New steering or denial rejects stale approval. Denial,
timeout or failure consumes the checkpoint: a new review is necessary.

`./model-runner` exports `createNativeSessionRunner({modelId, openSession,
verifyScope})`, a lifecycle adapter for a **trusted host factory**. It requests a
fresh session with all ambient inheritance disabled, gives it only guarded
fixture tools, checks authority around every await/tool call, and requires
run/cancel/dispose. It sanitizes returned metadata and disposes each case. This
does not itself provide a sandbox; isolation comes from the separately built
native tree in `native-factory.js`. Tests inspect the actual native tool registry
and absent ambient services. Neither temporary directories nor a factory's
self-declared flags are accepted as proof of sandbox enforcement.

Native execution permits up to eight LLM dispatches per case, 4096 output tokens
per dispatch, 4096 streamed chunks/512 KiB per case, plus the core's IO/time
budgets. Reports retain safe per-case/total dispatch counts, including failed
native runs. Unknown metrics are `null`, never a misleading zero. Reasoning and
provider exception bodies are omitted. Model traces are evidence for an explicit
human comparison; no automatic skill promotion follows.

## Portable airules contract

The same method applies outside DSH: freeze revisions and fixtures; include
current, optional previous and no-skill; include a near-miss; compare observable
artifacts and bounded read/tool traces; record the exact model and run plan;
require explicit execution for paid models; never inherit environment/project
authority; retain human review. Backend adapters enforce their own native
permissions and must not describe fixture success as a model acceptance result.

Validation: `node --test tests/skill-evaluation*.test.mjs`. The actual SDK022
AgentLoop is exercised with a deterministic synthetic LlmAdapter: six fresh
native cases, nine synthetic dispatches, real native tool pipeline and no
external requests. Other tests cover checkpoint forgery/replay, approval denial,
denial during approval and a stale pinned history snapshot. These tests invoke
no paid model, network, shell, real project runner or deployment.
