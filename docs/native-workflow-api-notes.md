# Native workflow process adapter

Implementation: `src/workflow-integration/lib/native-process.js`.
The module imports Node builtins only; it never imports child_process or spawns
outside the composed DSH services. Tests use fake native services, not 1C.

`createNativeProcessAdapter({ctx,agent,callId,signal,id,version,operations,core,nativeHelpers})`:

- `ctx`: composed `sandboxPolicy`, `sandbox`, `subprocess` services.
- `core`: `validateDescriptor`, `validateSchema`, `digest`, `PROCESS_RESULT_SCHEMA`.
- `nativeHelpers`: official `scrubbedParentEnv` from `@deepseek-ai/dsh-subprocess`,
  `classifyRunnerFailure` and `matchesSignature` from `@deepseek-ai/dsh-sandbox`.
- Operations are trusted registrations with fixed absolute executable, pure
  args builder, input schema, effects, `validator:'process-exit'`, optional
  resourcesRequired and fingerprintPaths. Only readsSource/startsProcess/
  writesFilesystem effects are accepted in this initial integration.

The adapter checks the exact native session and canonical cwd, resolves the
standing policy for that session, and rechecks policy before launching.
Confined modes use `sandbox.confine(argv,policy,signal)`; danger-full-access
still uses the native subprocess service. No mode widening, approval request,
fallback runner or automatic retry occurs. A future escalation UI must use
the native approval seam inside an open agent turn.

Native spawn spec: `{argv,cwd,env,graceMs:1000,signal,stdio:{stdin:'ignore',
stdout:'pipe',stderr:'pipe'}}`. This is the native argv API, not a shell string.
Only byte counts and exit/termination metadata are returned. Stderr is held
transiently within 1 MiB for official sandbox-denial/runner-failure classifiers;
neither it nor argv is persisted by this adapter. No spill files are requested.
Cancellation/timeout/output overflow terminate only the returned managed handle
and await its `waitForExit()`, bounded by a ten-second cleanup deadline.
An unconfirmed managed-range exit cannot become PASS.

API source audit: pinned `var/asar-extract-rc5/dsh/node_modules/@deepseek-ai/`:
`dsh-sandbox-policy/lib/index.js:141`, `dsh-sandbox-local/lib/index.js:305`,
`dsh-subprocess-local/lib/index.js:1547`,
`dsh-subprocess-local/lib/runner-launch-B2zsQ1Dz.js:764` and `:854`,
`dsh-user-approval/lib/index.js:128` (open-turn requirement).

Fingerprint includes the adapter module, executable, explicitly registered
runner files, descriptor and args-builder source. Builders must be pure;
mutable closure state is not an input-binding mechanism. The native service
and registration remain responsible for semantic effects, permissible
operations and the project's target identity. No deployment is enabled here.
