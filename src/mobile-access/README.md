# Optional access from a phone

The `airules-dsh-mobile-access` package runs the pinned `dsh-relay@0.2.1`
library inside the existing Desktop process. It proxies the same sessions and
uses native host admission; no second DSH/model runtime is started.

The listener and autostart default off. The local settings page supports password
setup/replacement, HTTPS port, QR address, token-client pairing, revocation,
revoke-all, start/stop and a separate autostart preference. Start requires a saved
password and the existing internal DSH server on loopback. The password and
device-token hashes, signing key and TLS private key are stored in a dedicated
`airules-mobile-access` directory restricted to the current Windows user and
SYSTEM. Plaintext password is not returned to the UI or logs.

When explicitly enabled, HTTPS binds the configured port (default 3443) on LAN
interfaces. Addresses are offered for LAN/VPN; the feature does not create a
public tunnel, firewall rule, insecure HTTP listener or certificate trust entry.
The user handles browser certificate trust themselves. Stop closes current
connections while keeping credentials; changing password/revoking devices
terminates current connections and requires reauthentication.

All `/airules` controls plus `/airules-subscriptions-auth` and `/mcp-manager`
are excluded from relay HTTP/WebSocket proxying,
including Telegram, ACP and this settings page. Original supplier control routes
and direct native settings/credentials/account control URLs are also denied.
The relay uses `privilegedMethods: loopback-only` for its direct HTTP-method
filter. Its transparent `/api/remote.mux` WebSocket does not inspect RPC payloads;
this filter is not a general native-settings isolation boundary. Access is for
the trusted DSH owner and retains the capabilities of that running Desktop.

Live phone login, LAN firewall reachability and certificate acceptance are
separate user checks. Candidate tests use dependency fakes and never bind LAN.
