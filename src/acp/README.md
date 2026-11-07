# ACP for airules Desktop

Optional local inbound ACP and the public ACP adapter's outbound model/team UI.
No listener is started by default and the outbound configuration starts with
zero agents. No Codex/Claude executable, login state or credential is bundled.

Two Loader entries are required:

```yaml
- id: airules-acp-control
  name: airules-dsh-acp
- id: airules-acp-adapter
  name: '@zaimokuza/dsh-acp-adapter'
  config:
    agents: {}
    toolApprovalDefault: ask
```

The second entry mounts the public adapter and its schema, so its installed
settings identity, native model picker and Team integration remain intact.
Settings import has an explicit empty agents map and cannot import old agents.
The public client module is discovered from that top-level package normally.

Inbound uses the native `@deepseek-ai/dsh-acp@0.2.1-rc.5` implementation and
the selected default model. The Windows named pipe requires a fresh random
token held in a current-user-protected endpoint file. The UI never returns that
token; connection settings point to `lib/connect.mjs`, which reads it locally.
The connection configuration includes `ELECTRON_RUN_AS_NODE=1`, required when
the Desktop host's executable is Electron rather than a separate Node binary.
Start/stop and autostart are independent; autostart defaults off. Stopping ACP
closes its ACP connections, not ordinary Desktop chats.

Outbound uses `@zaimokuza/dsh-acp-adapter@0.2.1-rc.3.1`. Configure an explicit
absolute installed executable path and separate argument list. Shells,
npm/npx/pnpm launchers, symlinks and missing executables are rejected. The
adapter's ordinary native subprocess transport remains responsible for launch
and cancellation. API-key environment variables are cleared so subscription
CLI authorization remains user-owned. An outgoing ACP model requires an exact
`1c-airules` session in native development mode and `danger-full-access`, as an
external process cannot enforce DSH's parent filesystem sandbox. The port never
changes the permission mode. Normal human approval remains available.

This package changes no project MCP configuration. Login, model access and
real paid requests must be verified separately by the user after configuration.
