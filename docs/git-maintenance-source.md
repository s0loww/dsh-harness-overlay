# Managed Git sources

`src/git-maintenance/lib/source.js` supplies source snapshots for rule rollout and
harness release preparation. It does not install packages, apply project rules,
run received code, publish data, select models or change the official Desktop.

## API

`createGitSourceService({root, run})` exposes `status(input, execution)` and
`prepare(input, execution)`. Input is `{kind, repository?, ref?, localPath?,
allowDirty?}`. Kinds are `airules` and `harness`; defaults are respectively
`https://github.com/s0loww/airules.git` and
`https://github.com/s0loww/dsh-harness-overlay.git`, branch `main`. These defaults
contain no personal filesystem paths. A local source defaults to committed `HEAD`.
The host owns configuration and authorization of a local path.

Only HTTPS GitHub owner/repository URLs are accepted. Credentials in URLs,
queries, fragments, other transports and revision expressions are rejected.
Normal branch/tag names and full commit IDs are accepted. No network action
occurs during status reads or module initialization.

`prepare` returns `{schemaVersion, kind, repository, ref, root, commit, source,
dirty, inventoryDigest}`. `root` is a separate managed, detached Git worktree;
canonical renderers can inspect its exact commit without touching the user's
checkout. The caller pins this result when preparing a candidate. `status` shows
only the last cached revision for the exact source/ref and performs no Git call.

The injected `run(argv, options)` is the sole process capability. Options include
`cwd`, `execution`, `signal`, `timeoutMs`, `outputLimit` and a limited `env` map.
The native host must honor these environment overrides and retain its own
permission/approval checks. It returns `{code,stdout,stderr}`; raw Git errors and
credential-helper output are never returned to the client by this module.
`execution.verify()` and abort state are checked before and after process/file
work. Timeout/output enforcement belongs to the native runner as well as the
core's bounded returned-output check.

## Snapshot ownership and verification

- Remote fetch is an explicit action into an owned bare cache. GitHub HTTPS is
  the only enabled remote transport; recursive submodules are disabled. Existing
  machine Git authentication can be used, with interactive prompting disabled.
- Local acquisition reads the selected root and commit, refuses a dirty source
  by default, then performs an optimized bare clone with no hardlinks. It never
  checks out, pulls or writes in the source directory. Explicit `allowDirty`
  snapshots only the committed revision and reports `dirty:true`; uncommitted
  changes are never silently copied or committed.
- Git hooks and filesystem monitor commands are disabled. Materialization uses
  an empty system/global configuration and no system attributes, so received
  `.gitattributes` cannot invoke a global smudge/process helper. Declared local
  clean/process filter commands are disabled before source-status inspection.
  A source that relies on conversion filters may therefore require the explicit
  committed-only choice rather than being classified as clean.
- Paths are confined to owned cache roots, with ancestor/junction/symlink checks.
  Gitlink and symlink tree modes are rejected before checkout. No recursive
  deletion is performed on a computed path outside the checked cache root.
- Commit/tree blob identities, per-file SHA-256 inventories and the detached
  worktree's `.git` binding/HEAD are checked. Expected Git CRLF normalization is
  allowed while retaining actual worktree bytes: canonical airules explicitly
  requires CRLF plus BOM for PowerShell. A cached snapshot's raw inventory must
  still match exactly. Modified snapshots are refused, not reset automatically.
- A lock protects each source/ref, including across processes. Metadata is
  written atomically outside the snapshot. The bound is 16,000 files, 32,000
  entries, depth 64, 64 MiB per file and 512 MiB total; source metadata is bounded
  separately. All operations are local until an explicit fetch.

The filesystem is not an OS isolation boundary against a malicious process that
already owns the machine. Native permissions remain the authority; a verified
snapshot is input data, never permission to execute arbitrary repository code.

## Evidence

`node --test tests/git-maintenance-source.test.mjs`: 10/10 actual Git fixture
tests pass. Cases cover portable defaults and malicious URL/ref rejection,
network-free status, immutable local/remote snapshots, dirty committed-only mode,
disabled clean filters/hooks, CAS-style content and Git-binding tamper detection,
scope revocation, abort, concurrency, junction rejection and BOM/CRLF handling.

A read-only source acquisition of the actual canonical checkout at `82c10a4`
also passed into an ignored managed cache; its working tree was not changed.
