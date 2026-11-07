# Provenance

Controller and UI extracted from the supplied MIT-labelled `dsh-1c-bundle`
release `20261103-134539`, files `lib/mobile-access-core.js` and the marked
`MobileAccessSettingsSection` in `lib/client.js`. Their local-control route,
dedicated state directory, relay path denylist and stock Desktop admission
were adapted for airules. Test dependency injection affects no default runtime.

The private `dsh-relay@0.2.1` facade is the supplied pinned build of
`sorsama/deepseek-harness-relay` commit
`10c2758e77192413d9450a4d641daafb2a675286`, MIT; source manifest `UPSTREAM.json`
and upstream LICENSE are retained by dependency staging. It owns HTTPS,
password hashes, authentication, device revocation and reverse-proxy lifecycle.

The standalone supplier source files have MIT-labelled package metadata but
no separate copyright notice in this extraction. Obtain complete notice
provenance before external redistribution.
