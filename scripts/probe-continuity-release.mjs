import {createNativeContinuity} from '../src/context-continuity/lib/native.js'
import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {join} from 'node:path'
import {executeProbeTool} from './probe-tool-call.mjs'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {runReleaseProbe,parseArguments} from './probe-specialized-release.mjs'
import {memoryAcceptance} from './probe-memory-release.mjs'
import {resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
export async function continuityAcceptance({ctx,agents,check,report,installed,candidate,setSandboxMode}){
 check('continuity host service exists',!!ctx.airulesContinuity)
 const root=join(agents[0].root,'sysadmin-continuity'),id=`continuity-sysadmin-${randomUUID()}`
 await mkdir(root,{recursive:true})
 await ctx.agents.create({sessionId:id,meta:{cwd:root,agentPreset:'sysadmin-airules'},setup:async(_scope,agent)=>{setSandboxMode(agent.session,'workspace-write');await ctx.agentPresets.select(agent,'sysadmin-airules')}})
 const rows=[...agents,{root,id,agent:ctx.agents.get(id),preset:'sysadmin-airules'}]
 for(const row of rows){
   const expected=row.preset!=='standard'
   check(`${row.preset} continuity tool scoped`,!!row.agent.ctx.tools.get('airules_continuity',row.agent)===expected)
   if(!expected)continue
   const result=await executeProbeTool(row.agent.ctx,{name:'airules_continuity',arguments:{action:'status'},agent:row.agent,callId:`continuity-${randomUUID()}`,signal:new AbortController().signal})
   check(`${row.preset} native continuity status execution`,!result.isError&&result.value?.mode==='minimal'&&result.value?.capabilities?.noMemoryWrites===true)
   const status=await ctx.airulesContinuity.act({action:'checkpoint'},{agent:row.agent,signal:new AbortController().signal})
   report.continuityStatus??=[];report.continuityStatus.push(status)
   if(process.env.AIRULES_PROBE_DEBUG==='1'&&!status.checkpoint?.durable){
     const contract=JSON.parse(await readFile(join(installed,'airules-dsh-context-continuity/runtime/continuity/contract.json'),'utf8'))
     const debug=createNativeContinuity(ctx,{contract,collectGit:false,onDiagnostic:error=>{void writeFile(join(candidate,'smoke/continuity-error.private.log'),String(error.stack??error),{mode:0o600})}})
     report.continuityDebug=await debug.act({action:'checkpoint'},{agent:row.agent,signal:new AbortController().signal})
   }
   check(`${row.preset} native checkpoint written with existing workspace rights`,status.checkpoint?.durable===true)
   const compactId=`continuity-native-${randomUUID()}`
   row.agent.session.append('compaction/start',{compactionId:compactId})
   row.agent.session.append('compaction/end',{compactionId:compactId})
   const restored=await ctx.airulesContinuity.preStep({agent:row.agent,signal:new AbortController().signal},async()=>({kind:'enter',messages:[]}))
   check(`${row.preset} actual mounted global service restores after native compact events`,restored.messages.length===1&&restored.messages[0].source.compactId===compactId)
   row.agent.session.append('user/message',restored.messages[0],{surfaceOp:'append'})
   const retry=await ctx.airulesContinuity.preStep({agent:row.agent,signal:new AbortController().signal},async()=>({kind:'enter',messages:[]}))
   check(`${row.preset} actual journal acknowledgement suppresses duplicate restore`,retry.messages.length===0)
   assert.equal(status.scope.sessionId,row.id)
 }
 report.continuity={mode:'minimal',nativeCompactModelAcceptance:false,deployments:0}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const args=process.argv.slice(2),withMemory=args.includes('--with-memory');const result=await runReleaseProbe({...parseArguments(args.filter(x=>x!=='--with-memory')),extraAcceptance:async x=>{await continuityAcceptance(x);if(withMemory)await memoryAcceptance(x)}});console.log(JSON.stringify(result));process.exit(0)}catch(e){console.error(JSON.stringify({status:'FAIL',code:e.message,reportPath:e.reportPath??null}));process.exit(1)}
}
