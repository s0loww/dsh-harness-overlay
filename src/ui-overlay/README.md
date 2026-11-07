# UI overlay contract

This directory describes the interface layer independently from the airules
policy/rulepack overlay. It contains no plugin binaries, vendor source, MCP
bindings, credentials or runtime state.

Files:

- `ui-component-inventory.json` — source-of-truth candidates discovered in the
  pinned Oleg release;
- `schemas/ui-component-inventory.schema.json` — component ownership,
  provenance, dependency, state and portability contract;
- `schemas/ui-overlay-manifest.schema.json` — contract for a future staged UI
  artifact;
- `examples/ui-overlay-manifest.example.json` — contract-only manifest with no
  payload operations;
- `contracts.mjs` — fail-closed checks used by tests and future staging code.

The inventory is intentionally conservative. `candidate` means package
metadata is known, not that the component is ready for distribution. A
component becomes `audited` only after its license/source, target host APIs,
state behavior and candidate-copy smoke checks have all passed.

## Hard boundaries

- UI artifacts never contain airules policy, rules, roles or skills.
- MCP panels may display and edit target-owned configuration, but the artifact
  never contains bindings, endpoints, commands, headers or credentials.
- Browser/user/project state is never copied from the source installation.
- Unknown target releases are blocked.
- `review-required` source is not copied until provenance is explicitly
  resolved.

## Promotion workflow

1. Match package name/version/license against `upstream/component-inventory.json`.
2. Inspect the package API and state paths without reading user state.
3. Set portability mode and exact target compatibility.
4. Stage only allowlisted payload files with SHA-256 and size records.
5. Run static/import health checks on a candidate copy.
6. Run non-mutating UI smoke checks, then apply/rollback tests.
7. Promote `candidate` to `audited`; only audited components enter a release.

## Development artifact

The UI artifact builder copies only the allowlisted public package set, its
exact non-peer dependency closure, and the two private-overlay packages for the
balance HUD and Russian locale. It never reads a DSH profile or user state.

```powershell
node scripts/stage-ui-overlay.mjs `
  --source-bundle "E:\path\to\pinned\dsh-1c-bundle" `
  --artifact-version "0.1.0-dev5"
```

`--artifact-version` is mandatory. The default destination is derived as
`dist/airules-ui-overlay-<artifact-version>`; an explicit `--output` must
have that exact final directory name. An existing destination is never
modified or replaced, so changed inputs require a new artifact version.

The generated `cordis.ui.fragment.yml` contains plugin rows only. The
machine-scope MCP manager package is staged but deliberately not mounted; no
server definitions, endpoints, headers or credentials are present. Every
payload file is SHA-256/size recorded in `ui-overlay-manifest.json`.

The clean upstream npm tarballs for `dsh-auto-collapse`, `dsh-sleep-send` and
`dsh-turn-navigator` are SRI-pinned and recorded with provenance. Modified
bundle copies are not used for the official target. Dev5 applies one
deterministic source/result-hashed adaptation to the clean `dsh-sleep-send`
client: its hardcoded Chinese UI copy is moved behind the official locale
`register`/`bind` API. This is an owned package adaptation, not a host or DOM
monkeypatch; both the pristine and adapted client hashes are recorded.

