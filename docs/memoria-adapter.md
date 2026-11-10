# Typed Memoria project adapter

`src/memory-workspace/lib/memoria.js` provides `validateMemoriaBinding` and
`createMemoriaAdapter(ctx, {binding, execution, verifyScope, executeTool?})`.
The adapter owns no endpoint, credentials, filesystem store or automatic retry.
The memory router owns effective policy, native project identity, mutation
approval and durable per-target intents.

A binding fixes a server namespace/project marker and explicit fields from the
currently visible native MCP tool schema. Search maps a scope and query field;
remember maps scope, text and optionally title. Fields may use declared dotted
object paths. Scope values can be a string or a one-element string-array for
tag/project-membership filters. Required fields that are not mapped fail before
dispatch. `additionalProperties` is not permission to invent a missing filter.
Mappings cannot overlap or address prototype/constructor fields.

The MCP server name is explicitly configured. It need not be `memora`; no facade
or HTTP endpoint is inferred. `status()` reports catalogue availability with
`connected:null`, not connectivity. Actual reads/writes enter the native tool
pipeline under the original agent, parent token, root call ID and cancellation
signal. Staging substitutes the rc5 or exact 0.2.2 native helper.

Before and after dispatch, scope, cancellation, visible definition identity and
the parameter-schema digest are checked. Native guards and approval remain
authoritative during the nested call. An HTTP controller may enter the parent
`airules_memory` tool through the native pipeline without using a chat model;
it cannot replace that parent with a fabricated execution token.

Search accepts structured JSON/MCP text-JSON envelopes with results, memories,
notes, items, records or data. Results are bounded and expose text plus backend,
namespace and source record/tool evidence, not arbitrary provider metadata.
Explicit response namespace mismatches fail closed. A configured membership
array must contain the requested project marker; other ordinary tags are not
treated as foreign namespaces. Missing response scope is honestly labelled
`request-filter` evidence, not proof of server-side access isolation. Raw scores
remain local to this backend and must not be averaged with Cognee scores.

Remember forwards only the exact mapped payload. A backend acknowledgement can
produce `stored`; searchable indexing is left unknown. The logical operation ID
is receipt correlation, not a fabricated backend idempotency parameter. A tool
error, timeout, malformed acknowledgement or late scope/definition revocation
returns `outcome-unknown`; the parent journal must reconcile rather than retry
or mirror to another destination automatically.

Validation: `node --test tests/memory-memoria*.test.mjs` — 14 tests, including real
rc5 and 0.2.2 ToolsService, scope guards, native approval/revocation and nested
parent/root correlation. Tests use synthetic tools only, with no remote MCP,
paid model, real memory ingestion or deployment.
