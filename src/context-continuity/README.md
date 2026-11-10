# Continuity adapter DSH

Canonical `project_rules/core/tools/continuity` owns policy, limits and fixtures.
The bundle copies its three JSON files verbatim to `runtime/continuity`; a missing
contract prevents plugin activation. There is no independent policy fallback.

The global entry owns `airulesContinuity`; `./agent` registers
`airules_continuity` only in our 1C/Python/sysadmin presets. Config defaults:
`mode: minimal`, `criticalFiles: []`, `collectGit: true`. Minimal returns reminders,
source IDs/versions and owned state references, with a strict 4096 UTF8 byte cap.
Balanced is opt-in (12288 bytes), restoring at most two explicitly marked/configured
task files of at most 2048 bytes each, freshly through native FS. Native skills and
rules are only referenced for re-resolution; cached bodies are never replayed.

Exact native start/end compact IDs gate a single delivery in `agent/pre-step`
after native compaction middleware. Failure, cancellation, missing scope or rejected
steps do not consume restoration. Retained native tool receipts suppress duplicate
file text. Restart recovery accepts only a successful native compact at the journal
tail, excluding inherited child history and later conversation. No invented native
event is appended. User messages use the official message constructor and normal
pre-step return channel.

Checkpoints use native FS CAS publication at ordinary step boundaries, not an async
precompact gate. A checkpoint is at most 4096 bytes, includes canonical scope,
timestamp, partial status, Git metadata and source receipts, never bodies/diffs/
credentials. Native read-only mode has transient fallback, with no write escalation.
Git uses the native process service and sandbox forced to read-only, scrubbed env,
bounded output and deadline. No model, MCP, memory write, checkout/reset/stash or
deployment occurs. Link traversal, private files, secret-like source text, changes
of native agent/root/origin/policy and source-version races fail closed.

Native API probes cover official 0.2.1-rc.5 and 0.2.2-rc.1 Session and LocalFileSystem.
`node --test tests/context-continuity*.test.mjs` and
`node scripts/probe-continuity-native.mjs [sdk-node-modules]` run offline fixtures.
The probe is a real native lifecycle/FS integration, not a paid model acceptance run.
