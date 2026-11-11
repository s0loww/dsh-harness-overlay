# Memory approval before dispatch

By default the memory router requests native approval for every selected write
destination before creating any durable routing claim. `danger-full-access`
alone does not waive this prompt; native `never` rejects rather than granting.
Only `allowed-once` satisfies a requested native approval.

Saved global policy supports `approval: required | disabled`; a project can
override it or use `inherit`, independently of its selected memory backend.
Legacy global files normalize to `required` and legacy project files to `inherit`
without being rewritten on read. With effective `disabled`, ordinary remember,
process and processingApply omit only our additional memory prompt. `confirm:true`
still records explicit intent; native sandbox, read-only, lead/execution checks,
project/destination bindings, CAS and scope/policy revocation remain enforced.
Native MCP admission is unaffected. Deletion is unsupported and rejected by the
current action schema; it never receives the ordinary-action exemption.

A successful authorization creates an internal single-use permit for each selected
backend. It binds the native execution object/token, agent, call ID, action,
project scope, and Cognee configuration/authentication revisions. The permit is
not a tool argument or HTTP field. Cognee consumes it in its existing guarded
controller; a standalone Cognee controller still asks native approval itself.
processingApply receives a separate internal revision-bound option and verifier,
not an approval-disable field accepted from a tool or HTTP request.
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

Validation: `node --test tests/memory*.test.mjs` — 163 PASS, 0 FAIL, 0 SKIP.
The regression matrix executes the pinned SDK 0.2.2-rc.1 `ApprovalService.request`
and `decide` methods with fixture session projection/audit and answerer. Native
`never` plus `ask` rejection/cancellation/unavailability refuse Cognee, Memoria,
and both without backend calls or journal claims. Allowed-once sends to each
selected destination once, then stores separate receipts. Scope/configuration/
authentication changes during approval cause no send or claim. A local guarded
failure before dispatch is distinguished from a backend timeout after dispatch.
All writes and files in these checks are disposable synthetic fixtures; no real
memory write, model request, deployment, service restart, or policy change ran.

With the saved additional confirmation disabled, SDK policy never causes no
extra approval request; existing scope and destination guards still execute.
The package probe also verifies persisted project preference through actual
authenticated HTTP and typed MCP fixtures.
