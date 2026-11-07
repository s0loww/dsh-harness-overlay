# Effort slider compatibility

Offline adaptation for the pinned supplier `dsh-effort-slider` 1.1.0 client.
The shipping default `native-menu` disables its browser apply and injection list,
restoring the official session-bound effort menu. The original package and Cordis
fragment stay present. The supplier document capture handler swallowed the native
click before resolving its legacy global current session; failure left neither
slider nor native menu usable. A source/API adaptation alone did not fix opening.
No global DOM click interception, body marker, stylesheet insertion or rendering
loop is installed in shipping mode. Animated slider integration remains disabled
until it can bind the native session slot instead of inferring a global session.

The alternative `shared-directory` mode is retained for isolated compatibility
tests and future slot-based integration, and is not shipped by default.
The release builder applies `patchEffortSliderClient` before localization and
`patchEffortSliderPackage` to declare its native model-selection dependency.
Client source is SHA-256 guarded; every replacement checks its exact match count.

The supplier used the obsolete `connection.api.sessions.models/selectModel`
interface and nested `response.result` envelope, and silently discarded write
errors. The official rc.5 selector owns a shared per-session `ModelDirectory`.
The adaptation subscribes to that directory, loads through it and calls its
`select` method, preserving native session identity, durable projection, failure
and model-menu refresh semantics. Selection failures restore the previous slider
position and display a localized error. No provider defaults or account settings
are rewritten. No additional model requests are sent.

Repeated writes for the same current or pending effort are skipped. Tick labels
use the provider's actual reasoning names instead of labeling every first level
OFF and every last level MAX (Codex Low is not Off). Failed selections remain
retryable. All palette, shader and layout code stays in the original plugin.
