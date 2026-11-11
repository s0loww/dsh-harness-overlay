# Processing models and optional memory confirmation

`processingManager.apply(args, internal)` accepts an application-owned second
argument:

```js
await manager.apply({expectedRevision, confirm: true, execution}, {
  memoryApproval: {
    required: effective.approval !== 'disabled',
    verify: async () => checkScopeAndExactSavedPolicyRevision(),
  },
})
```

This is not a tool/HTTP field. Omitting the internal argument retains the existing
required native approval. Explicit internal authority must contain a boolean
`required` and a verifier function; malformed authority fails closed. Putting
similar flags in the action data or model summary does not disable confirmation.

The native adapter receives this authority as the third argument of
`authorize(execution, summary, internal)`. A disabled additional confirmation does
not reinterpret native approval policy `never` as a grant: it avoids requesting
that additional application confirmation. The action still requires a live lead,
native full access, explicit `confirm`, current project identity, exact profile
revision, credentials and binding checks, model availability, active-run and
reindex gates, private backups and the fixed subprocess allowlist.

The saved policy verifier runs before and after awaited authorization and before
state/backup/configuration writes. The native runner rechecks it after executable
lookup, directly before dispatch and after completion. Revocation before dispatch
prevents recreation. Revocation after configuration changed leaves the existing
honest unknown outcome and backup; it does not trigger a blind rollback/restart.

Deletion is not a processing operation. The toggle does not add delete commands,
volume removal, arbitrary Docker operations or new subprocess capabilities.

Targeted verification: `memory-processing.test.mjs` and
`memory-processing-native.test.mjs`, 32 tests PASS. All Docker, ACL, model and
provider execution is stubbed; no real container or model state is modified.
