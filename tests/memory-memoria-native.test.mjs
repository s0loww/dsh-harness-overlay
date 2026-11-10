import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, symlink, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'

for (const [label,path] of [['rc5','var/asar-extract-rc5/dsh/node_modules'],['022','var/host-upgrade/rc022/asar/dsh/node_modules']]) {
  const sdk=resolve(path), native=join(sdk,'@deepseek-ai')
  const {Context}=await import(pathToFileURL(join(native,'cordis/lib/index.js')))
  const toolSdk=await import(pathToFileURL(join(native,'dsh-tools/lib/index.js'))),ToolsService=toolSdk.ToolsService??toolSdk.default,defineTool=toolSdk.defineTool
  const NativeToolExecutor=label==='022'?(await import(pathToFileURL(join(native,'dsh-tool-executor-native/lib/index.js')))).NativeToolExecutor:null
  const {createScope}=await import(pathToFileURL(join(native,'dsh-scope/lib/index.js')))
  async function fixture(t) {
    const root=await mkdtemp(join(tmpdir(),'airules-memoria-native-'))
    t.after(async()=>{const rel=relative(resolve(tmpdir()),root);assert.ok(!isAbsolute(rel)&&rel.startsWith('airules-memoria-native-'));await rm(root,{recursive:true,force:true})})
    await writeFile(join(root,'package.json'),'{"type":"module"}');await symlink(sdk,join(root,'node_modules'),'junction')
    await writeFile(join(root,'memoria.js'),await readFile('src/memory-workspace/lib/memoria.js'))
    await writeFile(join(root,'native-tools.js'),await readFile('src/native-tools-compat/'+(label==='022'?'rc022.js':'rc5.js')))
    const {createMemoriaAdapter}=await import(pathToFileURL(join(root,'memoria.js')))
    const {executeNativeTool}=await import(pathToFileURL(join(root,'native-tools.js')))
    const ctx=new Context();ctx.provide('systemPrompt',{tools(){},section(){return()=>{}},getSectionOrder(){return 0}})
    const service=ctx.plugin({inject:['systemPrompt'],apply(scope){new ToolsService(scope)}});await service.await()
    let owner
    const executor=ctx.plugin({inject:['tools'],apply(scope){owner=scope;if(NativeToolExecutor)scope.tools.setExecutor(new NativeToolExecutor(scope))}});await executor.await();assert.equal(executor.state,2)
    t.after(()=>ctx.fiber.dispose())
    const agent={id:'memoria-owner',session:{id:'memoria-owner'}}, childScope=createScope(owner,agent);agent.ctx=childScope.ctx
    const namespace='fixture-project',binding={namespace,search:{tool:'mcp__fixture_memory__search',scopeArgument:'project_id',queryArgument:'query'},remember:{tool:'mcp__fixture_memory__save',scopeArgument:'project_id',textArgument:'text'}}
    const output={schema:{type:'object',additionalProperties:true},render(_args,value){return[{type:'text',text:JSON.stringify(value)}]}}
    const register=(name,parameters,execute)=>owner.tools.register(defineTool({name,description:'Synthetic memory fixture',parameters,output,execute}))
    const invoke=(args={})=>executeNativeTool(owner,{name:'airules_memory_fixture',arguments:args,agent,callId:'outer-memory',signal:new AbortController().signal})
    return{ctx,owner,agent,childScope,binding,output,register,invoke,createMemoriaAdapter,namespace}
  }

  test(`actual ${label} typed memory adapter preserves native parent/root/agent and scoped lookup`,async t=>{
    const f=await fixture(t);let outer,child,received
    f.register(f.binding.search.tool,{project_id:{type:'string',required:true},query:{type:'string',required:true}},(args,exec)=>{child=exec;received=args;return{results:[{id:'row-one',text:'Fixture original source',project_id:f.namespace}]}})
    f.register('airules_memory_fixture',{},async(_args,exec)=>{outer=exec;return f.createMemoriaAdapter(f.owner,{binding:f.binding,execution:exec,verifyScope(){assert.equal(exec.agent,f.agent)}}).recall({query:'source'})})
    const result=await f.invoke()
    assert.equal(result.isError,false);assert.equal(result.value.backend,'memoria');assert.equal(result.value.results[0].source.recordId,'row-one')
    assert.deepEqual(received,{project_id:f.namespace,query:'source'});assert.equal(child.agent,f.agent);assert.equal(child.parent,outer.token);assert.equal(child.rootCallId,'outer-memory');assert.notEqual(child.token,outer.token)
    f.childScope.ctx.tools.guard(exec=>exec.name===f.binding.search.tool?'SCOPE_REVOKED':undefined)
    const denied=await f.invoke();assert.equal(denied.isError,true);assert.match(denied.content[0].text,/MEMORIA_REQUEST_FAILED/)
  })

  test(`actual ${label} native MCP approval and revocation remain authoritative; writes never claim success after denial`,async t=>{
    const f=await fixture(t);let writes=0,asked=0,disposer
    disposer=f.register(f.binding.remember.tool,{project_id:{type:'string',required:true},text:{type:'string',required:true}},()=>{writes++;return{id:'new-record',project_id:f.namespace}})
    f.register('airules_memory_fixture',{},async(_args,exec)=>f.createMemoriaAdapter(f.owner,{binding:f.binding,execution:exec,verifyScope(){}}).remember({text:'Reviewed synthetic note',operationId:'native-op'}))
    f.owner.on('tools/pre-execute',(exec,next)=>exec.name===f.binding.remember.tool?{kind:'ask',reason:'Explicit synthetic native memory permission'}:next())
    const approval={async request(input){assert.equal(input.agent,f.agent);asked++;return'rejected'}}
    f.ctx.provide('approval',approval)
    const denied=await f.invoke();assert.equal(denied.isError,false);assert.equal(denied.value.state,'outcome-unknown');assert.equal(writes,0);assert.equal(asked,1)
    approval.request=async()=>{asked++;disposer();return'allowed-once'}
    const revoked=await f.invoke();assert.equal(revoked.value.state,'outcome-unknown');assert.equal(writes,0);assert.equal(asked,2)
  })
}
