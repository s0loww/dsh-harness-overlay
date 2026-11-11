import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { validatePolicy, effectivePolicy, selectBackends, createGlobalPolicyStore, createProjectPolicyStore } from '../src/memory-workspace/lib/policy.js'

test('project policy inherits recipient defaults while a project override is shared by every conversation',()=>{
  const global={schemaVersion:1,mode:'both',writeTarget:'auto'},project={schemaVersion:1,mode:'inherit',writeTarget:'inherit'}
  assert.deepEqual(effectivePolicy(global,project),{mode:'both',writeTarget:'auto',approval:'required',source:'global'})
  assert.deepEqual(effectivePolicy(global,{...project,mode:'memoria'}),{mode:'memoria',writeTarget:'auto',approval:'required',source:'project'})
  for(const session of ['one','two']){assert.equal(effectivePolicy(global,project).mode,'both');assert.equal(Object.hasOwn(effectivePolicy(global,project),session),false)}
  assert.throws(()=>validatePolicy({...global,sessionId:'one'}),/MEMORY_POLICY_INVALID/)
})
test('legacy policies require approval; global/project approval inherit independently from backend mode',()=>{
  const oldGlobal={schemaVersion:1,mode:'cognee',writeTarget:'auto'},oldProject={schemaVersion:1,mode:'inherit',writeTarget:'inherit'}
  assert.equal(validatePolicy(oldGlobal).approval,'required')
  assert.equal(validatePolicy(oldProject,{project:true}).approval,'inherit')
  assert.equal(effectivePolicy(oldGlobal,oldProject).approval,'required')
  assert.equal(effectivePolicy({...oldGlobal,approval:'disabled'},oldProject).approval,'disabled')
  assert.equal(effectivePolicy({...oldGlobal,approval:'disabled'},{...oldProject,approval:'required'}).approval,'required')
  assert.equal(effectivePolicy(oldGlobal,{...oldProject,approval:'disabled'}).approval,'disabled')
  for(const approval of [null,true,'never','ask','inherit'])assert.throws(()=>validatePolicy({...oldGlobal,approval}),/MEMORY_POLICY_INVALID/)
  for(const action of ['delete','remove','deleteDataset','forget','purge'])assert.throws(()=>selectBackends({mode:'cognee',writeTarget:'auto',approval:'disabled'},{action}),/MEMORY_ACTION_INVALID/)
})
test('approval policy saves use existing CAS and do not rewrite legacy files during read',async t=>{
  const root=await temporary(t,'airules-memory-approval-policy-'),file=join(root,'policy.json'),old='{"schemaVersion":1,"mode":"both","writeTarget":"auto"}'
  await writeFile(file,old)
  const store=createGlobalPolicyStore(file),before=await store.read()
  assert.equal(before.value.approval,'required');assert.equal(await readFile(file,'utf8'),old)
  const saved=await store.save({...before.value,approval:'disabled'},before.revision)
  assert.equal(saved.value.approval,'disabled')
  await assert.rejects(store.save({...saved.value,approval:'required'},before.revision),/MEMORY_POLICY_STALE/)
  assert.equal((await store.read()).value.approval,'disabled')
})

test('both selects independent read sources and explicit auto/write targets without overriding disabled memory',()=>{
  const both={mode:'both',writeTarget:'auto'}
  assert.deepEqual(selectBackends(both,{action:'recall'}),['memoria','cognee'])
  assert.deepEqual(selectBackends(both,{action:'remember',kind:'fact'}),['memoria'])
  assert.deepEqual(selectBackends(both,{action:'remember',kind:'document'}),['cognee'])
  assert.deepEqual(selectBackends({...both,writeTarget:'both'},{action:'remember'}),['memoria','cognee'])
  assert.deepEqual(selectBackends(both,{action:'graph'}),['cognee'])
  assert.throws(()=>selectBackends({...both,writeTarget:'memoria'},{action:'remember',backend:'cognee'}),/WRITE_TARGET_DISABLED/)
  assert.throws(()=>selectBackends({...both,writeTarget:'both'},{action:'remember',backend:'memoria'}),/WRITE_TARGET_DISABLED/)
  assert.deepEqual(selectBackends(both,{action:'remember',backend:'cognee'}),['cognee'])
  assert.throws(()=>selectBackends({mode:'memoria',writeTarget:'auto'},{action:'recall',backend:'cognee'}),/BACKEND_DISABLED/)
  assert.throws(()=>selectBackends({mode:'memoria',writeTarget:'both'},{action:'remember'}),/WRITE_TARGET_DISABLED/)
  assert.throws(()=>selectBackends({mode:'memoria',writeTarget:'auto'},{action:'graph'}),/BACKEND_DISABLED/)
})

test('preference schema rejects credentials, session ownership and unsafe namespace mappings',()=>{
  const base={schemaVersion:1,mode:'cognee',writeTarget:'auto'}
  for(const bad of [{...base,mode:'inherit'},{...base,token:'secret'},{...base,endpoint:'http://untrusted'},{...base,writeTarget:'memoria'}])assert.throws(()=>validatePolicy(bad),/MEMORY_/)
  assert.throws(()=>validatePolicy({...base,memoria:{namespace:'p',search:{tool:'shell',scopeArgument:'project',queryArgument:'q'}}},{project:true}),/MEMORIA_/)
  assert.throws(()=>validatePolicy({...base,memoria:{namespace:'p',search:{tool:'mcp__memory__search',scopeArgument:'constructor.x',queryArgument:'q'}}},{project:true}),/MEMORIA_/)
  assert.throws(()=>validatePolicy({...base,memoria:{namespace:'p',search:{tool:'mcp__memory__search',scopeArgument:'scope',queryArgument:'scope'}}},{project:true}),/MEMORIA_/)
})

async function temporary(t,prefix){const root=await mkdtemp(join(tmpdir(),prefix));t.after(async()=>{const rel=relative(resolve(tmpdir()),root);assert.ok(!isAbsolute(rel)&&rel.startsWith(prefix));await rm(root,{recursive:true,force:true})});return root}

test('global preference works without a chat and uses CAS/locks instead of last-writer overwrite',async t=>{
  const root=await temporary(t,'airules-global-memory-policy-'),path=join(root,'profile','policy.json'),first=createGlobalPolicyStore(path),second=createGlobalPolicyStore(path)
  const missing=await first.read();assert.equal(missing.revision,'missing')
  const results=await Promise.allSettled([first.save({schemaVersion:1,mode:'both',writeTarget:'auto'},'missing'),second.save({schemaVersion:1,mode:'memoria',writeTarget:'auto'},'missing')])
  assert.equal(results.filter(row=>row.status==='fulfilled').length,1)
  assert.match(results.find(row=>row.status==='rejected').reason.message,/MEMORY_POLICY_(?:BUSY|STALE)/)
  const after=await first.read();assert.notEqual(after.revision,'missing')
  await assert.rejects(first.save({schemaVersion:1,mode:'cognee',writeTarget:'auto'},'missing'),/MEMORY_POLICY_STALE/)
  assert.deepEqual((await first.read()).value,after.value)
})

test('global policy refuses symlink targets rather than modifying another owner',async t=>{
  const root=await temporary(t,'airules-global-memory-link-'),other=join(root,'other.json'),path=join(root,'policy.json')
  await writeFile(other,'{"private":"unchanged"}')
  await symlink(other,path,'file')
  const store=createGlobalPolicyStore(path)
  await assert.rejects(store.read(),/MEMORY_POLICY_FILE_INVALID/)
  await assert.rejects(store.save({schemaVersion:1,mode:'both',writeTarget:'auto'},'missing'),/MEMORY_POLICY_FILE_INVALID/)
  assert.equal(await readFile(other,'utf8'),'{"private":"unchanged"}')
})

test('actual SDK022 project preference uses native filesystem CAS, preserves scope and rejects symlinked policy directory',async t=>{
  const root=await temporary(t,'airules-project-memory-native-'),workspace=join(root,'workspace'),outside=join(root,'outside');await mkdir(workspace);await mkdir(outside)
  const native=resolve('var/host-upgrade/rc022/asar/dsh/node_modules/@deepseek-ai')
  const {Context}=await import(pathToFileURL(join(native,'cordis/lib/index.js'))),{SandboxedFileSystem}=await import(pathToFileURL(join(native,'dsh-fs-sandbox/lib/index.js')))
  const context=new Context(),policy={mode:'workspace-write',workspaceRoot:workspace,sessionId:'lead'};context.provide('sandboxPolicy',{defaultMode:'workspace-write',resolve:()=>policy})
  let fs
  const plugin=context.plugin({inject:['sandboxPolicy'],apply(ctx){fs=new SandboxedFileSystem(ctx,{cwd:workspace,diffBasisMaxBytes:10*1024*1024})}});await plugin.await();assert.equal(plugin.state,2);t.after(()=>context.fiber.dispose())
  const scope={root:workspace,writable:true,agent:{session:{header:{}}},policy};let active=true
  const store=createProjectPolicyStore({fsFor:()=>fs,verifyScope(_scope,signal){signal?.throwIfAborted();if(!active)throw Error('MEMORY_SCOPE_CHANGED')}})
  const missing=await store.read(scope);assert.equal(missing.revision,'missing')
  const saved=await store.save(scope,{schemaVersion:1,mode:'memoria',writeTarget:'auto'},'missing')
  assert.equal(saved.value.mode,'memoria');assert.equal(JSON.parse(await readFile(join(workspace,'.dsh','memory.json'),'utf8')).mode,'memoria')
  await assert.rejects(store.save(scope,{schemaVersion:1,mode:'cognee',writeTarget:'auto'},'missing'),/MEMORY_POLICY_STALE/)
  scope.writable=false;await assert.rejects(store.save(scope,saved.value,saved.revision),/MEMORY_WRITE_REQUIRED/);scope.writable=true
  scope.agent.session.header.origin='subagent';await assert.rejects(store.save(scope,saved.value,saved.revision),/MEMORY_WRITE_REQUIRED/);delete scope.agent.session.header.origin
  const originalWrite=fs.writeText.bind(fs)
  fs.writeText=async(...args)=>{await writeFile(join(workspace,'.dsh','memory.json'),'{"changed":"external owner"}');return originalWrite(...args)}
  await assert.rejects(store.save(scope,{schemaVersion:1,mode:'both',writeTarget:'auto'},saved.revision),/FS_CHANGED|VERSION|conflict|changed/i)
  assert.equal(await readFile(join(workspace,'.dsh','memory.json'),'utf8'),'{"changed":"external owner"}')
  fs.writeText=originalWrite;active=false;await assert.rejects(store.read(scope),/MEMORY_SCOPE_CHANGED/);active=true
  const resolved=join(workspace,'.dsh');assert.ok(relative(root,resolved).startsWith('workspace'));await rm(resolved,{recursive:true,force:true});await symlink(outside,resolved,'junction')
  await assert.rejects(store.read(scope),/MEMORY_PROJECT_LINK_REJECTED/)
})
