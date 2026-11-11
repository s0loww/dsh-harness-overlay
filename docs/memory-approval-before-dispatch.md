# Memory approval before dispatch

The memory router requests native approval for every selected write destination
before creating any durable routing claim. This preserves the existing policy:
`danger-full-access` does not waive memory approval; the native `never` policy
rejects rather than granting permission. Only `allowed-once` authorizes a write.

A successful decision creates an internal single-use permit for each selected
backend. It binds the native execution object/token, agent, call ID, action,
project scope, and Cognee configuration/authentication revisions. The permit is
not a tool argument or HTTP field. Cognee consumes it in its existing guarded
controller; a standalone Cognee controller still asks native approval itself.
Permits expire when the routed call ends, including errors and duplicate receipts.
Project policy, configuration, credentials, and native scope are rechecked.

An internal callback marks entry into backend execution after the controller's
local guards. If a newly claimed operation fails before that marker, the router
can remove only its own unsent claim and report `not-attempted`, `retrySafe:true`.
Once dispatch is entered, timeouts or uncertain outcomes retain their durable
`outcome-unknown` receipt. Memoria's underlying native MCP admission remains
authoritative; a failure after invoking that adapter is conservatively unknown.

Historical unknown receipts are not automatically reset. This change does not
touch live journals or retry an old operation. Recovery requires separate proof
that the original attempt failed before dispatch, followed by a narrowly scoped
backup/CAS operation; absence of a backend document alone is insufficient proof.

Validation: `node --test tests/memory*.test.mjs` — 141 PASS, 0 FAIL, 0 SKIP.
The regression matrix executes the pinned SDK 0.2.2-rc.1 `ApprovalService.request`
and `decide` methods with fixture session projection/audit and answerer. Native
`never` plus `ask` rejection/cancellation/unavailability refuse Cognee, Memoria,
and both without backend calls or journal claims. Allowed-once sends to each
selected destination once, then stores separate receipts. Scope/configuration/
authentication changes during approval cause no send or claim. A local guarded
failure before dispatch is distinguished from a backend timeout after dispatch.
All writes and files in these checks are disposable synthetic fixtures; no real
memory write, model request, deployment, service restart, or policy change ran.
