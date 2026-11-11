# Project airules rollout service

`src/git-maintenance/lib/rollout.js` exports `createRolloutService` and
`defaultRolloutBindings`. The current canonical DSH renderer supports the
portable `public` profile for the 1C stack. Python/Codex/Claude target rendering
must be added explicitly rather than silently producing 1C rules for them.

## Host contract

```js
createRolloutService({
  root,                  // absolute private application state directory
  run,                   // run(argv, {cwd, signal, timeoutMs, outputLimit, execution, kind})
  verifyScope,           // async(scope, {writing, signal})
  python: 'python',
  rendererPath,          // defaults to bundled rollout-engine/entry.py
})
```

The scope contains `projectId`, `projectRoot` (or `root`) and `writable`.
The host resolves it from the registered native project and a pinned native
execution lease; the service never creates a chat or chooses a different agent.
Every awaited process and every actual project file mutation rechecks this
lease. Python uses fixed argv `-I -B -X utf8`; execution is provided by the
native process adapter, never an ambient shell string.

Methods:

- `defaults(scope)` returns the portable, editable placeholder contract.
- `status(scope, execution)` returns installed version/revision, managed-file
  drift, default bindings and bounded recent receipts for that project.
- `plan(scope, {source, bindings?, includeSkills?, adoptExistingInstructions?}, execution)`
  returns `planId`, `status: ready|blocked`, source, counts, changes and conflicts.
  `source` is a host-prepared immutable `{root, commit, repository?, ref?, kind?}`.
- `detail(scope, {planId, path}, execution)` returns the exact bounded before/after
  Markdown for a reviewed file, or binary/hash metadata. Changed bytes invalidate
  this preview rather than showing another project's/current revision as old data.
- `apply(scope, {planId}, execution)` returns an application receipt ID.
- `rollback(scope, {receiptId}, execution)` restores only exact owned applied bytes.

`includeSkills` defaults to false: the installed bundle already provides shared
skills. Explicit skill rollout copies canonical skills as files without executing
helpers. Existing higher-priority `.agents/skills` conflicts are always blocked;
managed `.dsh/skills` updates are supported. There is no automatic removal of user
skills, force overwrite, MCP import or replacement of `USER-RULES.md`.

## Reusing the canonical renderer safely

The bundled `rollout-engine/render.py` and `composition.py` are a trusted closure
copied from canonical airules, revision `82c10a4`. `entry.py` imports these local
modules and overrides composition loading to the trusted resolver. It also
replaces the renderer's Git state probe with inert data; the host pins the exact
verified source commit in the resulting manifest. Fetched Python files, Git
filters/hooks and skill helpers are never executed by rendering.

`render` and `verify` use a private planning project containing only copied
instruction-budget files and empty skill-name collision directories. Real
`.mcp.json`, environment files and account data are never read by the renderer;
even a malformed project MCP file does not block a rules-only rollout. Changes
to user instruction evidence after preview require a new plan.

Canonical `apply` and `rollback` are exercised in a private shadow project.
The actual project is changed by guarded Node file operations, each with pinned
before hashes, root/link/hardlink guards and a repeated native lease check.
The service permits only `AGENTS.md`, `.dsh/rules-1c/*`, optional `.dsh/skills/*`
and its managed `.airules-manifest.json`. It does not deploy or run project code.

An unmanaged `AGENTS.md` is a conflict unless the specific plan explicitly adopts
it. Previously managed but manually changed files stay conflicts. Source input
hashes, candidate hashes, instruction evidence, project before hashes and plan
digest are rechecked before applying. Secret-free MCP behavior is fixed, not
inferred from the source profile or source repository scripts.

## Backups and interrupted operations

A project-exclusive `.airules-rollout.lock` prevents overlapping cooperating
processes. Its own token is checked before cleanup; an unknown existing lock is
never removed automatically. The private state root contains immutable plans,
original-byte backups, canonical shadow evidence and per-operation receipts.
An interrupted write returns `error.receiptId` when a journal exists; the host
should include this ID in its error response and offer recovery after permission
is restored. Receipt status is `applied`, `interrupted`, `rolling-back`,
`rollback-interrupted` or `rolled-back`. Rollback can resume from its per-file
journal; it refuses foreign edits and preserves byte-exact BOM/newline content.

The service reports `reload: new-chat-or-explicit-native-instruction-refresh`.
Writing rules does not prove that an existing agent reloaded them; the host must
use a verified native refresh mechanism or explain that a new chat is required.

## Verification

`node --test tests/git-maintenance-rollout.test.mjs`: 10/10 PASS. Tests execute
the real trusted canonical Python renderer on isolated Unicode fixture projects,
not a mirrored implementation. Covered render/verify/apply/rollback, public
profile, managed update, instruction adoption, exact original BOM bytes,
read-only/revocation, concurrent project/source changes, parent junctions,
malformed MCP preservation, higher-priority skills, ignored hostile source Python,
interrupted apply recovery and interrupted rollback resumption. No working
project, MCP server, model or real deployment is invoked.
