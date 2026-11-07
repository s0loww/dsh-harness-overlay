# Provider limits HUD

Small read-only balance/quota surface for DSH. The host exposes an authenticated
GET route backed by the official `deepseekAccount.getBalance` service. It owns no
account settings, credentials, MCP configuration or policy.

The browser probes, in order:

1. `/airules/provider-limits`, the native account adapter shipped here;
2. `/onec/provider-limits` when the pinned 1C bundle supplies it;
3. `/api/tokenledger/balance` when the public TokenLedger plugin supplies it.

If no capability succeeds the footer remains available and reports a
degraded state. It does not invent a zero balance and does not prompt for a key.

The pinned official rc.5 contract returns recharge wallets in `value` and granted
wallets in `bonusWallets`, each with `currency` and string `balance`. The adapter
adds the two per currency without exchange conversion. It calls balance directly,
independently of the profile endpoint. `null` means no current account grant;
`status: failed` means balance is unavailable (the native service deliberately
does not distinguish HTTP 403, network and protocol failures). The host declares
`deepseekAccount` as a Cordis dependency so its restricted scope can read the
service. Raw errors and account credentials are never
sent to the browser. The footer loads on mount and refreshes when opened.

The first implementation is deliberately narrower than Oleg's combined UI:
it shows balances and quota windows only. Token/cost history remains owned by
`dsh-tokenledger`; provider login/settings remain owned by the target DSH.
