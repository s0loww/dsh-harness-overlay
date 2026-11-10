# Project memory integration review

Independent source review, 2026-11-10. Scope: owned
`src/memory-workspace/lib/{core,control,client,index,tools}.js`, native rc.5
approval/subagent contracts and memory fixtures. Final reviewed core includes
endpoint-bound journal v2. No remaining blocker was found within this scope.

This is a component review. It does not certify a packaged artifact, installed
Desktop boot, paid-model behavior or production memory migration.

## Findings resolved

| Finding | Final behavior and evidence |
|---|---|
| HTTP writes bypassed turn-enclosed native approval | Settings queues a native user followup; only the tool executes the mutation inside a real turn and requests native approval. HTTP submission performs no upload/processing. UI warns that the selected chat model will be invoked, retains the note and labels the result as submitted, not completed. |
| Scope/configuration could change while approval was pending | Native scope includes live agent identity, session/header ID, composed preset and policy session/root. Root, public config and private-auth revisions are checked across awaits. Controller single-flight blocks competing operations and configuration changes while an operation is active. |
| Subagent writer ownership was only instructional | Durable native `header.origin:subagent` permits retrieval but denies memory mutations and machine configuration changes. The actual rc.5 subagent lineage contract was inspected; no guessed parent property is used. |
| Recreated service instances could lose journal receipts | Process-local coordinator shares receipt maps, initial loading and atomic-save serialization for the resolved journal path. The delayed-old/new-service fixture retains both receipts and blocks an uncertain duplicate. Controller cache is bounded to one instance and does not rotate an active operation. |
| Dataset-latest completion could release an unrelated pending run | Task reconciliation queries dataset-scoped pipeline activity and matches the exact known pipeline-run receipt. Only its terminal result releases the corresponding processing-requested record. Dataset-ready or an arbitrary task ID alone never does. |
| HTTP-success pipeline failure allowed blind resubmission | Failed/errored ingestion or processing returned in a successful HTTP response remains outcome-unknown. Unknown results retain the journal reservation, including across service recreation/restart. |
| Graph scope depended only on request parameters | Graph verifies current dataset documents. Foreign document/chunk provenance is rejected; chunk anchors require document IDs or a validated memory-map relation. Directed structural expansion includes owned chunk→entity, entity→type and summary→chunk only. Arbitrary semantic/shared-type expansion is excluded. Output is bounded, structural and explicitly partial. |
| Old receipts could claim success after endpoint replacement | Journal v2 persists its endpoint identity. A different endpoint with that journal fails closed before dataset/graph access or mutation. API-key rotation for the same endpoint retains receipts; credentials are never journal metadata. Legacy v1 is refused instead of silently migrated. POSIX path case is preserved. |

## Verified boundaries

- Native HTTP admission precedes actions. GET mutation, unprotected POST,
  foreign execution agents, caller-supplied dataset/root and read-only mutations
  are refused before backend effects.
- Settings credentials are private machine data read lazily from `auth.json`;
  public configuration responses and errors do not reveal the API key. Only
  numeric HTTP loopback is supported, with redirects rejected.
- Retrieval checks both dataset envelopes and document membership. Retrieved
  text and graph labels are historical evidence/data, not active instructions.
  React renders labels as text; graph properties, session events and raw server
  exception bodies are not returned to the user.
- Notes are uploaded as literal file bytes. URL-looking text is not submitted
  as a server fetch target. Upload acceptance, processing request and exact
  completion remain separate states.

## Executed validation

```powershell
node --test tests/memory-core.test.mjs tests/memory-control.test.mjs
```

**35 PASS, 0 FAIL, 0 SKIP**: core 25 and control 10. These use synthetic HTTP,
native approval/session mocks and temporary journal files; they make no paid
model calls, real memory uploads or deployments. `git diff --check` passed.
The actual pinned-server synthetic acceptance fixture
`cognee_local/acceptance-auth.json` was inspected to check graph document/chunk
and structural-edge shapes; this review did not rerun its live mutations.

The portable skill has separate canonical evidence: validator, layer/composition
checks, Claude installation simulation 19/19, DSH renderer 5/5, embedded rulepack
4/4 and Codex renderer/ownership 14/14 passed. Those gates establish assembly
and policy-resource delivery, not retrieval quality.

## Exact limits

The graph is a conservative structural preview, not the full semantic knowledge
graph or the graph of 1C code. Missing/foreign provenance fails closed. Native
scope and a dataset naming convention are not a substitute for server access
control; the local authenticated server remains part of the trust boundary.

Journal coordination is inside this DSH process, not a cross-process lock or a
distributed transaction. Do not run multiple independent DSH hosts against the
same journal file. The journal binds a URL, not a cryptographic server instance:
resetting/replacing its database at the same URL or changing its principal needs
explicit reconciliation. No automatic migration, unknown-receipt reset or backend
fallback is provided. A rejected legacy journal needs an explicit maintenance
decision; it must not be deleted merely to retry a pending write.

HTTP settings writes deliberately invoke the selected chat model, with ordinary
native approvals. A queued request can fail later; neither submission nor this
review certifies its execution. Real deployment remains outside this work.
