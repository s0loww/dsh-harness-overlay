# Official Desktop profile contract

This note records the read-only inspection used by the isolated candidate
workflow. It does not reproduce application source or runtime state.

## Pinned source

- Product: DeepSeek Harness Desktop.
- Host: `0.2.1-rc.5`.
- Immutable file identities are defined by
  `upstream/official-desktop/release.lock.json`.
- Inspected application archive: `resources/app.asar`, after its hash matched
  the release lock.

## Profile selection

The packaged main process in `lib/main.js` resolves the DSH base directory from
`DSH_HOME` when that environment variable is present, otherwise it falls back
to the normal user-home `.dsh` directory. The Desktop profile is the
`profiles/desktop` child of that selected base directory.

The candidate therefore sets `DSH_HOME` to its own `home` directory. It never
needs to inspect or copy the normal user profile.

Electron user state is independent from the DSH profile. The candidate launcher
uses Electron's `--user-data-dir` argument and points it at the candidate's own
`electron-user-data` directory.

## Minimal Desktop profile

The packaged Desktop initializer creates a private profile package whose web
bundles are:

- `@deepseek-ai/dsh-base`;
- `@deepseek-ai/dsh-web-app`.

The isolated candidate pre-creates only the initializer's data contract:

- `package.json` with the two bundle declarations and empty dependencies;
- `cordis.patch.yml` as an empty YAML array;
- `pnpm-workspace.yaml` with the packaged minimal hoisted-workspace policy;
- an empty `node_modules` directory.

No MCP endpoints, credentials, sessions, project paths or live Cordis state are
part of this contract.

## Launch gate

Candidate creation ends in `created-not-launched` state. The launcher refuses
to run unless `ui-ready.json` exists in the candidate root. Candidate creation
does not produce that marker; it belongs to the later audited UI integration
step.
