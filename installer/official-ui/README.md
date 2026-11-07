# Official Desktop UI installer

This installer is intentionally scoped to an isolated official Desktop
candidate. Every CLI requires `--candidate-root`; known live install and
`%USERPROFILE%/.dsh` paths are rejected.

```powershell
node installer/official-ui/plan.mjs `
  --candidate-root "D:\AI_Projects\dsh_harness_overlay\var\candidate\official-desktop-rc5-01" `
  --artifact "dist\airules-ui-overlay-0.1.0-dev2"

node installer/official-ui/apply.mjs `
  --candidate-root "D:\AI_Projects\dsh_harness_overlay\var\candidate\official-desktop-rc5-01" `
  --artifact "dist\airules-ui-overlay-0.1.0-dev2"

node installer/official-ui/rollback.mjs `
  --candidate-root "D:\AI_Projects\dsh_harness_overlay\var\candidate\official-desktop-rc5-01" `
  --artifact "dist\airules-ui-overlay-0.1.0-dev2" `
  --receipt "<candidate>\.airules-ui-backups\airules-dsh-ui-overlay-0.1.0-dev\receipt.json"
```

Plan verifies the immutable official release, the complete UI artifact file
set, all SHA-256/size records, package allowlist and the dedicated Cordis
fragment. It reads only owned package targets and the fixed profile Cordis
file.

Apply stages all packages, the merged Cordis file and `ui-ready.json`, backs up
existing owned targets, repeats the plan/state checks, then uses one
quarantine/install transaction. A failure before the final receipt restores
every target. Existing packages or a differing owned Cordis block require
`--replace-collisions`; a shared block is never replaced.

Rollback re-verifies the artifact, receipt, after-state ownership and backups,
then restores the profile byte-for-byte. Namespace directories created by the
transaction are removed only when they are still empty; shared/non-empty
namespace directories are never removed.

The installer does not copy or inspect live profile state, credentials,
sessions, MCP bindings or runtime databases.
