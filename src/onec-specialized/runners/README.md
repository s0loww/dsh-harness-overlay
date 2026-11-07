# Packaged project bridge

`runner.mjs` is a standalone, versioned bridge; it is not a copy of repo-ops or
v8unpack. The UI may copy the exact managed bytes into
`tools/onec-specialized/runner.mjs` with native create-if-absent/CAS semantics.
`airules-dsh-onec-specialized/runner-template` exports
`bundledRunnerTemplate()` with source, SHA-256, fixed destination and driver
config path. Copying never installs dependencies or starts an operation.

The exact current managed bridge SHA is implicitly trusted. External scripts,
declared dependencies and Python executable hashes are **not** implicitly
trusted: register reviewed hashes in machine `trustedRunnerDigests`.
PowerShell must match machine `powerShellPath` or have its own trusted hash.
Do not register an arbitrary new hash just to clear a failed preflight.

Set `runner.driverConfigPath` to `.dsh/onec-specialized-driver.json` in the
domain binding. An example non-secret driver config is:

```json
{
  "schemaVersion": 1,
  "repository": {
    "format": "repo-ops-v1.1-text",
    "scriptPath": "tools/1c-repo-ops/scripts/repo-ops.ps1",
    "scriptSha256": "<reviewed repo-ops hash>",
    "powerShellPath": "C:/Program Files/PowerShell/7/pwsh.exe",
    "powerShellSha256": "<PowerShell hash>",
    "environmentFile": ".dev.env",
    "dependencies": []
  },
  "v8unpack": {
    "format": "v8unpack-cli",
    "pythonPath": "C:/Tools/Python/python.exe",
    "pythonSha256": "<reviewed interpreter hash>",
    "version": "1.2.6"
  }
}
```

No credentials belong in this JSON. Production repository operations require
the existing project-root `.dev.env`; its **hash only** enters the plan. This
prevents the donor's upward environment search from silently selecting another
project. The bridge never creates or changes that file. Repository target,
roles, platform and credential handling remain the reviewed repo-ops script's
responsibility. Extra script dependencies must be declared, hashed and trusted;
the bridge cannot prove undeclared imports of arbitrary reviewed code.

The managed host recognizes only its exact bridge bytes and runs its typed
orchestration with the existing native workflow process adapter. Each external
PowerShell/Python invocation goes through native confinement and managed process
termination. This avoids nested-spawn `EPERM` under the pinned Windows sandbox;
there is no full-access fallback. Python's fresh contained child cwd keeps the
original native session/workspace policy root. Custom JSON runners retain the
ordinary native subprocess route and require explicit machine trust.

Repository argv uses the donor's verified `-Operation`, `-Objects`, `-Comment`,
`-ReportFile`, `-OutputFile`, timeout and force-confirmation parameters. The
known v1.1 text adapter requires the exact success marker, no observed error or
lock-conflict text, and a fresh nonempty bounded report for status/history/diff.
It emits bound technical assertions, not invented revision/owner facts. Unknown
formats, unknown verdicts, unsupported encodings or missing reports fail closed.
For dump, set a new repository `output` ending `.cf` or `.cfe`; the host checks
the actual output artifact. The donor script still owns its /DumpResult, /Out
and per-object semantic checks; review that implementation before trusting it.

Raw child streams remain bounded in memory. A raw repository report exists only
in a fresh private directory inside the owning job's workspace and is removed
in `finally`. Persisted summary contains byte count, hash and explicit
`not-parsed` facts, never raw or cosmetically masked secret-bearing text. A hard
process/host crash may leave private temporary files; reconcile/clean that
owning job before treating interrupted work as complete. Cancellation is not
rollback or proof that a remote repository action was undone.

Real non-fixture changing repository runs acquire an exclusive durable
canonical-project guard in host-home before execution. Only their own bound
success with confirmed termination clears it. Failure/cancel/unknown state
blocks later repository mutations across sessions and process restarts; saved
reports and status remain readable. There is no generic confirmation to remove
this guard: reviewed recovery/manual reconciliation support is still absent,
so unresolved production changes stay blocked. Fixture relabelling does not
bypass an existing real guard. Local v8unpack failures do not create this
repository-specific guard.

Python is never installed automatically. The interpreter must be outside the
project, hash-checked and machine-trusted. Metadata runs with `-I`, verifies the
exact installed v8unpack version and confirms that module origin/sys.path are
outside the project. Execution uses `-I -m v8unpack -E/-B`, `--processes 1`, and
a new output. PYTHONPATH, PYTHONHOME, VIRTUAL_ENV and credentials are not
forwarded. The separately administered interpreter installation/site-packages
remain a trusted machine dependency, not a project import source.

Artifact presence and bounded local hashes do not establish logical equivalence,
Designer loadability or business behavior. CF/CFE apply, publish and real deploy
are not performed by this bridge. Tests use only a real PowerShell stub and
fake codec fixtures; no actual 1C or v8unpack transformation is claimed.
