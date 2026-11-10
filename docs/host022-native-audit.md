# Official DSH 0.2.2-rc.1 native audit

## Acquisition and isolation

The official Windows x64 nightly feed was downloaded over TLS from `https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml`. The referenced installer `deepseek-harness-0.2.2-rc.1-win-x64.exe` was downloaded from the official `/dsh-desk/bin/win-x64/` endpoint. Feed and verification evidence are in ignored `var/host-upgrade/rc022/`.

- Size: **293425336** bytes.
- SHA512 (base64): `swcK0J6ofGkaAWLRpOes2ca7CWO8vuM5Vp0FRnQ/DG3q+Z+OhvsgLz3hIiSYpRUETY+fEz+Ww86fNa0jiVIifw==`.
- Authenticode: **Valid**, publisher **Hangzhou DeepSeek Artificial Intelligence Co., Ltd.**; signer thumbprint `84032578657219876E273E0D1BD303CFE1B82E6F`.
- Application package version: **0.2.2-rc.1**, buildCommit `c59d10aff167ad7eefead4b3a9082fb57c8fbfe8`, dshBuildDirty false.
- Installer was extracted with local 7-Zip, then `$PLUGINSDIR/app-64.7z` extracted into `var/host-upgrade/rc022/install`. The installer executable was never run.
- `install/resources/app.asar` was extracted with the existing cached `@electron/asar` tool into `var/host-upgrade/rc022/asar`.
- Native modules: `var/host-upgrade/rc022/asar/dsh/node_modules`. New desktop file baseline: `upstream/official-desktop/0.2.2-rc.1/release.lock.json`. Old rc5 baseline is retained.

No user credentials, sessions, MCP bindings, or live profile were used for this audit.

## Native API compatibility

- Runtime uses Cordis 4.1.0, loader/include 1.1.0. Public profile boot remains `@deepseek-ai/dsh/lib/profile-boot.js`; new standard composition is exposed through `@deepseek-ai/dsh-official-bundles`.
- Native general settings, models and account packages are sourced from the actual new SDK, not donor rc5 packages. Whole directory hashes are pinned in `upstream/native-ui-compat-0.2.2-rc.1.lock.json`; adapter entry hashes are exact per host.
- Account UI now uses `remoteAccess.whenAccess("account/watch", ...)`. The provider bridge preserves this permission and clears its published face when revoked. Original account slot gating remains native.
- Native conversation still accepts a retained session controller binding object (`source.sessionId`), validates that it belongs to the current sessions controller, and exposes Chat target snapshots. The Chat implementation still has the retained `legacy.nodes` projection used by composer recall. No storage migration is performed.
- Composer 0.7.2 and LSP actions 0.4.6 retain their exact reviewed source hashes. Their manifest engines pin **only** the chosen host, without widening peers. Staged manifest hashes differ per host. Historical composer rollback allowance remains rc5 only.
- Turn navigator uses the same reviewed native HTML selector/text icon adaptation. The legacy effort slider remains disabled; the official native reasoning menu owns selection. Optional shared-directory slider mode is not certified for 022 and is refused there.
- LSP admission validates manifest and unchanged entry against real new native boot admission. A running BSL server is outside this audit.

## Staging and checks

Explicit new-host UI staging:

```powershell
node scripts/stage-ui-overlay.mjs --source-bundle <donor-bundle> --artifact-version 0.13.0-host022-ui5 --target-host-version 0.2.2-rc.1 --native-modules <extracted-asar>/dsh/node_modules
```

Produced `dist/airules-ui-overlay-0.13.0-host022-ui5`: 800 files, 26 operations. Donor release provenance stays unchanged; three official native UI rows record new host version and original directory digest. Staging defaults remain rc5; unknown hosts are refused.

`tests/host022-ui-compat.test.mjs`: 10 PASS against actual 022 sources, including compile/hash guards, native account permission revoke behavior, real Cordis composer host/client lifecycle, narrow LSP admission and staged native provenance. Combined regression run with policy/UI installers, UI contracts/packaging, providers and composer: **48 PASS**. These tests do not claim real browser interaction or LSP server operation; model, MCP and deploy calls were not made.

The first UI022 candidate revealed a transitive donor storage-domain dependency that was still rc5. UI2 replaces storage-domain and its four-package official closure with exact new SDK sources, pinned in `upstream/native-ui-runtime-0.2.2-rc.1.lock.json`; Russian locale peer admission also pins exact022. UI1 is not a release candidate.

UI3 additionally preserves the new native Russian catalog entry: the overlay registers its owned dictionaries but never removes or recreates the official Russian language. Disposal affects only its own dictionary registrations.

UI4 excludes namespaces whose identifiers occur in actual official 022 client sources. Their native Russian dictionaries retain ownership and bytes; 152 donor-only namespaces remain. Actual `LocaleRuntime.apply` registers the official Russian catalog/common/settings dictionaries, then the overlay mounts and disposes without altering native dictionaries. UI3 remains unfit because native dictionary registration rejects duplicate namespaces.


## Independent provider closure verification

`tests/host022-provider-closure.test.mjs`: **4 PASS**. Both actual official SDKs cold-import the pinned 117-package provider closure: rc5 default resolves native pi-ai 1.1.0; explicit 022 resolves native pi-ai 1.3.0. Unknown host and cross-host peer mismatch fail before copying dependencies. A disposable import-time fetch fixture is denied; external accounts/executables are never started.

ACP review: the original closure lock authenticates the adapter source manifest; the final policy file inventory seals the rewritten manifest. This supplies byte integrity, but the existing `acp.adaptation` hashes describe only `installed-profile-registry.js`, so they do not explicitly explain the engine change. Recommended before live migration: an exact 022-only engine adaptation record with old/new manifest hashes and engine strings, validated against the target and actual staged bytes. Source manifest SHA256 `940e499d84127eb1634ebd684e5d722150f7b54b05c675d28644717269927736`; rewritten manifest SHA256 `7cf400f2cd2b713a7bf44086948467035994df0d7766acfd8174ac1e2bc376ac`. Native boot admission proves mounting; it does not certify an external ACP session lifecycle.

The ACP engine provenance recommendation is implemented: new-host staging requires the exact original manifest hash, produces and checks the exact rewritten hash, records `integrations.acp.engineAdaptation`, and policy verification compares it with the actual payload manifest and target host. Old rc5 artifacts retain their original metadata shape. `tests/host022-acp-engine.test.mjs`: **2 PASS**, including a resealed file-inventory attack with widened `engines.dsh` rejected by the explicit provenance guard. Combined policy installer regression: **14 PASS**.

## Native 022 nested tool dispatch

`tools.execute` now accepts raw batches and does not propagate nested `parent`/`rootCallId` fields. Five product packages (six callers) use a host-selected local helper: rc5 retains the original single-call API; 022 nested calls use the exported `ToolExecutionPipeline.prepare/dispatch/complete` path, keeping original parent correlation, Agent, signals, native approvals, guards, final normalization and observers. Top-level UI reads still use the selected executor's batch API. Selected executor availability is rechecked after approval; revoked tool definitions are rechecked by native dispatch.

Actual SDK tests cover parent/root/Agent correlation, scoped denial, approval denial, definition and executor revocation during approval, cancellation, and the real `general-tools.bundledNode` child call: **5 PASS**. A real minimal policy build with ACP and 1C panels confirms that staging installs the exact new helper and `verifyPolicyArtifact` accepts the resulting artifact. Existing product regressions: **49 PASS**.

UI5 supersedes UI4: escaped source-string literals must be parsed as whole JSON literals when identifying native namespace ownership. `settings.theme` is absent from the actual staged donor payload. Native LocaleRuntime and native Theme registration coexist with the overlay, preserving original Russian theme dictionary bytes. UI022 checks: **10 PASS**.

## Real host-upgrade planning fixes

Rulepacks are data packages: their identity is `manifest.json.package.id`, with no `package.json`. Upgrade layer validation now honors this only for `airules-dsh-rulepack`; all executable packages retain normal package identity checks. Truthful fixtures and actual old UI23/policy43 plus new UI5/policy50 layer checks pass.

Previously unowned shared dependencies may migrate only when an old receipt's `verifiedNoops` entry binds the exact installed digest, version and old verified artifact subset (including the storage-domain nested zod composite). Unsafe extra executable files are refused. The new source must retain reviewed `official-native-runtime` provenance. Such replacement operations record old/current/new digests and previous receipt hash, and become owned by the new transaction. No generic unowned-package override or receipt retargeting was introduced.

Tests cover ten fixture cases, including forged no-op evidence and composite storage dependencies. Explicit read-only planning against the unchanged real installation also passed: rc5 → 022, 55 operations, full install/home/Electron-data snapshot roots. No stop, shadow copy or apply was performed by these tests against live paths. The live planning test requires `AIRULES_RUN_LIVE_READONLY_PLAN=1` because it intentionally certifies the pre-upgrade installation state.

Final UI5 also fixes the literal collector to consume escaped JavaScript strings as whole tokens; UI4 could miss `settings.theme` after losing quote alignment. The staged UI5 client omits that native namespace, and the actual native theme/locale test preserves its dictionary. Visible Electron startup with UI5 passed.
