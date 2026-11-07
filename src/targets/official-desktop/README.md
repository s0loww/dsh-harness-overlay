# Official Desktop target

This target is separate from the portable Oleg-bundle target. It identifies the
immutable Electron installation, then plans external packages under the normal
Desktop profile:

```text
%USERPROFILE%/.dsh/profiles/desktop/node_modules/<package>
%USERPROFILE%/.dsh/profiles/desktop/cordis.patch.yml
```

The planner only checks that the profile and its fixed targets exist. It never
reads the Cordis file, package configuration, sessions, credentials or other
runtime state. It performs no writes.

Internal `app.asar` changes are not part of the external plugin path. Their
descriptor must name the exact baseline hash; even then the read-only plan is
reported as `review-required`, because an internal patch needs a dedicated
release-pinned installer and rollback.

## Isolated release candidate

`scripts/create-official-candidate.mjs` creates a fresh, fixed-path candidate
without reading or copying the live `%USERPROFILE%/.dsh` profile:

```powershell
npm run candidate:create
node scripts/create-official-candidate.mjs `
  --candidate-root "D:\AI_Projects\dsh_harness_overlay\var\candidate\official-desktop-rc5-02"
```

The workflow verifies the official release lock, copies the immutable Desktop
installation, verifies the copy, creates a minimal task-specific `DSH_HOME`
and a separate Electron `user-data-dir`, then records a manifest and hashes.
The complete copied file-tree digest must match the complete source-tree digest.
The CLI accepts candidate roots only as fresh immediate children of this
repository's `var/candidate` directory. It refuses an existing candidate and
never launches the application.

`scripts/launch-official-candidate.ps1` is fail-closed: it requires a reviewed
`ui-ready.json` marker in the candidate root before starting the copied GUI.
The launcher exports only the candidate `DSH_HOME`, disables telemetry and
passes the isolated Electron user-data directory.

The read-only code findings behind the minimal profile are recorded in
`docs/official-desktop-profile-contract.md`.
