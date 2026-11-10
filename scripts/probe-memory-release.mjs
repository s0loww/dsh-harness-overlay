import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir,readFile,writeFile } from 'node:fs/promises'
import { join,resolve } from 'node:path'
import { fileURLToPath,pathToFileURL } from 'node:url'
import { runReleaseProbe,parseArguments } from './probe-specialized-release.mjs'

function values(value){if(typeof value==='string')return[value];if(Array.isArray(value))return value.flatMap(values);return value&&typeof value==='object'?Object.values(value).flatMap(values):[]}
async function captured(action){try{return await action()}catch(error){return{probeError:String(error.message)}}}
export async function memoryAcceptance({ctx,request,agents,check,report,installed,candidate,setSandboxMode}){
  const api='/airules/memory',onec=agents.find(row=>row.preset==='1c-airules')
  check('memory global native controller exists',!!ctx.airulesMemory)
  const root=join(candidate,'memory-release-fixtures',randomUUID(),'sysadmin'),id=`memory-${randomUUID()}`
  await mkdir(root,{recursive:true})
  await ctx.agents.create({sessionId:id,meta:{cwd:root,agentPreset:'sysadmin-airules',title:'Память — системный стенд'},setup:async(_scope,agent)=>{setSandboxMode(agent.session,'workspace-write');await ctx.agentPresets.select(agent,'sysadmin-airules')}})
  const sysadmin={id,root,agent:ctx.agents.get(id),preset:'sysadmin-airules'},rows=[...agents,sysadmin]
  for(const row of rows){
    const expected=row.preset!=='standard'
    check(`${row.preset} memory tool scope`,!!row.agent.ctx.tools.get('airules_memory',row.agent)===expected)
    const registry=ctx.agentPresets.serviceFor(row.agent,'skills')??ctx.skills,snapshot=await registry.snapshot({cwd:row.root,scope:row.agent})
    const skill=snapshot.skills.find(skill=>skill.name==='memory-workspace')
    check(`${row.preset} memory skill scope`,!!skill===expected)
    if(expected){
      const bytes=await readFile(join(installed,'airules-dsh-rulepack/skills/memory-workspace/SKILL.md'),'utf8')
      check(`${row.preset} memory inventory lazy`,!values(snapshot).some(text=>text.includes(bytes.trim())))
      const loaded=await row.agent.ctx.tools.execute({name:'skill',arguments:{name:'memory-workspace'},agent:row.agent,callId:`memory-skill-${randomUUID()}`,signal:new AbortController().signal})
      const heading=bytes.split(/\r?\n/u).find(line=>line.startsWith('# '))
      check(`${row.preset} native lazy memory skill load`,loaded.isError===false&&values(loaded.value??loaded.content).some(text=>text.includes(heading)))
    }
  }
  const configuration=await request(api,{query:{action:'configuration'}})
  check('memory disabled by default without implicit backend selection',configuration.ok&&configuration.config.enabled===false&&configuration.config.localProcessing===false)
  check('memory API refuses unadmitted browser',(await request(api,{authenticated:false,query:{action:'configuration'}})).status===403)
  check('memory configure requires CSRF',(await request(api,{body:{action:'configure',config:{enabled:true,endpoint:'http://127.0.0.1:18080',localProcessing:true},expectedRevision:configuration.revision}})).status===403)
  check('memory cannot mutate using GET',(await request(api,{query:{action:'configure'}})).status===405)
  check('standard session excluded from memory HTTP',!(await request(api,{id:agents.find(row=>row.preset==='standard').id,query:{action:'configuration'}})).ok)
  const config={enabled:true,endpoint:'http://127.0.0.1:18080',localProcessing:true}
  check('workspace-write cannot change machine memory config',(await request(api,{token:configuration.csrfToken,body:{action:'configure',config,expectedRevision:configuration.revision}})).error==='MEMORY_FULL_ACCESS_REQUIRED')
  const privateAuth=JSON.parse(await readFile('D:/AI_Projects/cognee_local/credentials.json','utf8'))
  assert.equal(typeof privateAuth.apiKeyResponse?.key,'string','explicit local Cognee credential exists')
  const memoryHome=join(candidate,'home/memory-workspace');await mkdir(memoryHome,{recursive:true})
  await writeFile(join(memoryHome,'auth.json'),JSON.stringify({apiKey:privateAuth.apiKeyResponse.key})+'\n',{mode:0o600,flag:'wx'})
  setSandboxMode(onec.agent.session,'danger-full-access')
  const configured=await request(api,{token:configuration.csrfToken,body:{action:'configure',config,expectedRevision:configuration.revision}})
  check('native full access can explicitly configure candidate memory',configured.ok&&configured.config.enabled===true)
  check('machine config rejects stale revision',(await request(api,{token:configuration.csrfToken,body:{action:'configure',config,expectedRevision:configuration.revision}})).status===409)
  setSandboxMode(onec.agent.session,'workspace-write')
  const execute=arguments_=>onec.agent.ctx.tools.execute({name:'airules_memory',arguments:arguments_,agent:onec.agent,callId:`memory-${randomUUID()}`,signal:new AbortController().signal})
  const status=await execute({action:'status'})
  check('native memory status reaches local authenticated service',!status.isError&&values(status).some(text=>text.includes('18080')))
  const read=await request(api,{query:{action:'documents'}})
  check('native memory fresh project starts empty',read.ok&&Array.isArray(read.documents)&&read.documents.length===0)
  const list=async()=>{const r=await fetch(config.endpoint+'/api/v1/datasets',{headers:{'X-Api-Key':privateAuth.apiKeyResponse.key}});assert.equal(r.status,200);return await r.json()}
  const before=await list()
  setSandboxMode(onec.agent.session,'read-only')
  const readonly=await captured(()=>execute({action:'remember',text:'Denied synthetic note',confirm:true}))
  check('native read-only denies memory writes',JSON.stringify(readonly).includes('MEMORY_WRITE_REQUIRED'))
  setSandboxMode(onec.agent.session,'workspace-write')
  const originalApproval=ctx.approval.request;let nativeApprovalRequests=0,deniedRequests=0
  ctx.approval.request=function(input){nativeApprovalRequests++;return originalApproval.call(this,input)}
  try{
    const blocked=await captured(()=>execute({action:'remember',text:'Native approval without open model turn',confirm:true}))
    check('memory reaches actual native approval and refuses no open turn',nativeApprovalRequests===1&&(blocked.isError===true||typeof blocked.probeError==='string'))
  }finally{ctx.approval.request=originalApproval}
  ctx.approval.request=async()=>{deniedRequests++;return'denied'}
  try{
    const denied=await captured(()=>execute({action:'remember',text:'Approval-denied synthetic note',confirm:true}))
    check('native memory mutation requires native approval',deniedRequests===1&&JSON.stringify(denied).includes('MEMORY_APPROVAL_REQUIRED'))
  }finally{ctx.approval.request=originalApproval}
  check('read-only and denied approval created no external dataset',JSON.stringify((await list()).map(row=>row.id).sort())===JSON.stringify(before.map(row=>row.id).sort()))
  const {createMemoryService,datasetForRoot}=await import(pathToFileURL(join(installed,'airules-dsh-memory-workspace/lib/core.js')))
  const service=createMemoryService({endpoint:config.endpoint,apiKey:privateAuth.apiKeyResponse.key,allowProcessing:true,journalPath:join(memoryHome,'probe-receipts.json'),timeoutMs:60000})
  const marker=`DSH-MEMORY-${randomUUID()}`,uploaded=await service.remember(onec.root,{title:'Synthetic native acceptance',text:`Captain Diesel commands Aurora. This isolated release fixture has marker ${marker}.`})
  check('explicit synthetic setup upload does not claim indexed',uploaded.state==='uploaded'&&uploaded.indexed===false)
  const pending=await service.process(onec.root)
  check('explicit synthetic processing receipt stays pending',pending.state==='processing-requested'&&pending.indexed===false)
  let task
  const completed=value=>value?.status?.state==='ready'&&value?.status?.graph_ready===true||typeof value?.status==='string'&&/COMPLETED$/u.test(value.status)
  for(let n=0;n<90;n++){task=await service.task(onec.root);if(completed(task))break;await new Promise(resolve=>setTimeout(resolve,500))}
  check('synthetic fixture actually completes processing',completed(task))
  const recall=await execute({action:'recall',query:marker,topK:5}),graph=await execute({action:'graph'})
  await writeFile(join(candidate,'smoke/memory-native-results.private.json'),JSON.stringify({task,recall,graph,marker},null,2),{mode:0o600})
  check('native memory recall retrieves source fixture marker',!recall.isError&&JSON.stringify(recall).includes(marker))
  check('native memory graph uses current project dataset',!graph.isError&&graph.value?.dataset===datasetForRoot(onec.root)&&Array.isArray(graph.value.nodes)&&graph.value.nodes.length>0&&Array.isArray(graph.value.edges))
  const python=agents.find(row=>row.preset==='python-airules')
  const foreign=await python.agent.ctx.tools.execute({name:'airules_memory',arguments:{action:'recall',query:marker,topK:5},agent:python.agent,callId:`memory-${randomUUID()}`,signal:new AbortController().signal})
  check('native python project recall excludes 1C fixture',!foreign.isError&&!JSON.stringify(foreign).includes(marker))
  setSandboxMode(onec.agent.session,'read-only')
  const readable=await execute({action:'recall',query:marker,topK:5})
  check('native read-only permits scoped memory retrieval',!readable.isError&&JSON.stringify(readable).includes(marker))
  setSandboxMode(onec.agent.session,'workspace-write')
  report.memory={endpoint:config.endpoint,configuredOnlyInCandidate:true,credentialsExposed:false,syntheticDataOnly:true,projectDataset:datasetForRoot(onec.root),nativeSkillLazy:true,approvalDenied:true,syntheticWritesExecuted:2,persistence:'Cognee separate recreate acceptance PASS',modelCalls:0}
  await writeFile(join(candidate,'smoke/memory-release-summary.json'),JSON.stringify({status:'PASS',memory:report.memory,checks:report.checks.filter(row=>/memory|synthetic|machine config|standard session|workspace-write|python project/i.test(row.name))},null,2)+'\n')
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const result=await runReleaseProbe({...parseArguments(process.argv.slice(2)),extraAcceptance:memoryAcceptance});process.stdout.write(JSON.stringify(result)+'\n');process.exit(0)}
  catch(error){process.stderr.write(JSON.stringify({status:'FAIL',code:error.message,reportPath:error.reportPath??null})+'\n');process.exit(1)}
}




