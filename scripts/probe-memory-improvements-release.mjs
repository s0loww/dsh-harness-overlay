import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runReleaseProbe, parseArguments } from './probe-specialized-release.mjs'
import { historyRecallAcceptance } from './probe-history-recall-release.mjs'
import { reviewedKnowledgeAcceptance } from './probe-reviewed-knowledge-release.mjs'
import { executeProbeTool } from './probe-tool-call.mjs'
export async function memoryImprovementsAcceptance(input) {
  await historyRecallAcceptance(input)
  await reviewedKnowledgeAcceptance(input)
  const { agents, request, check, report }=input
  for (const row of agents) {
    const expected=row.preset!=='standard'
    check(`${row.preset} skill eval native scope`,!!row.agent.ctx.tools.get('airules_skill_eval',row.agent)===expected)
    if (!expected) continue
    const call=args=>executeProbeTool(row.agent.ctx,{name:'airules_skill_eval',arguments:args,agent:row.agent,callId:`skill-fixture-${row.id}-${args.action}`,signal:new AbortController().signal})
    const planned=await call({action:'plan'})
    check(`${row.preset} skill comparison plan has current previous and baseline`,planned.isError===false&&planned.value?.variants?.length===3&&planned.value.sessions===6)
    const planId=planned.value?.planId
    const ran=await call({action:'fixture',planId})
    check(`${row.preset} isolated fixture comparison runs without model`,ran.isError===false&&ran.value?.modelRequests===0&&ran.value.execution==='fixture')
    const result=await call({action:'report',planId})
    check(`${row.preset} skill evaluation report is accessible`,result.isError===false&&typeof result.value?.report==='string')
    const catalog=await request('/airules/memory',{id:row.id,query:{action:'memoraCatalog'}})
    check(`${row.preset} memory catalogue does not require Cognee enabled`,catalog.ok===true&&catalog.availability==='catalog-only'&&Array.isArray(catalog.tools)&&catalog.connected===null)
  }
  report.memoryImprovements={models:0,deployments:0,backendWrites:0,uiInteraction:'verified-separately'}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await runReleaseProbe({...parseArguments(process.argv.slice(2)),extraAcceptance:memoryImprovementsAcceptance}))); process.exit(0) }
  catch(error) { console.error(JSON.stringify({status:'FAIL',code:error.message,reportPath:error.reportPath??null}));process.exit(1) }
}
