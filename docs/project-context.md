# Shared project context for settings

`airules-dsh-project-context` separates settings ownership from the native context
used to execute an operation. A setting belongs to a registered project; its
executor is selected automatically and is not a settings selector exposed to the
user. The service does not create, resume or send a message to an agent.

## Native ownership

The server reads `workspaceRegistry.list()`. Its canonical native workspace roots
are authoritative; duplicate records for one root are presented as one project.
An HTTP caller can select a registry ID, never an arbitrary absolute directory.
Session membership, current root, physical realpath, preset, lead identity and
native sandbox policy are checked when resolving an executor. Bounded cold
projections can support existing pure settings readers; an operation requiring a
live agent remains unavailable without one. There is no hidden resume of queued
model work.

The global selection is a small CAS-guarded file at
`dshHomePath('project-context')/selection.json`, independent of chats. Without an
explicit choice, the UI follows the active registered project. Switching between
chats of that same project preserves the owner ID. Changing a native chat's
permissions can update the executor metadata; it does not create another copy of
the settings.

## Server integration

Mount the package once globally. Its host injection list uses the native
`workspaceRegistry`, `agents`, `sessions`, `sessionPersistence`,
`sessionProjections`, `agentPresets`, `sandboxPolicy`, `webServer`, `connection`
and `dshHomePath` services. It provides `airulesProjects` and the authenticated
`/airules/projects` endpoint. Selection changes additionally require CSRF and the
current selection revision. No content, account, credential or model request is
part of the API.

`resolve(projectId, options)` returns a scope containing project ID/root,
session ID, actual native policy, optional live agent and writable flags.
`resolveInput(input, options)` validates an explicit project plus any pinned
executor. `bindInput` returns a clone with project transport fields removed and
the native `sessionId` populated. Legacy inputs containing only a real session ID
remain subject to the original endpoint's guards.

`bindHandler(handler, options)` adapts existing project routes. It validates
native admission before reading JSON, maps a verified project request to the
native executor, and delegates to the existing handler. The existing handler
still owns CSRF, its own body limit, write/full-access rules and native tool
approval. Default wrapper body limit is 1 MiB; a route can set `maxBodyBytes`.
Legacy POST bodies are replayed with their exact bytes on a request clone which
preserves the IncomingMessage prototype, socket and authentication headers.

Project requests pin `sessionId`, `expectedProjectRoot` and an
`expectedExecutorRevision` derived from the native policy. They do not select a
more privileged chat after a read-only executor was shown in the UI. Project
POSTs without a pin are refused. An explicitly declared `allowGlobalActions`
list lets machine-level preferences omit project execution; those actions still
run the original admission/CSRF handler. `allowUnresolvedConfiguration` permits
an existing memory configuration reader to expose global preferences when a
registered project has no compatible executor.

The forwarded request carries a process-private lease at
`Symbol.for('airules.project-request')`. Its `assertScope(scope)` compares the
endpoint's resolved root, ID, mode and writable flags, then re-reads the native
authority. Route owners call this after awaited scope/body reads and before
effects. `verify()` performs the registry/root/agent/policy recheck alone. The
lease is not accepted from JSON, and none of its transport stamps are forwarded
to old strict input schemas.

## Client integration

The package's client plugin requires native `sessions` and `workspaces` services.
It exports:

- `useProject({presets?})`: `projectId`, `projectRoot`, `sessionId`,
  `executorRevision`, rights/availability, project rows and `selectProject`.
- `ProjectPicker({project,disabled,beforeChange?,onChange?})`: a project-only
  selector. `beforeChange` may cancel a switch with unsaved edits.
- `fetchFor(project)`: a local fetch closure for existing settings components.
- `projectFetch(url, options, project)`: the explicit form of the same adapter.

Settings components use `projectId` for their React key and draft/result reset
boundary. They must not use `sessionId` as the owner key. The fetch adapter only
rewrites known registered project IDs in `/airules/` requests; it never monkey
patches global fetch. Existing internal query/body `sessionId: projectId` fields
are translated into project fields plus the exact executor pin. A matching
project context is required for translation; a global last-used chat is never
substituted. Genuine legacy session IDs and non-Airules URLs are unchanged.

## Verification

`node --test tests/project-context*.test.mjs` verifies native SDK022 Cordis
mounting, its SandboxPolicyService, real HTTP admission/prototype/body behavior,
CAS persistence, cross-project rejection, cold read authority, absence of agent
creation/resume, executor pinning, permission/root changes across awaits and a
client hook whose project owner stays stable across two native chats.

No model, real deployment, account migration or live project write is needed for
these tests. Actual mounted-release and Desktop checks belong to the release
integration and are recorded separately.
