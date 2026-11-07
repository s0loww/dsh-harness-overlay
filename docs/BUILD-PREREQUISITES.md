# Build inputs and local preparation

The private source repository contains maintained adapters, tests, reviewed
dependency locks and provenance. It does not contain an installed Desktop,
the supplied donor distribution, profile state or dependency installation trees.
A fresh clone needs the following explicit local inputs before all integration
tests or a full policy build can run.

## Supplied source bundle

Policy staging always needs the reviewed editor/LSP packages from the supplied
`dsh-1c-bundle` directory. Optional integrations use additional pinned packages
from the same directory. Select this build input explicitly:

```powershell
node scripts/stage-official-policy.mjs --source-bundle "<authorized-bundle-directory>" --rulepack "<verified-rulepack>" --output "<fresh-versioned-output>" --artifact-version "<new-version>"
```

The programmatic `stageOfficialPolicy` API accepts `sourceBundle`. For a local
test/build session, `AIRULES_DSH_SOURCE_BUNDLE` is the alternative input; a
function/CLI argument takes precedence. There is no machine-specific fallback,
install discovery or automatic download. An unset source or missing
`node_modules` fails before staging creates directories. An explicit empty
argument is invalid and does not fall back to the environment.

The source folder must be supplied through the user's authorized installation
or existing local package cache. Existing release locks, exact-text adaptation
anchors, dependency closure inventories and post-copy hashes still determine
which bytes the builder accepts. A configured path does not replace those guards.
Keep this path in a session environment or ignored local configuration, never
in a distributed manifest or a committed machine settings file.

The UI builder already accepts `--source-bundle` separately. Policy input
configuration does not configure providers, MCP or any live DSH profile.

## Pinned official host SDK for tests

Native-contract tests import the official rc.5 packages from the ignored local
tree `var/asar-extract-rc5/dsh/node_modules`. Prepare this tree by extracting the
matching authorized official Desktop ASAR with an available, reviewed ASAR tool;
preserve the accompanying physical `.asar.unpacked` tree for native executables.
This change does not download an extractor or introduce a silent bootstrap.

Verify the official installation against `upstream/official-desktop/release.lock.json`
with `scripts/official-verify.mjs` before using it. That lock includes the ASAR
identity. The extracted SDK is a test input, not source to upload into Git.
Published host packages, a different rc version or stand-in mocks do not establish
compatibility with the pinned Desktop.

## Mermaid runtime

Canonical Mermaid sources and its npm lock come from `project_rules`; the local
source mirror lives in `src/general-tools/runtime/mermaid`. Full general-tools
staging also needs the installed dependencies beneath its `scripts/runtime/`.
Run the lock-based setup only as an explicitly authorized dependency preparation:

```powershell
npm ci --ignore-scripts --prefix src/general-tools/runtime/mermaid/scripts/runtime
```

Use the reviewed Windows x64 target and matching npm preparation. Staging verifies
canonical source bytes, lock integrity, pinned package identities and the complete
reviewed installed closure, including the native raster package. A closure mismatch
requires investigation; do not weaken its recorded hash to make an arbitrary
installation pass. Dependency preparation may require the configured registry or
an existing npm cache; no build/task silently starts it. Keep `node_modules` ignored.

## Canonical content and checks

Build and verify a fresh rulepack from the intended clean airules revision.
Domain presets and workflow integration additionally take explicit canonical
roots through `--domain-rules-root` and `--workflow-rules-root`. Staging copies
reviewed portable assets and checks manifests instead of importing project state.

For the existing complete suite, set `AIRULES_DSH_SOURCE_BUNDLE` explicitly before
`npm test`. The document closure test additionally uses
`AIRULES_DOCUMENT_DONOR_MODULES` pointing at the selected bundle's `node_modules`;
without that opt-in its donor-copy case is skipped. Pure unit tests do not by
themselves attest dependency preparation or a live installation.

Do not add ASARs, binaries, dependency trees, credentials, sessions, `.desktop-local`,
`.dsh-1c`, `.env`, machine bindings or build/candidate logs to the source commit.
Preserve licenses and notices already attached to reviewed runtime sources.
Private source archival does not establish readiness for public redistribution;
the individual `PROVENANCE.md` records retain unresolved supplier notice details.
