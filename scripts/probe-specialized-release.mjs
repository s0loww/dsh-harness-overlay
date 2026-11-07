import assert from 'node:assert/strict'
import { createHash,randomUUID } from 'node:crypto'
import { mkdir,readFile,writeFile,access,rm } from 'node:fs/promises'
import { join,resolve,isAbsolute,relative,sep } from 'node:path'
import { fileURLToPath,pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import net from 'node:net'
import { assertCandidatePath,preflightCandidate } from './smoke-official-candidate.mjs'
import { ONEC_LSP_TOOL_NAMES,verifyOnecLspCompatibility } from '../src/onec-lsp-compat/patch.mjs'
import { verifyComposerHistoryCompatibility } from '../src/composer-history-compat/patch.mjs'

const REPO=resolve(fileURLToPath(new URL('..',import.meta.url)))
export const SPECIALIZED_SKILLS=['1c-repository-manage','1c-ai-merge','v8unpack-cf','1c-element']
const PACKAGES=['airules-dsh-provider-extensions','airules-dsh-cursor-provider','airules-dsh-onec-specialized']
const COMPOSER_SOURCE={sourceManifestSha256:'4891909f369c769f443c121ec924ef639fef65a1bdfd46ea32854e66f8812fa8',sourceEntrySha256:'71d3da278a8533af60e111e2908bf61203844397f473689cf9c0f6034cbf0703',sourceClientSha256:'84cc4d9d4208e042505317661ed2d233754ad4a11804d1ac8318833a6537c806'}
const sha=value=>createHash('sha256').update(value).digest('hex')
const tick=ms=>new Promise(resolve=>setTimeout(resolve,ms))
export function parseArguments(argv){
  const values={servePreview:false,previewTimeoutMs:600000}
  const keys={'--candidate-root':'candidateRoot','--ui-artifact':'uiArtifactRoot','--policy-artifact':'policyArtifactRoot','--preview-timeout-ms':'previewTimeoutMs'}
  for(let index=0;index<argv.length;index++){
    const key=argv[index]
    if(key==='--serve-preview'){values.servePreview=true;continue}
    if(!keys[key]||!argv[index+1]||argv[index+1].startsWith('--')||values[keys[key]]!==undefined&&key!=='--preview-timeout-ms')throw new Error('EXPLICIT_RELEASE_PROBE_ARGUMENTS_REQUIRED')
    values[keys[key]]=key==='--preview-timeout-ms'?Number(argv[++index]):argv[++index]
  }
  for(const key of ['candidateRoot','uiArtifactRoot','policyArtifactRoot'])if(typeof values[key]!=='string'||!isAbsolute(values[key]))throw new Error('EXPLICIT_RELEASE_PROBE_ARGUMENTS_REQUIRED')
  if(!Number.isSafeInteger(values.previewTimeoutMs)||values.previewTimeoutMs<1000||values.previewTimeoutMs>1200000)throw new Error('PREVIEW_TIMEOUT_INVALID')
  return values
}
export function loopbackHost(value){return ['127.0.0.1','localhost','::1','[::1]'].includes(String(value??'').toLowerCase())}
function installNetworkGuard(report,candidate){
  const fetchOriginal=globalThis.fetch,connectOriginal=net.Socket.prototype.connect
  globalThis.fetch=(input,init)=>{
    let url;try{url=new URL(typeof input==='string'||input instanceof URL?input:input.url)}catch{report.externalConnectionAttempts++;throw new Error('RELEASE_PROBE_EXTERNAL_REQUEST_FORBIDDEN')}
    if(!['http:','https:'].includes(url.protocol)||!loopbackHost(url.hostname)){report.externalConnectionAttempts++;throw new Error('RELEASE_PROBE_EXTERNAL_REQUEST_FORBIDDEN')}
    return fetchOriginal(input,init)
  }
  net.Socket.prototype.connect=function(...args){
    const first=Array.isArray(args[0])?args[0][0]:args[0]
    const host=typeof first==='object'&&first!==null?first.host??first.hostname:typeof first==='number'?args[1]:undefined
    const path=typeof first==='string'?first:first?.path
    const rel=typeof path==='string'?relative(candidate,resolve(path)):null
    const privatePipe=typeof path==='string'&&(path.startsWith('\\\\.\\pipe\\')||isAbsolute(path)&&rel!==null&&!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith(`..${sep}`))
    if(!privatePipe&&!loopbackHost(host??'localhost')){report.externalConnectionAttempts++;throw new Error('RELEASE_PROBE_EXTERNAL_CONNECTION_FORBIDDEN')}
    return connectOriginal.apply(this,args)
  }
  return()=>{globalThis.fetch=fetchOriginal;net.Socket.prototype.connect=connectOriginal}
}
export async function seedComparison(root){
  await mkdir(join(root,'.git'),{recursive:true})
  for(const [tree,caption]of [['current','Local fixture'],['vendor','Vendor fixture']]){
    await mkdir(join(root,tree,'Documents'),{recursive:true})
    await writeFile(join(root,tree,'Documents','Probe.xml'),`<?xml version="1.0" encoding="UTF-8"?><Document><Name>Probe</Name><Caption>${caption}</Caption></Document>\n`)
  }
}
/** Use the public native durability/workspace services; never append a model turn. */
export async function persistPreviewFixture(ctx,{root,agent,id}){
  const titles=ctx.get?.('sessionTitle')??ctx.sessionTitle
  titles?.rename(agent.session,'Хранилище и обновления — локальный стенд')
  await ctx.sessions.flush(agent.session)
  const workspace=await ctx.workspaceRegistry.create(root,'Релиз 1С — изолированный стенд')
  await workspace.attachSession(id)
  const persisted=await ctx.sessionPersistence.list()
  assert.ok(persisted.some(row=>row.header.id===id),'fixture session is durably persisted')
  assert.ok(workspace.sessionIds.includes(id),'fixture session belongs to native workspace')
  return {workspaceId:String(workspace.id),sessionId:id,persisted:true,attached:true}
}
function textValues(value){if(typeof value==='string')return[value];if(Array.isArray(value))return value.flatMap(textValues);return value&&typeof value==='object'?Object.values(value).flatMap(textValues):[]}
export function composerProvenanceProof(value){
  const found=[]
  function visit(row){if(!row||typeof row!=='object')return;if(Object.keys(COMPOSER_SOURCE).every(key=>typeof row[key]==='string')&&typeof row.stagedClientSha256==='string')found.push(row);for(const child of Object.values(row))visit(child)}
  visit(value)
  assert.equal(found.length,1,'exact composer compatibility provenance')
  const proof=found[0]
  for(const[key,expected]of Object.entries(COMPOSER_SOURCE))assert.equal(proof[key],expected,'pinned composer source provenance')
  for(const key of ['stagedManifestSha256','stagedClientSha256'])assert.match(proof[key],/^[a-f0-9]{64}$/u)
  assert.equal(proof.hostVersion,'0.2.1-rc.5')
  assert.equal(proof.contract,'exact-rc5-retained-chat-projection-no-storage-migration')
  return proof
}
export async function inspectComposerCompatibility(modules,uiArtifactRoot){
  const manifest=JSON.parse(await readFile(join(uiArtifactRoot,'ui-overlay-manifest.json'),'utf8'))
  const row=manifest.packageProvenance.find(value=>value.name==='dsh-composer-history'),proof=composerProvenanceProof(row)
  const packageBytes=await Promise.all(['package.json','lib/index.js','lib/client.js'].map(file=>readFile(join(modules,'dsh-composer-history',file))))
  const verified=verifyComposerHistoryCompatibility(...packageBytes)
  for(const[key,value]of Object.entries(verified))assert.equal(proof[key],value,'composer compatibility matches reviewed staged bytes')
  for(const file of ['package.json','lib/index.js','lib/client.js']){
    const installed=await readFile(join(modules,'dsh-composer-history',file)),path=`payload/packages/dsh-composer-history/${file}`
    assert.equal(sha(installed),manifest.files[path]?.sha256,'installed composer matches sealed UI artifact')
    assert.equal(sha(installed),file==='package.json'?proof.stagedManifestSha256:file==='lib/client.js'?proof.stagedClientSha256:proof.sourceEntrySha256,'installed composer matches compatibility hashes')
  }
  const client=await readFile(join(modules,'dsh-composer-history/lib/client.js'),'utf8')
  assert.ok(client.includes('parts.push(...extract(historyNodes(id), options.maxHistory));'))
  assert.ok(!client.includes('parts.push(...extract(binding.session.getSnapshot().nodes, options.maxHistory));'))
  return {proof,installedBytesVerified:true,storageMigration:false,browserHistoryExecution:false}
}

/** Read installed client modules as data; no browser auth component is mounted. */
export async function inspectProviderCards(modules){
  const h=(type,props,...children)=>({type,props:props??{},children:children.flat()})
  const React={createElement:h,Fragment:'fragment',useState:value=>[value,()=>{}],useRef:value=>({current:value}),useCallback:value=>value,useEffect(){},useSyncExternalStore:(_subscribe,get)=>get()}
  async function client(name){
    const packageRoot=join(modules,name),pkg=JSON.parse(await readFile(join(packageRoot,'package.json'),'utf8'))
    assert.ok(pkg.dsh?.client,`${name} installed client metadata`)
    const entry=pkg.exports?.['./client']
    assert.equal(typeof entry,'string',`${name} installed client export`)
    return readFile(join(packageRoot,entry),'utf8')
  }
  const resolveClient=source=>{let result;runInNewContext(source,{window:{__ModuleLoader__:{load(module){result=module.factory(id=>{assert.equal(id,'react');return React})}}}});return result}
  const additional=resolveClient(await client('airules-dsh-additional-providers')),
    drivers=resolveClient(await client('airules-dsh-provider-extensions')),cursor=resolveClient(await client('airules-dsh-cursor-provider'))
  const bridge={getSnapshot:()=>undefined,subscribe:()=>()=>{}}
  const dependencies={react:React,'@deepseek-ai/dsh-client-ui-settings-models':{airulesProviders:bridge},'@deepseek-ai/dsh-client-ui-settings-account':{airulesProvidersAccount:bridge},
    'airules-dsh-subscriptions':{SubscriptionProviderPanel:function SubscriptionProviderPanel(){}},'airules-dsh-additional-providers':additional,'airules-dsh-provider-extensions':drivers,'airules-dsh-cursor-provider':cursor}
  let unified;runInNewContext(await client('airules-dsh-providers-settings'),{window:{__ModuleLoader__:{load(module){unified=module.factory(id=>{assert.ok(dependencies[id]);return dependencies[id]})}}}})
  const tree=unified.ProvidersPage({ctx:{connection:{rpc:{}}},renderSlot:()=>null}),nodes=[]
  function visit(node){if(!node||typeof node!=='object')return;nodes.push(node);node.children?.flat().forEach(visit)}visit(tree)
  const cards=nodes.filter(node=>node.type===unified.Card)
  return {cards:cards.map(node=>({title:node.props.title,hasKnownCount:node.props.count!==undefined})),
    components:{apiPlans:typeof additional.ApiPlanSettings==='function',drivers:typeof drivers.DriverSettings==='function',cursor:typeof cursor.CursorSettings==='function'},
    metadataOnly:true,browserMounted:false}
}

export async function runReleaseProbe({candidateRoot,uiArtifactRoot,policyArtifactRoot,servePreview=false,previewTimeoutMs=600000}){
  const candidate=assertCandidatePath(candidateRoot)
  await preflightCandidate({candidateRoot:candidate,uiArtifactRoot,policyArtifactRoot})
  const installed=join(candidate,'home/profiles/desktop/node_modules'),smoke=join(candidate,'smoke')
  await mkdir(smoke,{recursive:true})
  const report={schemaVersion:1,acceptanceScope:'native-host-installed-bytes-and-authenticated-loopback',browserAcceptance:'requires-separate-browser-proof',
    artifacts:{ui:JSON.parse(await readFile(join(uiArtifactRoot,'ui-overlay-manifest.json'),'utf8')).artifact,policy:JSON.parse(await readFile(join(policyArtifactRoot,'official-policy-manifest.json'),'utf8')).artifact},
    checks:[],modelRequestAttempts:0,externalConnectionAttempts:0,mcpCallsExecuted:0,projectRunnersExecuted:0,realOnecCalls:0,deploymentsExecuted:0,unexpectedTools:[],nativeSubprocessAttempts:0}
  const check=(name,passed)=>{report.checks.push({name,passed:!!passed});assert.ok(passed,name)}
  const modules=join(REPO,'var/asar-extract-rc5/dsh/node_modules/@deepseek-ai'),patch=join(candidate,'specialized-release-probe.patch.yml')
  await writeFile(patch,'- id: web-runtime\n  config:\n    openBrowser: false\n    printUrl: false\n    surfaceContext: false\n- id: webserver\n  config:\n    host: 127.0.0.1\n    port: 0\n    compression: gzip\n    compressionLevel: 1\n    compressionThresholdBytes: 1024\n- id: ui-settings-general\n  name: \'@deepseek-ai/dsh-client-ui-settings-general\'\n  config:\n    welcomeNoticeVersion: 2026-09-28.1\n')
  process.env.DSH_HOME=join(candidate,'home');process.env.DSH_AGENTS_HOME=join(candidate,'home-agents');process.env.DSH_TELEMETRY='off';process.env.DSH_TELEMETRY_DISABLED='1'
  process.chdir(candidate)
  const restoreNetwork=installNetworkGuard(report,candidate)
  let app,privatePreviewPath,stopPath
  const deadline=setTimeout(()=>{process.stderr.write('SPECIALIZED_RELEASE_PROBE_TIMEOUT\n');process.exit(2)},180000)
  try {
    const {runProfile}=await import(pathToFileURL(join(modules,'dsh/lib/profile-boot.js'))),{loadLayeredEnv}=await import(pathToFileURL(join(modules,'dsh-app-boot/lib/index.js'))),{setSandboxMode}=await import(pathToFileURL(join(modules,'dsh-sandbox-policy/lib/index.js')))
    app=await runProfile({profile:'desktop',environment:loadLayeredEnv('dsh',candidate),patchFiles:[patch],args:[]})
    const ctx=app.ctx
    ctx.on('agent/request',()=>{report.modelRequestAttempts++;throw new Error('RELEASE_PROBE_MODEL_REQUEST_FORBIDDEN')},{prepend:true})
    ctx.tools.guard(execution=>{if(['skill','airules_onec_specialized'].includes(execution.name))return;report.unexpectedTools.push(execution.name);return 'RELEASE_PROBE_TOOL_FORBIDDEN'})
    ctx.subprocess.spawn=()=>{report.nativeSubprocessAttempts++;throw new Error('RELEASE_PROBE_RUNNER_FORBIDDEN')}
    report.plugins=[...ctx.loader.entries()].filter(row=>PACKAGES.includes(row.options?.name)).map(row=>({id:row.options.id,name:row.options.name,state:row.fiber?.state??null}))
    check('all three installed release plugins started',report.plugins.length===3&&report.plugins.every(row=>row.state===2))
    check('installed specialized and native workbench services exist',!!ctx.airulesOnecSpecialized&&!!ctx.airulesOnecWorkbench)
    const composer=[...ctx.loader.entries()].filter(row=>row.options?.name==='dsh-composer-history')
    check('installed composer history global fiber is active',composer.length===1&&composer[0].fiber?.state===2)
    report.composerCompatibility=await inspectComposerCompatibility(installed,uiArtifactRoot)
    check('composer source and staged Chat projection hashes verified',report.composerCompatibility.installedBytesVerified&&report.composerCompatibility.storageMigration===false)
    report.providersUi=await inspectProviderCards(installed)
    check('installed provider modules expose twelve cold cards',report.providersUi.cards.length===12&&Object.values(report.providersUi.components).every(Boolean)&&report.providersUi.cards.every(row=>!row.hasKnownCount))
    const fixtureRoot=join(candidate,'specialized-release-fixtures',randomUUID()),agents=[]
    await seedComparison(fixtureRoot)
    for(const preset of ['1c-airules','standard','python-airules']){
      const root=preset==='1c-airules'?fixtureRoot:join(fixtureRoot,preset),id=`release-${randomUUID()}`;await mkdir(root,{recursive:true})
      await ctx.agents.create({sessionId:id,meta:{cwd:root,agentPreset:preset,title:`Проверки релиза · ${preset}`},setup:async(_scope,agent)=>{setSandboxMode(agent.session,'workspace-write');await ctx.agentPresets.select(agent,preset)}})
      const agent=ctx.agents.get(id);check(`${preset} native composition healthy`,!!agent&&ctx.agentPresets.composedPreset(agent.ctx)===preset)
      agents.push({id,root,agent,preset})
    }
    const onec=agents[0],signal=()=>new AbortController().signal
    for(const row of agents)for(const name of ['airules_onec_specialized','airules_background_call'])check(`${row.preset} scopes ${name}`,!!row.agent.ctx.tools.get(name,row.agent)===(row===onec))
    report.lspCompatibility={tools:[]}
    for(const row of agents){
      const present=ONEC_LSP_TOOL_NAMES.filter(name=>row.agent.ctx.tools.get(name,row.agent))
      report.lspCompatibility.tools.push({preset:row.preset,names:present})
      check(`${row.preset} scopes all eight native LSP tools`,row===onec?present.length===8:present.length===0)
    }
    const composition=(await ctx.agentPresets.compositionInventory()).find(row=>row.id==='1c-airules')
    const lspRow=composition?.rows?.find(row=>row.entryId==='onec-lsp-actions')
    report.lspCompatibility.activation=lspRow?{entryId:lspRow.entryId,enabled:lspRow.enabled,fiberState:lspRow.fiberState}:null
    check('native scoped LSP fiber is enabled and active',lspRow?.enabled===true&&lspRow?.fiberState===2)
    report.lspCompatibility.hashes=verifyOnecLspCompatibility(await readFile(join(installed,'dsh-lsp-actions/package.json')),await readFile(join(installed,'dsh-lsp-actions/lib/index.js')))
    report.lspCompatibility.serverExecution='NOT_RUN'
    check('installed LSP compatibility metadata and unchanged entry are pinned',report.lspCompatibility.hashes.hostVersion==='0.2.1-rc.5')
    const rulepack=join(installed,'airules-dsh-rulepack'),manifest=JSON.parse(await readFile(join(rulepack,'manifest.json'),'utf8'))
    check('release declares fifty-two packaged skills',manifest.counts.skills===52)
    for(const row of agents){
      const registry=ctx.agentPresets.serviceFor(row.agent,'skills')??ctx.skills,snapshot=await registry.snapshot({cwd:row.root,scope:row.agent})
      check(`${row.preset} native skill inventory complete`,snapshot.complete)
      for(const name of SPECIALIZED_SKILLS){
        const available=snapshot.skills.some(skill=>skill.name===name);check(`${row.preset} isolates ${name}`,available===(row===onec))
        if(!available)continue
        const bytes=await readFile(join(rulepack,'skills',name,'SKILL.md'));check(`${name} packaged canonical digest`,manifest.files[`skills/${name}/SKILL.md`]?.sha256===sha(bytes))
        check(`${name} inventory remains lazy`,!textValues(snapshot).some(text=>text.includes(bytes.toString('utf8').trim())))
        const value=await row.agent.ctx.tools.execute({name:'skill',arguments:{name},agent:row.agent,callId:`release-skill-${randomUUID()}`,signal:signal()})
        const heading=bytes.toString('utf8').split(/\r?\n/u).find(line=>line.startsWith('# '))
        check(`${name} loads through installed native skill tool`,value.isError===false&&!!heading&&textValues(value.value??value.content).some(text=>text.includes(heading)))
      }
    }
    const origin=ctx.webServer.getOrigin(),login=await fetch(ctx.connection.authenticatedUrl(origin),{redirect:'manual'}),cookies=(login.headers.getSetCookie?.()??[login.headers.get('set-cookie')]).filter(Boolean).map(value=>value.split(';')[0]).join('; ')
    check('native authenticated loopback admission exchanged',login.status===303&&!!cookies)
    async function request(path,{body,token,id=onec.id,query={},authenticated=true}={}){
      const url=new URL(path,origin);if(!body){url.searchParams.set('sessionId',id);for(const[key,value]of Object.entries(query))url.searchParams.set(key,value)}
      const response=await fetch(url,{method:body?'POST':'GET',headers:{...(authenticated?{cookie:cookies}:{}),origin:new URL(origin).origin,...(body?{'content-type':'application/json','x-airules-csrf':token??'','x-dsh-csrf':token??''}:{})},...(body?{body:JSON.stringify({sessionId:id,...body})}:{})})
      let value;try{value=await response.json()}catch{value={ok:false}}
      return{status:response.status,...value}
    }
    check('provider status refuses unadmitted browser',(await request('/airules/provider-drivers',{authenticated:false})).status===403)
    const providers=await request('/airules/provider-drivers'),plans=await request('/airules/additional-provider-plans'),kimi=await request('/airules/additional-providers'),cursor=await request('/airules/cursor-provider')
    check('Google and Muse cold status has no implicit auth or runtime',providers.ok&&providers.providers.length===2&&providers.providers.every(row=>!row.configured&&!row.connected&&!row.enabled))
    check('three native key plans start disconnected',plans.ok&&plans.providers.length===3&&plans.providers.every(row=>row.available&&!row.connected))
    check('Kimi cold status does not claim connection',kimi.ok&&!kimi.connected&&kimi.phase==='idle')
    check('Cursor cold status does not load external SDK or account',cursor.ok&&!cursor.connected&&!cursor.runtime&&!cursor.models?.length)
    const api='/airules/onec-specialized',initial=await request(api)
    check('native specialized GET exposes writable empty binding',initial.ok&&initial.workspace.writable&&!initial.binding.exists&&!initial.runnerTemplate.exists)
    check('specialized POST requires CSRF',(await request(api,{body:{action:'install-runner',expectedVersion:null}})).status===403)
    const install=await request(api,{body:{action:'install-runner',expectedVersion:null},token:initial.csrfToken})
    check('fixed runner installs through native createIfAbsent',install.ok&&install.runnerTemplate.exists&&sha(await readFile(join(onec.root,initial.runnerTemplate.path)))===initial.runnerTemplate.sha256)
    check('runner createIfAbsent rejects stale empty version',(await request(api,{body:{action:'install-runner',expectedVersion:null},token:initial.csrfToken})).status===409)
    const text=JSON.stringify({schemaVersion:1,aiMerge:{current:'current',vendor:'vendor'}}),save=await request(api,{body:{action:'save-binding',expectedVersion:null,text},token:initial.csrfToken})
    check('binding saves through native CAS create',save.ok&&save.binding.exists&&save.binding.version!==null)
    check('binding rejects stale CAS',(await request(api,{body:{action:'save-binding',expectedVersion:null,text},token:initial.csrfToken})).status===409)
    const comparison=await request(api,{body:{action:'diff'},token:initial.csrfToken}),plan=await request(api,{body:{action:'plan',domain:'ai-merge',operation:'compare'},token:initial.csrfToken})
    check('two XML exports produce a bounded local comparison',comparison.ok&&comparison.result.status==='local-comparison'&&comparison.result.objects.length===1&&comparison.result.objects[0].classification==='twice-changed'&&comparison.result.execution==='not-performed')
    check('local AI comparison plan makes no apply/deploy claim',plan.ok&&plan.result.execution==='local-plan-only'&&plan.result.objects.length===1&&plan.result.reason==='NO_MERGE_APPLY_IMPLEMENTED')
    report.localComparison={objects:comparison.result.objects.length,classification:comparison.result.objects[0].classification,execution:comparison.result.execution,planExecution:plan.result.execution}
    const bindingBefore=await readFile(join(onec.root,'.dsh/onec-specialized.json')),runnerBefore=await readFile(join(onec.root,initial.runnerTemplate.path))
    setSandboxMode(onec.agent.session,'read-only')
    check('native read-only denies binding changes',(await request(api,{body:{action:'save-binding',expectedVersion:save.binding.version,text},token:initial.csrfToken})).error==='SPECIALIZED_WORKSPACE_WRITE_REQUIRED')
    check('native read-only denies runner installation',(await request(api,{body:{action:'install-runner',expectedVersion:install.runnerTemplate.version},token:initial.csrfToken})).error==='SPECIALIZED_WORKSPACE_WRITE_REQUIRED')
    for(const action of ['install-runner','save-binding','plan'])check(`GET cannot mutate via ${action}`,(await request(api,{query:{action}})).status===405)
    check('denied operations preserve exact project bytes',bindingBefore.equals(await readFile(join(onec.root,'.dsh/onec-specialized.json')))&&runnerBefore.equals(await readFile(join(onec.root,initial.runnerTemplate.path))))
    for(const row of agents.slice(1))check(`${row.preset} cannot open specialized project API`,!(await request(api,{id:row.id})).ok)
    const workbench=await request('/airules/onec-workbench'),background=await request('/airules/onec-workbench',{query:{action:'configuration'}})
    check('native workbench starts with no graph jobs or reviewed MCP tools',workbench.ok&&!workbench.graph&&!workbench.jobs.length&&background.ok&&background.config.readOnlyTools.length===0)
    setSandboxMode(onec.agent.session,'workspace-write')
    report.sessionId=onec.id
    report.previewFixture=await persistPreviewFixture(ctx,onec)
    check('fixture session persists and appears in native workspace membership',report.previewFixture.persisted&&report.previewFixture.attached)
    check('no forbidden model MCP runner deploy or external request',report.modelRequestAttempts===0&&report.externalConnectionAttempts===0&&report.unexpectedTools.length===0&&report.nativeSubprocessAttempts===0)
    report.status='PASS';await writeFile(join(smoke,'specialized-release-summary.json'),JSON.stringify(report,null,2)+'\n')
    if(servePreview){
      clearTimeout(deadline)
      const {writeProtectedFile}=await import(pathToFileURL(join(installed,'airules-dsh-provider-extensions/lib/protected-file.js')))
      privatePreviewPath=join(smoke,'specialized-release-preview.private.json');stopPath=join(smoke,'specialized-release-preview.stop')
      await rm(stopPath,{force:true});writeProtectedFile(privatePreviewPath,{url:ctx.connection.authenticatedUrl(origin),sessionId:onec.id,pid:process.pid})
      process.stdout.write(JSON.stringify({status:'PREVIEW_READY',reportPath:join(smoke,'specialized-release-summary.json'),privatePreviewPath,checks:report.checks.length})+'\n')
      const end=Date.now()+previewTimeoutMs
      while(Date.now()<end){if(await access(stopPath).then(()=>true,()=>false))break;await tick(500)}
      check('preview did not invoke forbidden services',report.modelRequestAttempts===0&&report.externalConnectionAttempts===0&&report.nativeSubprocessAttempts===0&&report.unexpectedTools.length===0)
    }
    report.status='PASS';await writeFile(join(smoke,'specialized-release-summary.json'),JSON.stringify(report,null,2)+'\n')
    return{status:report.status,checks:report.checks.length,reportPath:join(smoke,'specialized-release-summary.json')}
  }catch(error){
    report.status='FAIL';report.error=/^[A-Z0-9_ :.-]+$/u.test(error.code??'')?error.code:'RELEASE_PROBE_ASSERTION_FAILED'
    await writeFile(join(smoke,'specialized-release-summary.json'),JSON.stringify(report,null,2)+'\n').catch(()=>{})
    await writeFile(join(smoke,'specialized-release-error.private.log'),String(error.stack??error),{mode:0o600}).catch(()=>{})
    throw Object.assign(new Error('SPECIALIZED_RELEASE_PROBE_FAILED'),{reportPath:join(smoke,'specialized-release-summary.json')})
  }finally{
    clearTimeout(deadline);if(privatePreviewPath)await rm(privatePreviewPath,{force:true});if(stopPath)await rm(stopPath,{force:true})
    try{await app?.ctx?.fiber.dispose()}finally{restoreNetwork()}
  }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const result=await runReleaseProbe(parseArguments(process.argv.slice(2)));process.stdout.write(JSON.stringify(result)+'\n');process.exit(0)}
  catch(error){process.stderr.write(JSON.stringify({status:'FAIL',code:error.message,reportPath:error.reportPath??null})+'\n');process.exit(1)}
}
