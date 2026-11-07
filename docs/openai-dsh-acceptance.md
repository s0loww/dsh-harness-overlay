# OpenAI accounts in DSH: acceptance and runtime boundary

Date: 2026-11-07. Target: official DSH Desktop 0.2.1-rc.5 with the existing
subscription, model-selection and managed-delegation integrations.

## Which layer belongs in the DSH distribution

OpenAI OAuth selects a model provider (`codex`) inside DSH. The executing
harness is still DSH: its session, sandbox, tool registry, native spawn
provider and project instructions own execution. The subscription adapter
serializes those requests to the Responses protocol. It does not start a
Codex Desktop/CLI project session.

Shared airules improvements from the Codex port belong in the canonical
core and therefore in the DSH rulepack. `.codex/agents/*.toml`, Codex lifecycle
configuration and Codex-specific installation mechanics stay in the Codex
target; copying them into a DSH package would not register DSH roles or hooks.

Existing DSH bindings remain authoritative:

- `airules_delegate` loads the verified role persona, resolves model and effort
  through the native `LlmRuntime`, and supplies `agentOptions` to DSH spawn.
- The shipping composer uses the native, session-bound reasoning menu. The
  incompatible supplier global click interceptor stays disabled.
- Explicit supported session effort overrides a provider model default. A
  role without a mapping inherits the parent's effective choice. A mapped
  different model resolves its own default when no effort is explicitly set.
- Model rotation is an optional separate mechanism: same provider, registered
  adapter, protocol and compatible capabilities. It uses the common effort
  intersection and smallest context. It is not permission escalation or a
  promise of automatic rotation between arbitrary OpenAI accounts.

## Offline acceptance added

`node --test tests/openai-dsh-acceptance.test.mjs`: **5/5 PASS**.

| Case | Evidence |
| --- | --- |
| Role → native child options → Responses wire | The real subscription adapter and pinned native LLM/subagent option resolver carry an architectural role's XHigh past the parent's Low default into `reasoning.effort`. The DSH role label, depth and parent delivery remain intact. Standard effort does not silently enable priority service tier. |
| Discovered effort restrictions | A configured Ultra default cannot extend a discovered Low/High/XHigh catalog. Unsupported role settings are rejected without persistence. Changing the mapped model does not retain an unsupported effort from the parent. |
| Withdrawn model | A native model-resolution failure is fault-injected at the adapter boundary. Role activation stops; the mapping remains unchanged and no other provider/model is silently selected. |
| Metadata fallback limitation | The actual adapter can resolve an unconfirmed ID using built-in metadata with no account present. This is recorded as a boundary, not mistaken for confirmed subscription access. |
| Capability intersection and installation isolation | A two-model OpenAI pool exposes only common efforts and the smaller context. Two separate installation stores remain independent; reopening the first preserves its choices. Cross-provider pool composition is rejected. |

Tests use the actual maintained subscription source, native rc.5 `LlmRuntime`,
native `resolveChildAgentOptions`, real role service and the pinned shipping
Undici 7.29.1. Authentication/storage identities and activation are isolated
fixture boundaries. `startActivation` is captured without starting a child
model turn. `MockAgent.disableNetConnect()` rejects every unmocked wire request;
the single admitted response is synthetic. No real account, OAuth, paid model
request, MCP, deployment or message delivery is performed.

The tests use the same local SDK preparation as the existing suite. The pinned
transport root can be provided explicitly as `AIRULES_SUBSCRIPTIONS_MODULES`;
the default is the verified policy36 subscription closure. This is a test
prerequisite, not an instruction to install dependencies or contact a provider.

Related existing coverage is retained:

- `tests/subscriptions-runtime.test.mjs`: native RPC activation/admission and
  explicit High/XHigh serialization with real adapter/native runtime.
- `tests/effort-compat.test.mjs`: native per-session selection, no global click
  interception, pending-write deduplication and retryable selection errors.
- `tests/model-orchestration.test.mjs`: persistent pins, no partial-answer
  replay, transient-only failover, auth failures, incompatible pools and
  registration/disposal contracts.

## Per-installation configuration

Each user connects their own OpenAI account through DSH's provider UI. OAuth
credentials, account IDs, usage state, provider defaults and role mappings
remain local. The package does not import another installation's auth stores,
session history or project MCP endpoints. Model-role settings live under
`DSH_HOME/model-orchestration`; subscriptions use their isolated DSH_HOME store.
Model settings are preferences, not part of shared portable methodology.

The default role mapping can inherit the selected chat model; there is no need
to embed one person's model choices or account into the distribution. If the
recipient enables a subscription account pool, its behavior must be accepted
separately from the airules model-rotation pool.

## Live checks still required

These fixtures prove preparation, validation and serialization; they do not
prove account entitlement, provider availability, native child generation,
response quality or behavior after a live provider quota response.

On an explicitly selected test project, each user's configured installation
should separately verify login/catalog, a small reply at selected effort, a
bounded delegated task with the displayed role/model/effort, tool use under
the selected DSH permissions and a controlled unavailable-model result.
Failover tests must not consume quotas or replay a partial production answer.
Account connection, real generation and external delivery are separate actions;
this audit did not perform or authorize them.
