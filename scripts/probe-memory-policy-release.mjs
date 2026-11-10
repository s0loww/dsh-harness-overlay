import {randomUUID} from 'node:crypto'
import {join,resolve} from 'node:path'
import {pathToFileURL,fileURLToPath} from 'node:url'
import {executeProbeTool} from './probe-tool-call.mjs'
import {runReleaseProbe,parseArguments} from './probe-specialized-release.mjs'
import {memoryImprovementsAcceptance} from './probe-memory-improvements-release.mjs'
export async function memoryPolicyAcceptance(input){
 await memoryImprovementsAcceptance(input)
 const {ctx,request,agents,check,report,installed,setSandboxMode}=input
 for(const row of agents)if(row.preset!=='standard')setSandboxMode(row.agent.session,'workspace-write')
 const {defineTool}=await import(pathToFileURL(join(process.env.AIRULES_PROBE_NATIVE_MODULES,'@deepseek-ai/dsh-tools/lib/index.js')))
 const binding={namespace:'isolated-release-fixture',search:{tool:'mcp__memory_fixture__search',scopeArgument:'project',queryArgument:'query'},remember:{tool:'mcp__memory_fixture__save',scopeArgument:'project',textArgument:'text'}}
 const primary=agents[0],seen=[],invoke=(row,name,args)=>executeProbeTool(row.agent.ctx,{name,arguments:args,agent:row.agent,callId:'memory-policy-'+randomUUID(),signal:new AbortController().signal})
 for(const row of agents){
  for(const name of ['airules_memory','airules_links','airules_describe_image'])check(`${row.preset} new tool scope ${name}`,!!row.agent.ctx.tools.get(name,row.agent)===(row.preset!=='standard'))
  if(row.preset==='standard')continue
  const scoped=ctx.agentPresets.serviceFor(row.agent,'tools')??row.agent.ctx.tools
  for(const kind of ['search','save'])scoped.register(defineTool({name:binding[kind==='search'?'search':'remember'].tool,description:'Synthetic release fixture only',parameters:{project:{type:'string'},[kind==='search'?'query':'text']:{type:'string'}},output:{schema:{type:'object',additionalProperties:true},render:(_a,v)=>[{type:'text',text:JSON.stringify(v)}]},execute(args,exec){seen.push({kind,args,parent:typeof exec.parent,root:typeof exec.root,token:typeof exec.token});return kind==='search'?{project:args.project,results:[{id:'synthetic-1',text:'Synthetic fixture evidence',score:0.25,project:args.project}]}:{project:args.project,id:'synthetic-1',status:'stored'}}}))
 }
 let config=await request('/airules/memory',{query:{action:'configuration'}})
 await request('/airules/memory',{id:'closed-fixture',token:config.csrfToken,body:{action:'policyGlobal',policy:{schemaVersion:1,mode:'cognee',writeTarget:'auto'},expectedRevision:config.policy.globalRevision}})
 config=await request('/airules/memory',{query:{action:'configuration'}})
 check('persistent global memory policy has independent model roles',config.ok&&config.policy.global.mode==='cognee'&&config.processing.profile.embeddings.provider==='fastembed'&&config.processing.profile.extraction.provider==='gliner')
 const global=await request('/airules/memory',{id:'closed-fixture',token:config.csrfToken,body:{action:'policyGlobal',policy:{schemaVersion:1,mode:'both',writeTarget:'auto'},expectedRevision:config.policy.globalRevision}})
 check('global memory mode saves with no open executor',global.ok)
 config=await request('/airules/memory',{query:{action:'configuration'}})
 const saved=await request('/airules/memory',{token:config.csrfToken,body:{action:'projectPolicy',policy:{schemaVersion:1,mode:'inherit',writeTarget:'inherit',memoria:binding},expectedRevision:config.policy.projectRevision}})
 check('project memory mapping saves via native filesystem '+(saved.error??''),saved.ok)
 let called=await invoke(primary,'airules_memory',{action:'recall',query:'isolated fixture'})
 if(called.isError)throw Error('MEMORY_NATIVE_RECALL_FAILED '+JSON.stringify(called.error))
 check('both recall labels Memoria success and Cognee unavailable',called.value.status==='partial'&&called.value.backends.memoria.status==='ok'&&called.value.backends.cognee.status==='unavailable'&&called.value.results[0].backend==='memoria')
 check('nested typed MCP call keeps native parent root and token',seen.length===1&&seen[0].parent==='symbol'&&seen[0].token==='symbol')
 const before=seen.length,direct=await invoke(primary,binding.search.tool,{project:binding.namespace,query:'bypass'})
 check('raw memory MCP cannot bypass saved policy',direct.isError===true&&seen.length===before)
 const ui=await request('/airules/memory',{token:config.csrfToken,body:{action:'recall',query:'UI fixture'}})
 check('memory UI uses real native tool pipeline for MCP reads',ui.ok&&ui.backends?.memoria?.status==='ok')
 config=await request('/airules/memory',{query:{action:'configuration'}})
 const stale=await invoke(primary,'airules_memory',{action:'recall',query:'stale',expectedPolicyRevision:'old'})
 check('stale saved policy fails before backend dispatch',stale.isError===true)
 const override=await request('/airules/memory',{token:config.csrfToken,body:{action:'projectPolicy',policy:{schemaVersion:1,mode:'memoria',writeTarget:'auto',memoria:binding},expectedRevision:config.policy.projectRevision}})
 check('project override selects Memoria independently of global both',override.ok&&(await ctx.airulesMemory.configuration({sessionId:primary.id})).policy.effective.mode==='memoria')
 const approval=ctx.approval.request;ctx.approval.request=async()=> 'allowed-once'
 try{
  const args={action:'remember',text:'Synthetic acceptance only; not a user project fact.',title:'Synthetic fixture',confirm:true}
  const first=await invoke(primary,'airules_memory',args),again=await invoke(primary,'airules_memory',args)
  check('Memoria write returns durable stored receipt and no repeated dispatch',first.isError===false&&first.value.state==='stored'&&first.value.indexed===null&&again.isError===false&&seen.filter(x=>x.kind==='save').length===1)
 }finally{ctx.approval.request=approval}
 const utilities=await request('/airules/runtime-utilities')
 check('runtime utilities start disabled without image request or inhibitor',utilities.ok&&utilities.config.keepAwake===false&&utilities.config.vision.enabled===false)
 report.memoryPolicy={typedMcpFixtureCalls:seen.length,realBackendWrites:0,paidRequests:0,realDeployments:0,globalAndProject:true}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))try{console.log(JSON.stringify(await runReleaseProbe({...parseArguments(process.argv.slice(2)),extraAcceptance:memoryPolicyAcceptance})));process.exit(0)}catch(error){console.error(JSON.stringify({status:'FAIL',code:error.message,reportPath:error.reportPath}));process.exit(1)}
