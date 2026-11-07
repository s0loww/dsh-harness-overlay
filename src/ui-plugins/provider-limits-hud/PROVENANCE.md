# Provenance

This is a new private-overlay implementation. It does not copy the Oleg
bundle's 861 KiB `lib/client.js` or its provider-account backend.

The compatibility contract was derived from read-only public surfaces:

- Oleg bundle `dsh-1c-bundle@0.1.0` route `/onec/provider-limits`;
- public MIT package `dsh-tokenledger@0.1.0` route
  `/api/tokenledger/balance`;
- official DSH `sidebar.footer.action` client slot.

Only normalized balance/quota values, display labels and status messages are
read. Credentials remain in the provider that owns the selected endpoint and
are never returned to, persisted by or logged by this plugin.
