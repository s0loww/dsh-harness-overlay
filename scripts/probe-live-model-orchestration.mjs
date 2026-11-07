import { createHash, randomUUID } from 'node:crypto'
import { cp, mkdir, symlink, writeFile, readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, isAbsolute, relative, sep } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)))
const NATIVE = join(REPO, 'var/asar-extract-rc5/dsh/node_modules')
const DEFAULT_POLICY = join(REPO,'dist/airules-official-policy-0.12.0-dev39')
const mod = name => import(pathToFileURL(join(NATIVE, '@deepseek-ai', name, 'lib/index.js')))
export const MATRIX = Object.freeze([
  { id: 'deepseek-local', provider: 'deepseek-account', model: 'deepseek-flash', effort: 'high', mcp: false },
  { id: 'deepseek-mcp', provider: 'deepseek-account', model: 'deepseek-flash', effort: 'high', mcp: true },
  { id: 'openai-local', provider: 'codex', model: 'gpt-6.1-sol', effort: 'medium', mcp: false },
  { id: 'openai-mcp', provider: 'codex', model: 'gpt-6.1-sol', effort: 'medium', mcp: true },
])
export function validateRun({provider, model, effort, mcp, maxRequests = 24}) {
  if (!MATRIX.some(row => row.provider === provider && row.model === model && row.effort === effort && row.mcp === mcp)) throw new Error('EXACT_AUTHORIZED_MATRIX_REQUIRED')
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 24) throw new Error('MODEL_REQUEST_BUDGET_EXCEEDED')
  return true
}
export function publicModels(provider, models) {
  return models.map(model => ({provider, id: model.id, name: model.name, efforts: model.reasoning?.efforts?.map(item => item.id) ?? [], defaultEffort: model.reasoning?.defaultEffort}))
}

// Forward only installed dependency packages; no auth/profile/history bytes are copied.
// The plugin itself is loaded from maintained source, with the explicit host storage seam.
export async function loadSubscriptionPlugin(directory, dependencies = NATIVE, policyArtifactRoot = DEFAULT_POLICY) {
  const pkg = join(directory, 'subscription-plugin')
  await cp(join(REPO,'src/subscriptions'),pkg,{recursive:true})
  for (const name of ['@deepseek-ai/schemastery','@deepseek-ai/dsh-llm','@deepseek-ai/dsh-home-paths','@deepseek-ai/dsh-attachment','@deepseek-ai/dsh-tools']) {
    const destination = join(pkg,'node_modules',name)
    await mkdir(join(destination,'..'),{recursive:true})
    await symlink(join(dependencies,name),destination,'junction')
  }
  const undici = join(policyArtifactRoot,'payload/packages/airules-dsh-subscriptions/node_modules/undici')
  await symlink(undici,join(pkg,'node_modules/undici'),'junction')
  return import(pathToFileURL(join(pkg,'lib/index.js')))
}

export async function mountMetadataHost({directory, authStorePath, credentialsPath, policyArtifactRoot = DEFAULT_POLICY}) {
  if (![directory,authStorePath,credentialsPath].every(isAbsolute)) throw new Error('EXPLICIT_ABSOLUTE_STORAGE_PATHS_REQUIRED')
  const [{Context},{LlmRuntime},{LocalCredentialProvider},{AuthorizationService},{PlatformAccount},deepseek] = await Promise.all([
    mod('cordis'),mod('dsh-llm'),mod('dsh-credentials-local'),mod('dsh-authorization'),mod('dsh-deepseek-account-platform'),mod('dsh-llm-deepseek-account'),
  ])
  const ctx = new Context(), handles = []; let credentialProvider
  const mount = async (name, apply, inject = []) => {const handle = ctx.plugin({name,inject,apply(scope){apply(scope)}}); handles.push(handle);await handle.await()}
  await mount('acceptance-llm',scope=>new LlmRuntime(scope))
  await mount('acceptance-credentials',scope=>{credentialProvider=new LocalCredentialProvider(scope,{path:credentialsPath,watch:false})})
  await credentialProvider.loadInitial()
  await mount('acceptance-authorization',scope=>new AuthorizationService(scope),['credentials'])
  await mount('acceptance-deepseek-account',scope=>new PlatformAccount(scope),['credentials','authorization'])
  await mount('acceptance-deepseek-llm',scope=>deepseek.apply(scope,{}),['llm'])
  const subscription = await loadSubscriptionPlugin(directory, NATIVE, policyArtifactRoot)
  await mount('acceptance-openai',scope=>subscription.apply(scope,{providers:['codex'],pool:{enabled:false}}, {authStorePath}),['llm'])
  return {ctx,llm:ctx.llm,readiness:async()=>{
    const entries=await ctx.llm.registration('codex').adapter.options.tokens.list(true)
    return {openai:{present:entries.length>0, usable:entries.some(entry=>entry.session.enabled!==false&&entry.session.requiresLogin!==true), expirationAvailable:entries.some(entry=>Number.isFinite(entry.session.expiresAt))},deepseek:{present:!!(await ctx.deepseekAccount.resolveToken('https://api.deepseek.com'))}}
  },dispose:async()=>{for(const handle of handles.reverse())await handle.dispose()}}
}

async function removeMetadataDirectory(directory) {
  const rel=relative(resolve(tmpdir()),resolve(directory))
  if(isAbsolute(rel)||rel==='..'||rel.startsWith(`..${sep}`)||!rel.startsWith('airules-live-metadata-')) throw new Error('TEMP_CLEANUP_BOUNDARY_REQUIRED')
  await rm(directory,{recursive:true,force:true})
}


const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const within = (root,path) => {const rel=relative(resolve(root),resolve(path));return !isAbsolute(rel)&&rel!=='..'&&!rel.startsWith(`..${sep}`)}
export const DOC_TOOL = 'mcp__1C-docs-mcp__docinfo'
export const DOC_ARGS = Object.freeze({name:'\u041c\u0430\u0441\u0441\u0438\u0432.\u041d\u0430\u0439\u0442\u0438',top_k:1,max_items:1,max_chars:3000,detail_level:'compact'})
export function createGuard({runRoot,target,mcp,parentId=()=>undefined,observations=[]}) {
  const allowed=new Set(['read','edit','write','skill','airules_rule','airules_role','airules_capabilities','airules_delegate','bsl_analyze','structured_output'])
  if(mcp)allowed.add(DOC_TOOL)
  const rejected = (exec,reason) => {observations.push({agentId:exec.agent?.id,name:exec.name,denied:reason});return reason}
  return exec=>{
    if(!allowed.has(exec.name))return rejected(exec,'LIVE_TOOL_DENIED')
    if(exec.name===DOC_TOOL && JSON.stringify(Object.fromEntries(Object.entries(exec.arguments??{}).sort()))!==JSON.stringify(Object.fromEntries(Object.entries(DOC_ARGS).sort())))return rejected(exec,'LIVE_DOC_ARGUMENTS_DENIED')
    if(exec.name==='airules_delegate' && (!['developer','tester'].includes(exec.arguments?.role)||exec.agent?.id!==parentId()))return rejected(exec,'LIVE_DELEGATION_DENIED')
    if(exec.name==='airules_delegate' && exec.arguments.cwd!==undefined&&resolve(exec.arguments.cwd)!==resolve(runRoot))return rejected(exec,'LIVE_DELEGATION_CWD_DENIED')
    if(['read','edit','write'].includes(exec.name)) {
      const path=exec.arguments?.file_path
      if(typeof path!=='string')return rejected(exec,'LIVE_PATH_REQUIRED')
      const absolute=resolve(runRoot,path)
      if(absolute!==resolve(target)&&!within(join(runRoot,'artifacts'),absolute))return rejected(exec,'LIVE_PATH_DENIED')
      if(exec.agent?.id===parentId()&&absolute===resolve(target)&&exec.name!=='read')return rejected(exec,'PARENT_SOURCE_WRITE_DENIED')
      if(/\\\\|\?\?\\|GLOBALROOT|:[^\\/]/i.test(path.replace(/^[A-Za-z]:/,'')))return rejected(exec,'LIVE_PATH_NAMESPACE_DENIED')
    }
  }
}

export function evaluateLiveReport(report) {
  const children=report.children??[], developer=children.filter(row=>row.role==='developer'), tester=children.filter(row=>row.role==='tester')
  const matching=child=>child.local===true&&child.stopReason==='completed'&&child.request?.provider===report.route.provider&&child.request?.model===report.route.model&&child.request?.effort===report.route.effort&&child.policy?.mode==='workspace-write'&&child.policy?.workspaceMatches===true
  const successful=(id,name,module=false)=>report.tools.some(tool=>tool.agentId===id&&tool.name===name&&tool.success&&(!module||tool.targetModule))
  const required={originalUnchanged:report.originalUnchanged===true,exactCommentChanges:report.exactCommentChanges===true,
    diagnostics:report.before?.diagnostics===3&&report.after?.diagnostics===1&&(report.after.codes.SpaceAtStartComment??0)===0&&report.before.codes.MissingReturnedValueDescription===report.after.codes.MissingReturnedValueDescription,
    nativeChildren:children.length===2&&developer.length===1&&tester.length===1&&children.every(matching),
    pipelineOrder:developer.length===1&&tester.length===1&&Number.isInteger(developer[0].endedOrder)&&tester[0].startedOrder>developer[0].endedOrder,
    roleWriteBoundaries:!report.tools.some(tool=>tool.success&&tool.targetModule&&['edit','write'].includes(tool.name)&&(tool.agentId===report.parentId||tester.some(child=>child.id===tool.agentId))),
    developerWorked:developer.length===1&&successful(developer[0].id,'read',true)&&(successful(developer[0].id,'edit',true)||successful(developer[0].id,'write',true)),
    testerReadAndLint:tester.length===1&&successful(tester[0].id,'read',true)&&successful(tester[0].id,'bsl_analyze')&&report.lint.some(row=>row.agentId===tester[0].id&&row.sourceSha256===report.finalSourceSha256&&row.diagnostics===1&&(row.codes.SpaceAtStartComment??0)===0),
    parentRoute:report.parentRequest?.provider===report.route.provider&&report.parentRequest?.model===report.route.model&&report.parentRequest?.effort===report.route.effort,
    handoff:report.handoffVerified===true,
    realMcp:report.route.mcp?successful(report.parentId,DOC_TOOL)&&children.some(child=>successful(child.id,DOC_TOOL)):report.mcpRegistered===0&&!report.tools.some(tool=>tool.name.startsWith('mcp__')),
    bounded:report.modelRequests>0&&report.modelRequests<=24, noDeploy:report.deployments===0,
  }
  const functional=Object.entries(required).filter(([name])=>name!=='exactCommentChanges').every(([,passed])=>passed)
  return {status:Object.values(required).every(Boolean)?'PASS':functional&&report.semanticCommentChanges===true&&report.encodingDelta==='bom-removed'?'PARTIAL':'FAIL',checks:required,projectCorrectness:'NOT_CERTIFIED',realDeploy:'NOT_RUN'}
}

async function registerBoundedLint(host,{candidate,runRoot,binary,report}) {
  const base=join(candidate,'home/profiles/desktop/node_modules/airules-dsh-workflows')
  const [{createNativeProcessAdapter},{loadRuntime},{scrubbedParentEnv},{classifyRunnerFailure,matchesSignature},{defineTool}]=await Promise.all([
    import(pathToFileURL(join(base,'lib/native-process.js'))),import(pathToFileURL(join(base,'lib/runtime.js'))),mod('dsh-subprocess'),mod('dsh-sandbox'),mod('dsh-tools'),
  ])
  const core=await loadRuntime();let counter=0
  async function analyze(agent,signal) {
    const phase=`lint-${counter++}`, output=join(runRoot,'artifacts',phase);await mkdir(output)
    const warnings={bslLexerWarning:false,jvmCompatibilityWarning:false};let tail=''
    const ctx={sandboxPolicy:host.ctx.sandboxPolicy,sandbox:host.ctx.sandbox,subprocess:{spawn(options){
      const handle=host.ctx.subprocess.spawn(options)
      handle.stderr.on('data',data=>{const text=tail+Buffer.from(data).toString('utf8');warnings.bslLexerWarning ||= /token recognition error|syntax error/i.test(text);warnings.jvmCompatibilityWarning ||= /terminally deprecated|restricted method|sun\.misc\.Unsafe/i.test(text);tail=text.slice(-128)})
      return handle
    }}}
    const adapter=createNativeProcessAdapter({ctx,agent,callId:`live-lint-${randomUUID()}`,id:'acceptance.bsl',core,nativeHelpers:{scrubbedParentEnv,classifyRunnerFailure,matchesSignature},operations:{analyze:{
      command:binary,args:()=>['analyze','-s',join(runRoot,'src'),'-r','json','-o',output],inputSchema:{type:'object',properties:{},additionalProperties:false},effects:['startsProcess','readsSource','writesFilesystem'],validator:'process-exit',
    }}})
    const result=await adapter.execute('analyze',{}, {cwd:runRoot,timeoutMs:60000,runId:'live-acceptance',stepId:phase,artifactDir:output,signal})
    if(result.data.exitCode!==0||!result.data.terminationConfirmed||result.data.startError)throw new Error('NATIVE_BSL_PROCESS_FAILED')
    const {summarizeLint}=await import('./probe-project-orchestration.mjs')
    const summary=summarizeLint(JSON.parse(await readFile(join(output,'bsl-json.json'),'utf8')))
    const entry={agentId:agent.id,...summary,warnings,sourceSha256:digest(await readFile(report.target)),nativeProcess:true}
    report.lint.push(entry)
    return entry
  }
  host.ctx.tools.register(defineTool({name:'bsl_analyze',description:'Run the installed local BSL Language Server on the single copied acceptance module. Returns real diagnostics; no MCP, database or deploy.',parameters:{},
    output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},execute(_args,exec){return analyze(exec.agent,exec.signal)}}))
  return analyze
}

function acceptancePrompt(source,mcp) {
  return `Perform bounded native orchestration acceptance. Workspace ${source.workspace}; sole source module ${source.moduleRelative}. Original project outside workspace is forbidden. No shell, deploy, database, COM, external messaging or internet.
1. Parent MUST call airules_delegate(role="developer",task=...). Developer MUST read the copied module and fix ONLY two comment markers //+ to // + and //- to // -. Preserve all other bytes and business logic. Exactly one developer.
2. After the developer ACTUALLY completes, parent MUST call airules_delegate(role="tester",task=...). Tester MUST personally read the copied file from disk using read and call bsl_analyze. Confirm actual diagnostics: SpaceAtStartComment removed, MissingReturnedValueDescription retained. Tester must not edit. Exactly one tester; no other children. Both roles inherit current model and effort. Do not manually emulate children.
${mcp?'Parent and at least one child MUST each actually call '+DOC_TOOL+' with EXACT arguments '+JSON.stringify(DOC_ARGS)+'. This is read-only reference documentation; local lint is still mandatory.':'MCP is absent. Do not connect or use MCP.'}
3. Wait for both real child results. Write artifacts/handoff.md with a brief honest report: actual checks, retained diagnostic, project business correctness NOT CERTIFIED, deploy NOT RUN. Include exact markers PROJECT_CORRECTNESS: NOT_CERTIFIED and DEPLOY: NOT_RUN and the retained diagnostic code MissingReturnedValueDescription. Keep final answer brief. Never claim success before tester results. Do not load additional skills/rules unless necessary. At most 2 roles, one 340-byte copied source.`
}

function parse(argv) {
  const options = {}
  for(let index=0;index<argv.length;index+=2) {
    if(!['--metadata-only','--auth-store','--credentials-store','--output','--run','--candidate-root','--project-root','--source-relative','--bsl-ls','--mcp-config','--policy-artifact','--ui-artifact'].includes(argv[index]) || !argv[index+1]) throw new Error('EXPLICIT_PROBE_ARGUMENTS_REQUIRED')
    options[argv[index].slice(2)] = argv[index+1]
  }
  return options
}
export async function main(argv=process.argv.slice(2)) {
  const options=parse(argv)
  if(options['metadata-only']==='true')return metadataMain(options)
  const route=MATRIX.find(row=>row.id===options.run);if(!route)throw new Error('EXACT_AUTHORIZED_MATRIX_REQUIRED');validateRun(route)
  const policyArtifactRoot=resolve(options['policy-artifact']??DEFAULT_POLICY),uiArtifactRoot=resolve(options['ui-artifact']??join(REPO,'dist/airules-ui-overlay-0.1.0-dev16'))
  const candidate=resolve(options['candidate-root']),runRoot=join(REPO,'var/live-model-acceptance',`${route.id}-${randomUUID()}`)
  // This executable handles one row per fresh process. Home identity is fixed before native imports.
  process.env.DSH_HOME=join(candidate,'home');process.env.DSH_AGENTS_HOME=join(candidate,'home-agents');process.env.DSH_TELEMETRY_DISABLED='1'
  process.chdir(candidate)
  const {snapshotSource,assertOriginalUnchanged}=await import('./probe-project-orchestration.mjs')
  await mkdir(join(REPO,'var/live-model-acceptance'),{recursive:true})
  const source=await snapshotSource(options['project-root'],options['source-relative'],runRoot)
  if(route.mcp){const policyPath=join(runRoot,'AGENTS.md'), policy=await readFile(policyPath,'utf8');await writeFile(policyPath,policy.replace('No database, MCP, COM,', 'No database, COM,')+'\nOnly authorized MCP: direct 1C-docs-mcp docinfo with exact arguments '+JSON.stringify(DOC_ARGS)+'. Read-only documentation; parent and at least one child must each invoke it. No other MCP.\n')}
  const report={schemaVersion:1,route,parentId:null,target:source.target,source:{bytes:source.sourceBytes,sha256:source.sourceHash,relative:source.sourceRelative},tools:[],children:[],lint:[],denials:[],modelRequests:0,deployments:0,mcpRegistered:0,startedAt:new Date().toISOString()}
  let host, parentId, eventOrder=0;const children=new Map(),pendingCalls=new Map(),requests=new Map(),policies=new Map(),started=Date.now()
  const guard=createGuard({runRoot,target:source.target,mcp:route.mcp,parentId:()=>parentId,observations:report.denials})
  const onEvent=(name,data)=>{
    if(name==='agent/created'){policies.set(data.agentId,{mode:data.policy.mode,workspaceMatches:resolve(data.policy.workspaceRoot)===resolve(runRoot)});return}
    if(name==='tools/result')return
    if(name==='request'){report.modelRequests=data.requestNumber;process.stdout.write(`Live request ${data.requestNumber}: ${data.provider}/${data.model}/${data.effort}\n`);return}
    if(name==='subagent/start'){children.set(data.id,{...(children.get(data.id)??{}),id:data.id,runId:data.runId,local:data.local,startedOrder:++eventOrder});return}
    if(name==='subagent/end'){Object.assign(children.get(data.id)??{}, {stopReason:data.stopReason,endedOrder:++eventOrder});return}
    if(name==='agent/error')report.agentErrors=(report.agentErrors??0)+1
    if(name==='session/event'){
      const {event,sessionId}=data
      if(event.type==='tool/call')pendingCalls.set(event.data.callId??event.data.id??event.data.message?.callId,{agentId:sessionId,name:event.data.name})
      if(['assistant/message','assistant/attempt'].includes(event.type)&&event.data.usage){
        report.usage??={}
        for(const key of ['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens','reasoningTokens'])if(Number.isFinite(event.data.usage[key]))report.usage[key]=(report.usage[key]??0)+event.data.usage[key]
      }
      if(event.type==='request/header'){
        const config=event.data.config??event.data.header?.config
        if(config)requests.set(sessionId,{provider:config.provider,model:config.model,effort:config.reasoningEffort})
      }
    }
  }
  let timer
  try {
    let mcpConfig
    if(route.mcp){
      const raw=JSON.parse(await readFile(resolve(options['mcp-config']),'utf8')).mcpServers?.['1C-docs-mcp']
      if(!raw||typeof raw.url!=='string')throw new Error('APPROVED_DOCS_CONFIG_REQUIRED')
      mcpConfig={serverName:'1C-docs-mcp',transport:'streamable-http',url:raw.url,headers:raw.headers??{}}
    }
    const {bootNativeHost}=await import('./live-native-host.mjs')
    host=await bootNativeHost({candidateRoot:candidate,runRoot,authStorePath:options['auth-store'],credentialsPath:options['credentials-store'],provider:route.provider,model:route.model,effort:route.effort,guard,mcpConfig,onEvent,maxRequests:24,policyArtifactRoot,uiArtifactRoot})
    report.runtimeProof=host.runtimeProof
    parentId=report.parentId=host.agent.id
    report.mcpRegistered=host.ctx.tools.schemas(host.agent).filter(tool=>tool.name.startsWith('mcp__')).length
    if(!route.mcp&&report.mcpRegistered!==0)throw new Error('MCP_MUST_BE_ABSENT')
    host.ctx.on('tools/execute',async(exec,next)=>{
      const result=await next();report.tools.push({agentId:exec.agent?.id,name:exec.name,success:!result.isError,targetModule:typeof exec.arguments?.file_path==='string'&&resolve(runRoot,exec.arguments.file_path)===resolve(source.target)})
      if(exec.name==='airules_delegate'&&!result.isError&&result.value?.childId){const child=children.get(result.value.childId)??{id:result.value.childId};child.role=exec.arguments.role;children.set(child.id,child)}
      return result
    },{global:true})
    const restrictAgent=subject=>{const keep=['read','edit','write','airules_delegate','bsl_analyze','airules_rule','airules_role','airules_capabilities',...(route.mcp?[DOC_TOOL]:[])];const known=host.ctx.tools.view(subject).restrictableNames;subject.ctx.tools.restrict({allow:keep.filter(name=>known.has(name))})}
    host.ctx.on('agent/created',({agent:child})=>restrictAgent(child),{global:true})
    const analyze=await registerBoundedLint(host,{candidate,runRoot,binary:resolve(options['bsl-ls']),report})
    restrictAgent(host.agent)
    report.before=await analyze(host.agent,new AbortController().signal)
    timer=setTimeout(()=>{for(const agent of host.ctx.agents.list())agent.cancel({kind:'user'});report.timedOut=true},600000)
    await host.run(acceptancePrompt(source,route.mcp))
    clearTimeout(timer)
    report.after=await analyze(host.agent,new AbortController().signal)
    const original=await readFile(source.original,'utf8'),changed=await readFile(source.target,'utf8')
    report.originalUnchanged=await assertOriginalUnchanged(source)
    report.finalSourceSha256=digest(await readFile(source.target))
    const parentConfig=host.agent.session.requestHeader()?.config;report.parentRequest=parentConfig?{provider:parentConfig.provider,model:parentConfig.model,effort:parentConfig.reasoningEffort}:undefined
    const handoff=await readFile(join(runRoot,'artifacts/handoff.md'),'utf8').catch(()=>'');report.handoffVerified=handoff.includes('MissingReturnedValueDescription')&&handoff.includes('NOT_CERTIFIED')&&handoff.includes('NOT_RUN')
    report.encoding={originalHasBom:original.startsWith('\uFEFF'),finalHasBom:changed.startsWith('\uFEFF')}
    report.outputBytes=(await readFile(source.target)).length
    const expected=original.replace('//+','// +').replace('//-','// -')
    report.exactCommentChanges=changed===expected
    report.semanticCommentChanges=changed.replace(/^\uFEFF/,'')===expected.replace(/^\uFEFF/,'')
    report.encodingDelta=original.startsWith('\uFEFF')&&!changed.startsWith('\uFEFF')?'bom-removed':'none'
    for(const child of children.values()){
      const actual=host.ctx.agents.get(child.id),config=actual?.session.requestHeader()?.config
      child.request=config?{provider:config.provider,model:config.model,effort:config.reasoningEffort}:requests.get(child.id)
      child.policy=policies.get(child.id)
      if(actual) {const policy=host.ctx.sandboxPolicy.resolve({session:actual.session});child.policy={mode:policy.mode,workspaceMatches:resolve(policy.workspaceRoot)===resolve(runRoot)}}
    }
    report.children=[...children.values()]
    report.acceptance=evaluateLiveReport(report)
  } catch(error){report.failure={name:error.name,code:/^[A-Z_]+$/.test(error.message)?error.message:'LIVE_RUNTIME_ERROR'};report.acceptance={status:'FAIL'};report.originalUnchanged=await assertOriginalUnchanged(source).catch(()=>false)}
  finally {
    clearTimeout(timer);report.elapsedMs=Date.now()-started;delete report.target
    await writeFile(join(runRoot,'summary.json'),JSON.stringify(report,null,2)+'\n');await host?.dispose()
  }
  process.stdout.write(JSON.stringify({run:route.id,status:report.acceptance.status,modelRequests:report.modelRequests,report:join(runRoot,'summary.json')})+'\n')
  return report
}
async function metadataMain(options) {
  const directory=await mkdtemp(join(tmpdir(),'airules-live-metadata-'))
  process.env.DSH_HOME=join(directory,'home');process.env.DSH_AGENTS_HOME=join(directory,'home-agents');process.env.DSH_TELEMETRY_DISABLED='1'
  let host
  try {
    host=await mountMetadataHost({directory,authStorePath:options['auth-store'],credentialsPath:options['credentials-store'],policyArtifactRoot:resolve(options['policy-artifact']??DEFAULT_POLICY)})
    const readiness=await host.readiness(),result=[]
    for(const provider of ['codex','deepseek-account']) {
      const models=await host.llm.listModels(provider)
      const selected=models.filter(model=>provider==='codex'?model.id==='gpt-6.1-sol':model.id==='deepseek-flash')
      for(const model of selected)result.push(...publicModels(provider,[await host.llm.resolveModelInfo(provider,model.id)]))
    }
    await writeFile(resolve(options.output),JSON.stringify({mode:'metadata-only',modelRequests:0,readiness,models:result},null,2)+'\n')
    process.stdout.write(JSON.stringify(result)+'\n')
  } finally {await host?.dispose();await removeMetadataDirectory(directory)}
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) main().catch(()=>{process.stderr.write('Probe failed before report; no secret/error payload emitted.\n');process.exitCode=1})
