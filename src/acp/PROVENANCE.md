# Provenance

The local pipe/controller and ACP policy are adapted from the supplied
`dsh-1c-bundle` `acp-desktop.js`, `acp-desktop-core.js`, `acp-outbound.js`
and `scripts/acp-desktop-client.mjs`, release `20261103-134539` (package metadata
MIT). Bundle paths, updater, assistant, voice and Atlassian dependencies were
removed. Protected file writing, HTTP native admission and lifecycle tests are
implemented for this standalone port.

Native protocol behavior remains owned by the official
`@deepseek-ai/dsh-acp@0.2.1-rc.5` (MIT). Outbound runtime/UI are the pinned public
`@zaimokuza/dsh-acp-adapter@0.2.1-rc.3.1` (MIT); its LICENSE is retained by the
private dependency staging closure. The one bundle-specific resolver import in
`installed-profile-registry.js` is adapted to `airules-dsh-acp/outbound`, which
accepts installed executables only and performs no automatic binary lookup.

The supplier's standalone files have MIT-labelled package metadata but no
standalone copyright notice in the extraction. Obtain full notice provenance
before external redistribution, as for the existing OpenSpec port.
