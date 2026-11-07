# Independent review: specialized 1C and optional provider bindings

Scope: own `provider-extensions` wrapper, `onec-specialized` HTTP/client surfaces, and `onec-panels` graph/background tool surfaces. Third-party SDK implementations and pinned native rc.5 APIs were read to verify contracts; no third-party or implementation source was modified by this review. No account login, network request, live project write or real deployment was run.

## Findings

1. **P1, fixed by owner during review:** specialized HTTP control originally accepted GET `save-binding` and `run-in-chat`; the CSRF gate only covered POST. Owner added the GET action allowlist (`undefined`/`status` only) before scope/dispatch. The reread source contains that guard. A regression should exercise GET for both mutating actions and confirm zero fs writes/followups.
2. **P2, sent to owner:** specialized client `Settings.act` originally lacked the epoch guard already present in `load`. An outstanding POST from project A could populate data/text/plan after switching to project B. Backend service/evidence ownership prevents executing A's plan in B, but showing stale binding text/version can cause an unintended subsequent save into B. Capture the epoch before await and guard all state updates (including catch/finally), clear project-scoped form state on session change. This finding is about source at review time; final owner edits must be reread separately.

No additional blocking authority, credential import or native API mismatch was found in the reviewed surfaces.

## Verified boundaries

- `publishProfile` uses actual native `ConfigEditor.edit(entry, change)` semantics; its callback receives current effective config. It copies the agent map and removes/replaces only its owned profile, retaining other ACP agents and unrelated config fields. It explicitly sets the adapter approval default to `ask`.
- Google SDK imports are lazy and explicit. Supplying an actual `AntigravityRuntime` connection factory disables its managed setup/default session store. The factory supplies the selected executable/arguments and isolated HOME/GEMINI_HOME/environment, rather than ambient API keys or CLI auth directories. Actual `AntigravityProcess` uses `options.env` when provided. Auth inspection/forget receive the explicit private antigravity directory. The optional headless relay forwards only BROWSER/capture/PATH, not its ambient environment. On Windows normal browser mode is used; the SDK's manual headless relay is not supported there.
- Muse uses actual `spawnMspConnection`, initializer result `.connection`, account/loginStart, account/loginCompleted, account/read and model/list. Its spawn implementation forwards the explicitly supplied env without merging ambient credentials. The MSP auth process is closed in finally, abort closes the child, and cancellation prevents late connection state publication. Local Muse disconnect renames only the owned directory after realpath containment checks; it does not guess a remote logout method or delete external account state.
- Both provider runtime profile publication and auth/forget operations require native HTTP connection admission and POST CSRF. The executable is selected/pinned explicitly; no automatic runtime binary installation occurs at boot. Driver action state is serialized. Configuring a runtime does not mean enabling or authenticating it.
- Specialized HTTP routes resolve the active native agent, composed 1C preset, actual sandbox and project root, and expose no caller-controlled project root. Native fs versioned writes preserve BOM/newline conventions. Plan execution remains a followup into the real native agent, not execution inside the web handler; backend native approval and runner/sandbox gates remain authoritative.
- Graph snapshots originate from successful MCP tool results, bind to native session/root, expire and are bounded. React creates SVG and text elements directly; labels/IDs are not interpolated into HTML, URLs or executable SVG markup. Truncated/degraded data is explicitly presented as partial evidence.
- Native jobs-local `start({owner})` resolves a live agent, `view()` returns owner ID, and list/kill enforce caller ownership. Workbench additionally filters matching owner and requires a verified project session for HTTP cancellation. Native tools `execute` accepts the passed `agent`, `rootCallId`, `parent` execution token and signal; the wrapper preserves those values and invokes the ordinary registry, retaining native policy/approvals/PTC lineage. Background allowlisting is explicit machine configuration, not a model claim of read-only safety.

## Executed checks

`node --test tests/provider-extensions.test.mjs tests/provider-extensions-closure.test.mjs tests/onec-panels.test.mjs`: **22 pass, 0 fail, 1 explicit-source integration skipped**. The skipped test needs an explicitly provided donor path and performs separate pinned closure/cold-import probing. The executed process fixture uses a temporary synthetic program, not Google/Muse account actions. Actual native API source was independently checked for ConfigEditor, tools registry, jobs owner/list/kill and the Google/Muse SDK spawn/auth interfaces.

The owner's native specialized/PTC acceptance probe was read for coverage but not rerun by this review. Final staged UI wiring/production assembly and real paid-provider/account behavior are outside the executed checks above.

## Follow-up after owner fixes

Reread the updated HTTP/client/workbench code after the owner added runner setup
and strengthened session isolation. GET now refuses every action except status;
runner installation also requires authenticated POST, CSRF, writable native
policy and versioned native fs writes, and installs only packaged template bytes.
The specialized client now checks currentSession, epoch and actionSequence before
accepting POST success/error/finally updates. The original stale-POST finding is
closed. All labels/JSON remain React text; no new markup injection path appeared.

One nonblocking remaining draft-isolation observation was sent to the owner:
session changes cleared binding text/plan/error/busy, but retained repository
objects/comment. Clearing those two fields also avoids suggesting a new plan in
project B with project A's input. Backend project scope and approvals still apply;
this is not an execution authority bypass.
Owner subsequently added both resets to the project-switch effect; rereading
the current client confirms the remaining draft-isolation observation is closed.

`node --test tests/onec-specialized-control.test.mjs tests/onec-workbench.test.mjs`:
**10 pass, 0 fail**. These cover GET/CSRF admission, owned plan followup, native
write policy/CAS/BOM, packaged runner setup, graph session/root expiry, background
parent-token forwarding, cancellation after late success, and owner-only HTTP
cancellation. No real backend/account/deployment call was made.

## Final packaging and cold-boot review

After the packaging owner froze `stage-official-policy.mjs`, provider closure
staging and manifest guards, the independent reread found no new blocking issue.
The initially suspected optional-client dependency failure was disproved by the
actual pinned native module loader: `ClientModuleSystem.arriveGraphRow()` iterates
`row.inject`, loads a dependency only when `graphRows.get(packageName)` exists,
and skips an absent row. Therefore the advanced provider preload declarations
plus `optionalModule()` fallback are compatible: enabled modules arrive before
the consumer; disabled modules remain absent without becoming mandatory imports.
No UI17 artifact change was requested for that withdrawn hypothesis.

New host integrations have exact unique managed mounts; specialized and
background tool packages are constrained to the 1C preset composition. Manifest
schemas reject unknown integration fields, eager bootstrap, automatic runtime
download, positive default external-runner trust and bundled Cursor SDK claims.
Provider closure identity is re-inspected against the repository lock, and the
artifact's exact file set/hashes and operations are checked. Cursor source copy
filters node_modules; SDK code is not in the provider closure. No claim is made
that every dependency is MIT: the 117 locked packages comprise **103 MIT,
9 ISC, 3 BSD-3-Clause, 1 BSD-2-Clause and 1 Apache-2.0**. The lock contains no
`@cursor/sdk`; copied libraries retain their package license/notice files.
Explicit Google/Muse runtime executables and Cursor's proprietary runtime remain
external. Source auth state lives outside the source/staging roots and was not
read or imported by these checks.

Cold host registration creates controllers/routes/adapters, not OAuth attempts,
SDK agents or runtime installations. Google/Muse SDK imports occur inside explicit
auth/status actions. Cursor loads its external SDK only for explicit login,
catalog refresh or an authorized agent-loop dispatch. The settings page mounts
an advanced panel on first opening its card; a status read has no login side
effect. The actual closure cold-import probe denies fetch/socket/HTTP/child-process
APIs before importing the real library entrypoints, and checks their public APIs.

Executed after freeze:

- Explicit-source `provider-extensions-closure.test.mjs`: **4/4 PASS**, including
  actual 117-package copy/hash/license verification and real SDK cold import with
  network/subprocess denied. All output/work lived in disposable test directories.
- Packaging/migration/providers UI selection: **20/20 PASS** across
  provider-features-packaging, policy-host-migration, cordis-migration and
  providers-settings-extended tests.
- Current `verifyPolicyArtifact()` accepted immutable legacy **0.12.0-dev39**:
  **26 packages, 5642 files**, read-only, without rewriting its manifest or bytes.

The final new production artifact still needs its own staged manifest verification
and native boot acceptance by the owner. This review performed no account login,
real inference, live MCP operation or deployment.
