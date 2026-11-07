# Telegram provenance

Runtime source: the supplied DSH Desktop 1C release `20261103-134539`.
Wrapper/controller/DPAPI helper and Telegram-only settings component are
adapted from that release. Vendor bridge originates in
`https://github.com/IgnatAi401/dsh-telegram`, commit
`004640f220374e72507056e88cf8aa90ae9cb737`, version `0.3.0`.

The supplied vendor LICENSE is preserved verbatim under
`vendor/dsh-telegram/LICENSE`: MIT, copyright 2026 IgnatAy. Its package metadata
and UPSTREAM record instead declare BSD-3-Clause. This discrepancy is recorded
without replacing or inventing a copyright notice. The source UPSTREAM and
ADAPTATIONS records are retained. Obtain clarification before external release.

Local adaptations isolate credentials under `airules-telegram/settings`, remove
legacy environment import/implicit launch, select `1c-airules` for new sessions,
and use native Desktop connection admission with a separate CSRF token.
The DPAPI entropy identifies this package, so supplier credentials cannot be
silently imported. No runtime settings or credentials are part of this source.
