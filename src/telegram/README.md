# Telegram for airules DSH

Standalone host-level plugin for official Desktop `0.2.1-rc.5`. The settings
page stores a bot token through Windows DPAPI CurrentUser, a single owner ID,
the exact workspace/session binding and an opt-in autostart choice. The token
travels to the DPAPI helper only through anonymous pipes and is never returned
to the client. A fresh installation starts no Telegram requests.

The supplied bridge provides private-chat tasks, follow-up, rich messages,
attachments, session/model menus, stop/archive/resend and native tool approval
and question callbacks. New sessions use `1c-airules`; existing sessions retain
their own preset and access rules. An approval grants only that native call.

The owner supplies an independent BotFather bot token and their numeric user
ID through Settings → Telegram, saves, then connects a current session.
`/telegram status|on|off|connect|disconnect|help` provides local controls.
The host computer and DSH must remain running. Autostart is off by default.

Credentials, owner identity, session bindings, download/cache state and tokens
are not distributed. Headless tests use fake clients and synthetic tokens;
no live Telegram bot or paid model is contacted by the test suite.
