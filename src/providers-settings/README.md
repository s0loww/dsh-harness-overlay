# Providers and models

One settings section for subscription accounts and model APIs. Search and group
filters select expandable provider cards. Subscriptions reuse their public login,
account and model panels; Kimi reuses its guarded device-flow panel. Native API
editors share the already mounted official Models controller and its credential,
settings revision and model interrogation operations. No parallel credential
storage or authentication flow is introduced.

The release builder must run `patchNativeModelsClient` and
`patchNativeAccountClient` against the unmodified pinned rc.5 Models and Account
clients **before** any localization transform. Both check source SHA-256. Models
exports seven existing workflow functions; Account exports its existing section.
Each native apply publishes its already constructed injected face exactly once to
an observable compatibility bridge, preserving snapshot identity until disposal.
The unified page follows bridge readiness and native controller state directly;
it does not inspect slot ledger render internals or call native apply twice.
Disposal clears only the current bridge owner's face. Missing model activation
becomes an explicit retry message after eight seconds rather than endless loading.
Native account sign-in remains in the official slot during bridge activation.

Claude subscription OAuth is deliberately omitted: the supplier implementation
hard-disables that request route. Anthropic API configuration remains available
through the official API editor. Cursor, the supplier assistant, voice, Jira,
supplier support/update and Live2D controls are not advertised here.
