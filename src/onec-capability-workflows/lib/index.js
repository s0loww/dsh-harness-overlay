import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { createInvestigationStore } from './store.js'
export const name = 'airules-dsh-onec-capability-workflows'
export function apply(ctx) { ctx.provide('airulesOnecCapabilities', { investigations: createInvestigationStore(dshHomePath()) }) }
