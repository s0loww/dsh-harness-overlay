# Reviewed lessons without another memory store

The donor's `knowledge-core.js` owns `.ai-rules/knowledge` files, a separate
fingerprint, locking and precedence layer. This port takes the useful lifecycle,
provenance, applicability and supersession concepts, but does not import that
storage layout or its rule-precedence policy. The implementation is original.

`src/reviewed-knowledge/lib/core.js` has no filesystem, network, environment or
model access. A proposal travels in the existing native session/tool journal;
approved durable content stays with exactly one selected owner: Cognee, Memoria
or a review patch for the canonical airules repository. No background harvesting,
mirror, model extraction, automatic rule editing or migration is performed.

The lifecycle functions are `createDraft`, `reviewDraft`, `approveReviewed`, and
`invalidateKnowledge`. Draft creation is available to a delegated candidate
producer. Review, approval, invalidation and publication planning require a
trusted lead-writer context. Review captures evidence verification, applicability
verification, secret inspection and a decision tied to the exact content hash.
Stale/superseded and expired proposals cannot be published. Supersession keeps
the previous ID and explicit replacement lineage; it does not delete a record.

`publicationPlan` requires one explicit destination and the exact approved
revision. Rules/procedures are sent to the rule/skill owner as a review patch;
paths are relative beneath canonical `core`, `overlays` or `targets`, and the
target's expected byte revision is mandatory. Patch creation is not patch
application, rule activation, commit or push. Native FS must independently
enforce its root, symlink protection, current rights and target revision.

## Native integration boundary

The hashes are concurrency/integrity checks, **not signatures or authorization**.
An integration must recover proposals by ID from its own native session journal,
compare the supplied expected revision to that stored record, and construct the
trusted principal from the native executing agent. Never accept model-supplied
`isLead`, actor, scope or a self-asserted approved object as authority.

`executePublication` requires three explicitly injected ports:

* `authorize(plan)`: native current-agent scope, lead ownership, approved stored
  revision, expiry and write approval; called before and after CAS journal claim.
* `ledger.claim(operationId, receipt)` and `settle(operationId, receipt)`: atomic
  entries in the **existing native session journal**, not a separate facts file.
  A claim is durable `outcome-unknown` before dispatch. Restart recovery must read
  it. A second claim must refuse until actual backend evidence reconciles it.
* `adapter(plan,{signal,operationId})`: one selected backend through its existing
  scoped API, or creation of an airules review artifact through native FS/CAS.
  It returns `{destination,targetScope,state,sourceId}`. Memory states are
  `accepted`; the airules state is `review-patch-created`. No credentials in args.

The optional generic executor's operation ID excludes the planning timestamp, preventing a newly timestamped
plan from evading same-proposal retries. Unknown send outcomes and malformed or
foreign receipts remain unknown; the executor does not retry or switch backends.
Backend output/errors are not copied into receipts. Accepted upload is explicitly
`indexed:false`; processing remains a separate authorized memory operation.
Cancellation or revocation before dispatch records `not-sent`. The native ledger
decides how to reopen that operation after review; this core never clears it.

## Installed native tool

Mount `airules-reviewed-knowledge/host` globally after the existing memory
workspace service, and `/agent` in the three custom presets. The host injects
`agents`, `agentPresets`, `sandboxPolicy`, `sessionQuery`, `airulesMemory`; the
scoped tool injects only `tools` and `airulesKnowledge`. `airules_knowledge` exposes
list/create/read/review/approve/stale/supersede/plan/publish. Scope/project and
lead identity derive from the registered native executing agent, never args.

`review` returns a one-use approval phrase binding ID, reviewed revision and a
random nonce. `approve` checks the latest original appended native user message
through SessionQuery. It must exactly match that phrase and follow the review
checkpoint. Inherited history, recall-form messages, generated continuity events
and replacement/compaction messages are excluded. Passing model-created approval
text as an argument is rejected. This is deliberate explicit user review of a
durable lesson; ordinary task steps do not invoke it.

`plan` for Cognee returns `memoryConfigRevision`. `publish` requires that exact
revision, retrieves the stored approved record and calls the existing
`airulesMemory.act({action:'remember',confirm:true,...},exec)`. That service keeps
native write approval and its existing endpoint-bound durable write journal.
The emitted bytes contain the reviewed statement and stable source/applicability
metadata, allowing its existing content-hash deduplication to work even after a
candidate is recreated and re-reviewed. The native tool also blocks same-runtime
retries after an uncertain send. A changed backend configuration requires a new
plan. Receipt scope must match the derived project dataset. Upload stays
`indexed:false`; processing remains a separate authorized operation.

Only Cognee has a durable publication adapter here. Memoria and airules return
explicit previews, with no backend call or applied rule. The runtime does not
create a new knowledge database: after restart candidates must be reconstructed
from the native tool log and reviewed again. Previously written Cognee data and
its write journal remain with the existing memory owner. Pending/stale proposal
state does not silently rewrite or invalidate an already-published backend note;
that reconciliation remains explicit through the backend's supported API.

Validation: `node --test tests/reviewed-knowledge*.test.mjs` exercises lead-only
review, content/revision binding, expiry and lineage, destination/path ownership,
native refusal, permission revocation, uncertain sends and non-retry, foreign
receipts, journal failure, real rc5/022 SessionQuery/Cordis/ToolsService mounting,
original user approval, delegated/read-only refusal and exact-memory-adapter
dispatch/deduplication. No paid model or real deploy.
