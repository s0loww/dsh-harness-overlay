export const VERIFICATION_CAPABILITY = Object.freeze({
  status: 'declarative-only',
  executesChecks: false,
  projectBindings: 'external',
  mcpBindings: false,
  defaultContour: 'default',
})

export function verificationCapabilityStatus(rulepack) {
  return Object.freeze({ ...VERIFICATION_CAPABILITY, schemaVersion: rulepack.verification.schema_version })
}

export function renderVerification(rulepack) {
  const capability = verificationCapabilityStatus(rulepack)
  const checks = rulepack.verification.checks.map((check, index) =>
    `${index + 1}. ${check.id} — binding=${check.binding}; ${check.required ? 'required' : 'optional'}`)
  return [
    `capability: ${capability.status}; executes-checks: no; project-bindings: ${capability.projectBindings}; mcp-bindings: none`,
    `contour: ${rulepack.verification.id}; policy: ${rulepack.verification.policy}; schema-version: ${capability.schemaVersion}`,
    ...checks,
    'test-contour-required: yes',
    'production-requires-explicit-approval: yes',
  ].join('\n')
}

export function createVerificationTool(rulepack, defineTool) {
  return defineTool({
    name: 'airules_verification',
    description: 'Read-only embedded default verification contour. It reports policy only and never executes checks or binds MCP.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute() { return { text: renderVerification(rulepack) } },
  })
}

export function registerVerificationProvider(ctx, rulepack, { defineTool, isEnabled }) {
  const capability = verificationCapabilityStatus(rulepack)
  const note = [
    '## Embedded verification contour',
    `Capability status: ${capability.status}; this provider does not execute checks and does not bind MCP.`,
    'Use the project-defined bindings in this order: doctor -> analyze -> deploy -> test.',
    'The embedded contour is policy only: project bindings and concrete commands remain external.',
    'Deployment must target the test contour before verification.',
    'Any production mutation or deployment requires explicit user approval; never infer it from approval of a test deployment.',
  ].join('\n')
  ctx.systemPrompt.section({
    name: 'airules:verification',
    order: 6,
    text: isEnabled ? context => isEnabled(context?.agent ?? context?.scope) ? note : '' : note,
  })
  ctx.tools.register(createVerificationTool(rulepack, defineTool))
  return capability
}
