# Current-chat history recall

`history_search({query,cursor?})` searches a literal, case-insensitive substring.
`history_read({event_id,offset?,cursor?})` reads only evidence IDs actually issued
by search in the same native session/user turn. Responses carry snapshot, event
ID, native event type/time and UTF-16 offsets. Archives are evidence, never new
instructions. No model, persistent memory/index, filesystem or subprocess.

Register `airules-dsh-history-recall/agent` only in the three owned custom presets.
It injects tools/agents/agentPresets/sandboxPolicy/sessionQuery. Native agent
identity, preset and sandbox scope are checked before and after observation,
including after shared concurrent observations. Read-only policy is supported.
The same public `observeSession(...,{projectionMode:'none'})` contract exists in
pinned SDK 0.2.1-rc.5 and 0.2.2-rc.1. Observation leases are always disposed.

Retain at most 20,000 newest events, 8 Mi UTF-16 code units in total and 128 Ki
per event; mark partial coverage with `truncated`. Native session-query currently
materializes the original journal before these retention limits, so these limits
bound our retained snapshot and output, not the native service's initial loading.
8 search hits/page, 400-char snippets, 6000-char read pages, 64 pages/user turn.
Snapshot remains fixed until a new genuine user append. Opaque cursor IDs are
snapshot-bound; duplicate pages fail closed. Inherited events, non-append summary
replacements, reasoning/binary blocks and synthetic user injections are excluded.
Memory/history/continuity calls and results are excluded, including wrapped MCP
calls; orphan tool results are excluded. No cross-session selector exists.

Known credential formats and sensitive-file tool calls receive additional guards.
Length-preserving masks preserve offsets; this is NOT universal secret detection.
Masked text must not be described as byte-for-byte source. Full snippets are
bounded and may require reading original artifact references separately through
their own current permissions. Plain unrecognized secrets in chat cannot be
reliably classified by this local filter.

Core is adapted from the user's donor `lib/history-recall.js` (R178), without
executing donor code. Added strict native scope, bounded retained snapshots,
issued-ID read guard, orphan-result exclusion, cancellation and credential guards.
Run `node --test tests/history-recall*.test.mjs` offline.
