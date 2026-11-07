import { readFile } from 'node:fs/promises'
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { classifyRunnerFailure, matchesSignature } from '@deepseek-ai/dsh-sandbox'
import { loadRuntime } from './runtime.js'
import { createWorkflowService } from './service.js'
import { createHandler, API } from './control.js'
import { readMode, writeMode } from './mode-settings.js'
export const name = 'airules-dsh-workflows'
export const inject = ['webServer', 'connection', 'sessions', 'sessionPersistence', 'sessionProjections', 'sandboxPolicy', 'sandbox', 'subprocess', 'tools', 'dshHomePath']
export const Config = z.object({ powerShellPath: z.string().default(''), trustedRunnerDigests: z.array(z.string()).default([]),
  readOnlyMcpTools: z.array(z.string()).default([]), deployMode: z.string().default('fixture-only'), allowModeConfiguration: z.boolean().default(true),
  recoveryTools: z.array(z.object({ projectId: z.string(), id: z.string(), tool: z.string(), timeoutMs: z.number().default(1800000) })).default([]),
  recoveryCommands: z.array(z.object({ projectId: z.string(), id: z.string(), runnerPath: z.string(),
    reviewedDigest: z.string(), files: z.array(z.string()), timeoutMs: z.number().default(1800000) })).default([]) })
export async function apply(ctx, config) {
  const runtime = await loadRuntime()
  const lock = JSON.parse(await readFile(new URL('../runtime/reviewed-runners.json', import.meta.url), 'utf8'))
  const modePath = ctx.dshHomePath('workflows/executor-settings.json')
  const preference = config.allowModeConfiguration === false ? { mode: config.deployMode } : await readMode(modePath, config.deployMode)
  const service = createWorkflowService({ ctx, runtime, stateDir: ctx.dshHomePath('workflows/state'), config: { ...config, deployMode: preference.mode },
    nativeHelpers: { scrubbedParentEnv, classifyRunnerFailure, matchesSignature }, reviewedDigests: lock.reviewedDigests,
    onModeChange: config.allowModeConfiguration === false ? undefined : mode => writeMode(modePath, mode) })
  class WorkflowService extends Service { constructor(scope) { super(scope, 'airulesWorkflows'); Object.assign(this, service) } }
  new WorkflowService(ctx)
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: API, handler: createHandler(ctx, service) }))
  ctx.effect(() => () => { void service.dispose() })
}
