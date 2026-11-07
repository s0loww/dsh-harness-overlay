# Official Desktop baseline

Immutable allowlist for the clean DeepSeek Harness Desktop target. The lock was
captured from `0.2.1-rc.5` on Windows x64. It contains hashes only; no profile,
session, credential or plugin state is included.

`resources/app.asar` is deliberately part of the identity. External profile
plugins may be planned for this target, but any future internal patch must be
pinned to this exact hash and handled by a separate high-risk transaction.
