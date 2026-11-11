# Shared MCP provisioning in a private deployment bundle

The public source contains server descriptors and relative routes, not machine
addresses or credentials. `createPublicMcpCatalog({gatewayBaseUrl, kgBaseUrl})`
builds an environment-specific catalog from explicit private build inputs.

The catalog contains six separately exposed HTTPS MCP servers: syntax checking,
platform documentation, templates, code checking, SSL and the leasing knowledge
corpus. All six are enabled in the reviewed colleague bundle. The leasing scope
is metadata; no project identifier or namespace is silently filled in.

Infrastructure inventory verified `initialize`, `notifications/initialized` and
`tools/list` against each existing public endpoint using its existing shared
bearer. No tool calls, memory writes, model requests, deployments, new Funnel
publication or network configuration changes occurred. Private tailnet-only
Memora was excluded from the public catalog. Another publication that returned
HTTP 501 for MCP initialization was also excluded.

Private bundle inputs:

```text
payload/private/mcp-catalog.json
payload/private/mcp-credentials.json
```

The credential file has this shape, with the actual value supplied privately:

```json
{"schemaVersion":1,"credentials":{"tail-shared-bearer":"<existing-shared-key>"}}
```

These files must not enter Git or public release assets. The current private
build stores the existing credential in an owner/SYSTEM-protected local file.
A colleague may receive the explicitly authorized private package; this does
not authorize public publication of the key. The common credential is unrelated
to OpenAI accounts, API credentials, project database passwords or SSH keys.

## Installer API

`src/deployment-bundle/mcp/index.mjs` exports:

- `MCP_SERVER_DESCRIPTORS` and `createPublicMcpCatalog(inputs)`;
- `planMcpConfiguration({dshHome,catalogPath,credentialsPath})`;
- `applyMcpConfiguration({...paths,backupRoot,expectedPlanDigest,verify?})`;
- `rollbackMcpConfiguration({receiptPath,verify?})`;
- `configureMcp({...options,dryRun:true})` and `rollbackMcp` aliases.

Preview is the default. Actual apply requires the exact reviewed `planDigest`.
The digest pins existing config bytes, catalog, credentials and planned result.
The installer coordinator provides its own authority/target-liveness verifier;
this module neither changes native permissions nor restarts the application.

The native manager's actual file is `$DSH_HOME/airules-mcp-servers.json`:

```json
{"version":1,"servers":[{"serverName":"example","transport":"streamable-http","url":"https://gateway.example.invalid/mcp","headers":{"Authorization":"Bearer <private-key>"},"enabled":true}]}
```

Existing unrelated servers, manager token, OAuth data and unknown metadata are
preserved. A different same-name entry is a conflict, including a user-disabled
entry. Nothing is force-replaced. Existing matching entries are idempotent.
The module does not import or modify project `.mcp.json`, Codex configuration,
account stores or memory namespaces.

Backups preserve exact UTF-8/BOM/CRLF bytes. Files containing credentials and
the previous configuration use an empty temporary file restricted to the user
and SYSTEM before writing secrets on Windows; POSIX mode is 0600. Path aliases,
hardlinks, stale plans and changed config/backup bytes fail closed. A prepared
receipt retained after a late failure can roll back only exact applied bytes.
Public previews, returned receipts and error codes contain no bearer values.

Enabling a server only connects its tools through the existing native MCP
manager. It does not approve tools such as reload, remember, rewrite or deploy.
Each actual call remains subject to the installed runtime's permission rules.

Verification: eight isolated fixture tests cover merge/preservation, private
ACLs, exact rollback, conflicts, stale plans and credentials, idempotence,
hardlinks, authority revocation and late-failure recovery. Tests use fake URLs
and credentials and never connect to external MCP servers.
