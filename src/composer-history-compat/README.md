# Composer history: exact rc.5 adaptation

This builder helper adapts only reviewed `dsh-composer-history` 0.7.2 bytes
already selected by our UI package set. The public package is Apache-2.0;
the official DSH base does not provide it. Disabling this package removes its
ArrowUp/Down recall, Ctrl+R search, local snippets/templates/backup and compaction
notice; it does not delete conversations, change model context or migrate data.

The three stale peer ranges exclude rc.5. After validating exact manifest,
unchanged host entry and reviewed client hashes, the helper adds the exact own
`engines.dsh: 0.2.1-rc.5`. The actual native `evaluatePluginCompatibility` uses
that exact field ahead of informational peers. No global/profile exemption is
created; other host versions remain incompatible.

The donor's existing selected-session Chat projection adaptation is retained.
One workspace-only branch still accessed obsolete `SessionSnapshot.nodes`.
It now reads the same retained binding's `uiConversation.target('chat')` legacy
nodes. A cold Chat target is synchronously activated through a temporary native
subscription and released immediately after reading. Only already retained
bindings are considered; no history/network fetch or extra session retention is
introduced. Local storage keys, backup formats, import/export and user data are
unchanged. The plugin still writes only the ordinary draft when the user chooses
recall; it never sends a message automatically.

Actual browser diagnostics also exposed a donor-only optional service fallback:
`scope.get('projectPresetUi') || scope.projectPresetUi` throws through Cordis's
direct-property guard when that excluded service is absent. The current patch
keeps the optional get and clean fallback, removing only the forbidden direct
property access. The five native required services remain unchanged. A real
Cordis client-apply regression reproduces the old failed state and proves the
fixed module becomes active without that donor service.

`adaptComposerHistoryPackage(directory)` writes only the builder-owned copy's
manifest/client; the host entry remains byte-identical. Its returned provenance
records source/staged manifest/client hashes, host entry hash, exact host version
and contract. `verifyComposerHistoryCompatibility` checks those exact staged
bytes for artifact guards. Never patch an existing immutable UI artifact.
Artifact verification defaults to the current digest. An explicit fourth option
`{allowHistorical:true}` additionally recognizes the single exact historical
UI20/21 client digest for authenticating/rolling back those immutable builds.
The installer must restrict that option to those two known artifact versions.
This is not browser-runtime acceptance of the historical variant: fresh builds
are explicitly required to produce the current client digest, and release probes
must require that current digest. Other client bytes remain rejected.

`node --test tests/composer-history-compat.test.mjs` checks native compatibility
admission, rc.6 rejection, byte drift, actual patched client workspace recall
against cold retained Chat targets with obsolete snapshot access prohibited,
zero storage writes, balanced subscriptions, and unchanged host entry mounting
in real native Cordis with fiber state 2, plus actual native client apply without
the excluded donor service and narrow historical rollback verification. Source
bytes default to immutable UI17
or an explicitly supplied `AIRULES_COMPOSER_SOURCE_ROOT`. No browser interaction,
model, auth, send, real history import or account action is performed. Full-profile
boot/renderer acceptance belongs to the newly staged release and is additional
to these checks.
