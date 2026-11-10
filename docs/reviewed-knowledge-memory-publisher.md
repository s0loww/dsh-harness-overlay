# Reviewed lessons: unified memory publication

`airules_knowledge` publishes an approved fact/decision to one explicitly chosen
`cognee` or `memoria` destination through the existing `airulesMemory` router.
It has no direct HTTP/MCP backend, new fact store, automatic mirroring, or write
fallback. Procedures and rules retain their `airules` owner; that destination
returns a reviewed patch plan and does not apply it.

The draft → review → approve lifecycle is unchanged. Approval requires an exact,
revision-bound nonce in a fresh original user-message event, never model-supplied
text, recalled/injected text, a replacement event, or a stale pinned observation.
Current project, registered lead agent, write sandbox, expiry and native execution
token/callId remain mandatory. Native backend write approval is still owned by
the memory router and selected backend, rather than being bypassed by review.

`plan` calls `configuration({sessionId})` for the current project and returns
`memoryConfigRevision` and, for a policy-aware memory workspace,
`memoryPolicyRevision`. `publish` supplies those values as
`expectedMemoryRevision` and `expectedPolicyRevision`, respectively. An absent
or stale policy pin is rejected before dispatch. Project scope/errors and the
effective Cognee/Memoria/both mode are checked; an explicit destination cannot
enable a backend disabled by that mode. Legacy Cognee-only services returning
no policy object keep the existing configuration-revision contract.

Memoria availability is a scoped catalog check over its configured namespace and
remember mapping. It does not prove a network connection. Memoria publication
does not depend on the separate Cognee enabled flag. The actual router preflights
the selected destination, applies native approval and durable receipt claiming,
and receives an explicit `backend` argument. Thus `both` with `writeTarget:auto`
cannot redirect an explicitly selected Cognee publication to Memoria.

Cognee success remains `uploaded`, with the current project's dataset, backend
content hash and `indexed:false`; processing/search readiness is separate.
Memoria success is `stored`, with the configured namespace, a bounded returned
`recordId` and `indexed:null`. Missing/foreign/incomplete receipts remain
`outcome-unknown`, never falsely indexed or accepted as another backend's result.
After dispatch the adapter rechecks scope, expiry, configuration/policy revisions
and the router receipt policy revision. A lost authority, cancellation, changed
policy or ambiguous result retains the unknown claim and prevents blind retries.

The runtime publication cache binds the destination and its endpoint/config or
Memoria namespace/remember mapping. A Cognee receipt cannot satisfy a Memoria
request, and a record from a previous namespace cannot satisfy the new one.
The existing memory router journal handles durability across process/session
recreation using stable reviewed content/provenance bytes; the knowledge cache
does not replace that journal. Only unambiguous pre-dispatch admission refusal
releases a local claim for a fresh dispatch. No real backend write is needed for
these tests.

`tests/reviewed-knowledge-native.test.mjs` covers rc5/SDK022 mounted native
services, original-user nonce checks and revocation, plus the actual unified
router with synthetic backend adapters. Additional cases exercise both/auto
explicit routing, separate caches, disabled Cognee with Memoria, namespace
changes, stale/missing policy pins, missing execution token, incomplete/foreign
receipts, changed policy during approval/after send, and airules-only ownership.
