import { createNativeKnowledge } from './native.js'
export const name = 'airules-reviewed-knowledge'
export const inject = ['agents', 'agentPresets', 'sandboxPolicy', 'sessionQuery', 'airulesMemory']
export function apply(ctx) { ctx.provide('airulesKnowledge', createNativeKnowledge(ctx)) }
