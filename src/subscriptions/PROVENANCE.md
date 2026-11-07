# Subscriptions provenance

Source: `dsh-plugin-subscriptions@0.8.0`, supplied in DSH Desktop 1C release
`20261103-134539`; repository `https://github.com/V1ki/dsh-plugin-subscriptions`.
The supplied MIT license, copyright 2026 V1ki, is preserved in LICENSE.
The source bundled host/client include supplier catalog-visibility changes;
the port does not claim byte identity with upstream npm.

Local adaptations: package/loader and RPC identity isolation, private state
directory, removal of automatic legacy auth-store migration, explicit-only
Claude Code import, public settings.section registration, removal of supplier
model-selection/history cleanup dependency and auxiliary tool registration.
Existing provider retry/cooldown handling and same-provider pool boundaries
remain intact. `undici@7.29.1` is bundled separately by the audited stager.

Pinned official rc.5 compatibility: the auth RPC injects `connection` and
`webServer`, and passes its route owner explicitly to native
`connection.register(owner, channel, handler)`. The rc.5 `rpc` getter shadows
the provider context, which otherwise fails native inject checking and leaves
requests on the static fallback (HTTP 405). Native admission, JSON RPC framing
and disposal remain owned by the host. Regression exercises the real pinned
WebServer Service, HostConnectionService and LlmRuntime; a plain webServer mock
does not enforce the native injection contract.

The internal `apply(ctx, config, host)` entry point additionally accepts an
explicit absolute `host.authStorePath` for an isolated acceptance host. This
is not a profile/UI setting. Account listing, refresh/CAS and controller
operations use the same selected store; omitting the argument preserves the
normal installation path. Acceptance does not copy account or session files.
