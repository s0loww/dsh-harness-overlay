# Native UTF-8 BOM compatibility patch

Build-time, exact-hash patch for the official DSH 0.2.1-rc.5 filesystem.
The original decoded edit text remains BOM-free. The file's original BOM flag
is retained beside its line-ending metadata and restored during the existing
atomic edit writeback, under the same locks and version checks.

`applyNativeFsSandboxImportPatch` changes one import in the native sandbox
implementation to the patched local backend. Its permission logic is unchanged.
The stager preserves both upstream MIT licenses and pins the Windows x64
runtime dependencies in `upstream/native-fs-closure.lock.json`.

This does not change deliberate whole-file `write` semantics. It does not
repair files after tool success, intercept the tool output or mutate an ASAR.
Source hashes outside the reviewed rc.5 package are rejected.

The policy disables the original `fs-sandbox` plugin by its asserted native
name and inserts the managed provider. A Cordis `name` assertion alone cannot
replace a plugin. Native runtime attestation checks the actual service class,
patched superclass and both module hashes before model acceptance.
