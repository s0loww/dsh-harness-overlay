# 1C capability and investigation adapters

Host mount `airules-dsh-onec-capability-workflows` provides
`airulesOnecCapabilities`. Mount `airules-dsh-onec-capability-workflows/tools`
only in the `1c-airules` composition. Native peers: dsh-tools and dsh-home-paths
0.2.1-rc.5. No external runtime/dependency closure or network binding is required.

`airules_capabilities` searches actual scoped native tool schemas. It returns
bounded candidate names/descriptions/parameter schemas and schema digests, with
pagination. Definitions are not proof of server health, target coverage or tool
effects. No call, connection, URL probe or process is started.

`airules_debug_case` supports list/open/status/evidence/close. It keeps a real
project-scoped notebook under DSH_HOME/onec-capability-workflows/cases, with
revision CAS, hypotheses, source/report hashes and fresh/stale observations.
Only selected project-relative regular files can be attached; links, hard links,
parent traversal, environment files and oversized artifacts are rejected. Cases
are project-bound, so a session in another workspace cannot read or amend one.

The notebook writes its own private metadata, including in a read-only project
session; it never writes project source. It does not instrument BSL, deploy,
start an infobase, query journals or certify assertions/cleanup. Outcome
reported-resolved is explicitly a caller report, never PASS. Live reproduction,
probe edits and cleanup remain operations of independently available project
tools under native permissions. Cancelled/interrupted invocations do not become
successful runtime verification.

These tools and the corresponding thirteen portable skills replace donor-only
tool-name assumptions. They do not port a second MCP manager or project wizard.
The Telegram target skill documents the already implemented bridge controls;
it does not send test messages or contain credentials.
