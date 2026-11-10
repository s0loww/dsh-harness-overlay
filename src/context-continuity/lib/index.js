import { readFileSync } from 'node:fs'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import z from '@deepseek-ai/schemastery'
import { createNativeContinuity } from './native.js'

export const name = 'airules-dsh-context-continuity'
export const inject = ['agents', 'agentPresets', 'sandboxPolicy', 'fs', 'subprocess', 'sandbox', 'jobs']
export const Config = z.object({ mode: z.string().default('minimal'), criticalFiles: z.array(z.string()).default([]), collectGit: z.boolean().default(true), gitCommand: z.string().default('git'), checkpointEveryMs: z.number().default(30000), checkpointTimeoutMs: z.number().default(2500) })
export function apply(ctx, config = {}) {
  // Canonical policy is mandatory and is hashed by the bundle manifest.
  const contract = JSON.parse(readFileSync(new URL('../runtime/continuity/contract.json', import.meta.url), 'utf8'))
  const service = createNativeContinuity(ctx, { ...config, contract, createUserMessage, scrubbedParentEnv })
  ctx.provide('airulesContinuity', service)
  ctx.on('fs/observed', service.fsObserved, { global: true })
  ctx.on('tools/result', service.toolResult, { global: true })
  ctx.on('session/event', service.event, { global: true })
  ctx.on('agent/pre-step', (payload, next) => service.preStep(payload, next), { global: true, prepend: true })
}
