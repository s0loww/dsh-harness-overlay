# Legacy airules manifest migration

`scripts/migrate-legacy-airules-manifest.mjs` migrates only the accounting format,
not the rule distribution, project configuration, MCP connections or project code.

The legacy installer inventories multiple clients and project files. That map
cannot be copied into the narrower DSH ownership map. The new schema preserves
the full legacy document under `legacy_installation` and all placeholders at the
top level. Its active `files` map starts empty: adopting the existing project
contract requires an explicit later rollout review. This avoids granting DSH
permission to replace a project-specific AGENTS contract with default bindings.
The original source version remains unchanged; no newer rules are claimed.

Preview:

```powershell
node scripts/migrate-legacy-airules-manifest.mjs --project D:/path/to/project
```

Apply the exact reviewed manifest SHA:

```powershell
node scripts/migrate-legacy-airules-manifest.mjs --project D:/path/to/project --apply --expected-manifest <sha256>
```

The project-exclusive rollout lock, before hashes and repeated checks protect
the manifest replacement. The backup lives in `.rules-backups/manifest-migration-*`
and contains the exact previous manifest, original-byte copies of every legacy
file and additional project/MCP configuration, plus a receipt. Worktrees, runtime
state, caches and node_modules are not traversed for configuration discovery.
No subprocess, shell command, model, network or deployment is invoked by the tool.

Rollback refuses a changed migrated manifest or changed protected project files:

```powershell
node scripts/migrate-legacy-airules-manifest.mjs --rollback D:/path/to/project/.rules-backups/manifest-migration-.../receipt.json
```

## BL acceptance, 2026-11-11

- Legacy source version 0.12.0; 468 tracked entries; 466 exact, two pre-existing
  local modifications (`ibcmd-ibsrv/SKILL.md` and `openspec/project.md`).
- Backup and post-apply verification: 473 existing files preserved byte for byte.
  All 13 legacy placeholders and the full legacy manifest were preserved.
- Only the live `.airules-manifest.json` was replaced. Project contracts, skills,
  settings and MCP were unchanged; no real deployment occurred.
- The actual installed rollout service reads the new format. The visible DSH
  page shows 0.12.0, zero actively managed DSH files and no manifest error.
- Three fixture tests pass: actual installed-service-compatible status, exact
  BOM/config/MCP preservation and rollback, changed preview/rollback conflicts,
  invalid hashes and path traversal rejection.

The empty active map is intentional. A later rule upgrade must preserve the
legacy project bindings explicitly and review instruction adoption. This
migration does not silently update 0.12.0 rules to the bundled 0.16.0 distribution.
