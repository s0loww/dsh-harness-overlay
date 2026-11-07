# airules DSH provider

Runtime adapter for a verified `airules-dsh-rulepack`. It injects the bundled
root contract, registers the read-only `airules_rule`, `airules_role`, and
`airules_verification` tools, and mounts the rulepack skills directory. It does
not read or create MCP bindings.

Two fail-closed activation modes are supported. The portable Oleg target reads
its `projectPresets` service and enables prompt sections only for the
release-patched `1c-airules` id. The clean official target loads this provider
inside a complete `@deepseek-ai/dsh-agent-preset` composition with
`compositionScoped: true`; therefore prompts, tools and skills belong to that
Agent scope and cannot enter Standard or user presets. Missing project-preset
API in the first mode is a startup error, not an implicit global enable.

The injected access note defines Rule Index IDs as package identifiers and
routes lazy loading through `airules_rule`; no project copy of the rules is
required.

## Role capability

The package API audit found no DSH extension point for registering a named
persona independently of an Agent composition:

- `subagents.registerProvider()` is an execution-backend extension point. A
  provider must implement `start()` or `prepareContinuable()`; a role file is
  neither and is never registered there.
- `agentPresets.register()` registers a complete child plugin composition.
  Turning one role file into an otherwise empty preset would remove the tools
  and prompt plugins the child needs, so this provider does not pretend that a
  role is a preset.

The honest capability status is therefore `prompt-adapter` with
`nativeRoleRegistry: false`. Every manifest role and its SHA-256 are verified
at startup. `airules_role` without `id` returns the status and stable role
catalogue; with `id` it returns the verified persona that the orchestrator must
include in an ordinary DSH subagent task prompt. The `airules:roles` system
prompt section explains the same limitation to the model.

This keeps the 13 logical roles usable without inventing a vendor API. A later
native implementation requires either a dedicated DSH role registry or full,
tested role-specific Agent preset compositions.

## Verification capability

`VerificationProvider` validates the manifest record, SHA-256 and strict schema
of `testing/default.json`. Its capability is `declarative-only`:

- `airules_verification` returns the default contour and capability status;
- it never runs `doctor`, `analyze`, `deploy`, or `test`;
- it does not resolve commands, servers, endpoints, credentials, or MCP
  bindings;
- every check remains `project-defined` and is bound outside this package.

The `airules:verification` system-prompt section preserves the policy order
`doctor -> analyze -> deploy -> test`, requires the test contour, and states
that every production mutation or deployment needs explicit user approval.
Approval for a test deployment is not production approval.

Proposed Cordis row (documentation only; it is not applied to the live DSH):

```yaml
- id: airules-policy
  name: airules-dsh-provider
  inject: [skills, systemPrompt, tools]
  config:
    compositionScoped: true
    rulepackRoot: !!js process.env.AIRULES_RULEPACK_ROOT
```

The installer must resolve `AIRULES_RULEPACK_ROOT` inside the staged bundle,
verify the pinned release and apply this row only to a candidate copy.

The row deliberately contains no `subagents` or `agentPresets` injection and
no MCP endpoint. It is documentation for a future staged Cordis patch, not a
live modification.

