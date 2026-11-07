# Provenance

Source: `dist/airules-ui-overlay-0.1.0-dev5/payload/packages/dsh-mcp-manager`, package dsh-mcp-manager 0.6.0, upstream https://github.com/Nichts0v0/dsh-mcp-manager. Copyright (c) 2026 Nichts0v0. The complete MIT license is preserved in `LICENSE`; bundled third-party notices in the compiled source are retained.

Source SHA-256 before adaptation:

| File | SHA-256 |
| --- | --- |
| lib/index.js | D5FE3195927D66C44A8B66E247712D15AA010D41B7E76576F9A6FFFB9B30E6D6 |
| lib/client.js | FC6A9E669F52BF9293484FC0A263E292BBB58B6C441C971AD7B9A961F79B27AA |

`lib/engine.js` retains the full bundled manager implementation. Adaptations: own endpoint prefix and machine-store filename; protected atomic writes; hooks exposing configured tool prefixes and pending OAuth state to the admission wrapper. Unavailable source maps were removed. No credentials or server configuration were copied.

`lib/client.js` retains the complete settings UI. Adaptations: own module identity and endpoint, native settings.section instead of Oleg-specific provide-only slot, same-origin requests and CSRF bootstrap. Source locale namespaces are retained.

`lib/index.js`, `lib/security.js`, and `lib/protected-file.js` supply the native DSH admission adapter, per-manager model-tool policy, sanitized HTTP responses/logging, narrow one-use local OAuth callback, and current-user file protection. They do not modify host services globally. Runtime npm dependency closure is empty; host-provided DSH services and client locale/UI slots are the only integration requirements.
