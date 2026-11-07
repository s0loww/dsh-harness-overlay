import test from'node:test'
import assert from'node:assert/strict'
import{readFile,mkdtemp,mkdir,writeFile,rm,symlink}from'node:fs/promises'
import{tmpdir}from'node:os'
import{join,resolve}from'node:path'
import{pathToFileURL}from'node:url'
import{runInNewContext}from'node:vm'
import{patchComposerHistory,verifyComposerHistoryCompatibility,COMPOSER_HOST_VERSION,COMPOSER_STAGED_CLIENT_SHA256,COMPOSER_HISTORICAL_CLIENT_SHA256}from'../src/composer-history-compat/patch.mjs'
import{evaluatePluginCompatibility}from'../var/asar-extract-rc5/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js'
import{Context}from'../var/asar-extract-rc5/dsh/node_modules/@deepseek-ai/cordis/lib/index.js'
const source=resolve(process.env.AIRULES_COMPOSER_SOURCE_ROOT??'dist/airules-ui-overlay-0.12.0-ui17/payload/packages/dsh-composer-history')
const original=await Promise.all(['package.json','lib/index.js','lib/client.js'].map(p=>readFile(join(source,p))))
const patched=patchComposerHistory(...original)
test('exact reviewed bytes only; rc5 own engine is narrow and original peers remain unchanged',()=>{
  const before=JSON.parse(original[0]),after=JSON.parse(patched.manifestBytes)
  assert.ok(evaluatePluginCompatibility(before,{},COMPOSER_HOST_VERSION));assert.equal(evaluatePluginCompatibility(after,{},COMPOSER_HOST_VERSION),undefined);assert.ok(evaluatePluginCompatibility(after,{},'0.2.1-rc.6'))
  assert.deepEqual(after.peerDependencies,before.peerDependencies);assert.deepEqual(after.engines,{...before.engines,dsh:COMPOSER_HOST_VERSION})
  assert.throws(()=>patchComposerHistory(...original,{hostVersion:'0.2.1-rc.6'}),/HOST_MISMATCH/)
  for(let n=0;n<3;n++){const bytes=[...original];bytes[n]=Buffer.concat([bytes[n],Buffer.from(' ')]);assert.throws(()=>patchComposerHistory(...bytes),/DRIFT/)}
  assert.doesNotMatch(patched.clientBytes.toString(),/binding\.session\.getSnapshot\(\)\.nodes/)
  assert.deepEqual(verifyComposerHistoryCompatibility(patched.manifestBytes,original[1],patched.clientBytes),patched.adaptation)
  assert.throws(()=>verifyComposerHistoryCompatibility(patched.manifestBytes,original[1],original[2]),/STAGED_CLIENT_DRIFT/)
})
test('workspace recall uses retained native Chat targets, activates cold views, never reads old Session.nodes or writes storage',()=>{
  let exported,capturedHost,storageWrites=0,activations=0,subscriptions=0
  const text=patched.clientBytes.toString().replace('function createComposerHistory(host, config) {','function createComposerHistory(host, config) { globalThis.captureHost(host);').replace('exports.Config = Config;','exports.testInstallWiring = installWiring; exports.Config = Config;')
  runInNewContext(text,{captureHost:host=>{capturedHost=host},window:{__ModuleLoader__:{load:module=>{exported=module.factory(()=>{throw new Error('UNEXPECTED_IMPORT')})}},addEventListener(){},removeEventListener(){}},setTimeout,clearTimeout})
  const snapshots={current:{legacy:{nodes:[]}},other:{legacy:{nodes:[{kind:'user',seq:1,content:[{type:'text',text:'Other retained input'}]}]}}},active=new Set(),bindings=Object.fromEntries(Object.keys(snapshots).map(id=>[id,{id,session:{getSnapshot(){throw new Error('OLD_SESSION_NODES_FORBIDDEN')}}}]))
  const sessions={list:{getSnapshot:()=>({ids:['current','other'],byId:{current:{id:'current',cwd:'project',retainedBy:{mainView:1}},other:{id:'other',cwd:'project'}}}),subscribe:()=>()=>{}},binding:id=>bindings[id],scope:id=>({id})}
  const ctx={get:()=>sessions,uiConversation:{binding:binding=>({target:name=>{assert.equal(name,'chat');return{getSnapshot:()=>active.has(binding.id)?snapshots[binding.id]:undefined,subscribe(){subscriptions++;active.add(binding.id);activations++;return()=>{subscriptions--}}}}})}}
  const options=exported.resolveConfig({historyScope:'workspace',persistHistory:false,enableSearch:false,enableInsights:false,showCompactionNotice:false,enableSnippets:false,enableTemplates:false})
  const dispose=exported.testInstallWiring(ctx,options,{setItem(){storageWrites++}})
  assert.deepEqual(Array.from(capturedHost.supplementalHistory()),['Other retained input']);assert.equal(activations,2);assert.equal(subscriptions,1);assert.equal(storageWrites,0);dispose();assert.equal(subscriptions,0)
})
test('actual native Cordis host mounts unchanged host entry after exact native compatibility admission',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'composer-host-compat-'));t.after(()=>rm(directory,{recursive:true,force:true}));await mkdir(join(directory,'plugin/lib'),{recursive:true});await symlink(resolve('var/asar-extract-rc5/dsh/node_modules'),join(directory,'node_modules'),'junction')
  await writeFile(join(directory,'plugin/package.json'),patched.manifestBytes);await writeFile(join(directory,'plugin/lib/index.js'),original[1])
  const module=await import(pathToFileURL(join(directory,'plugin/lib/index.js'))),ctx=new Context(),handle=ctx.plugin(module,{});await handle.await();assert.equal(handle.state,2);await handle.dispose()
})
test('actual native Cordis client apply works without the excluded donor projectPresetUi service',async()=>{
  function materialize(source){let module;runInNewContext(source,{window:{__ModuleLoader__:{load:row=>{module=row.factory(()=>{throw new Error('UNEXPECTED_IMPORT')})}},addEventListener(){},removeEventListener(){}},setTimeout,clearTimeout});return module}
  const boot=module=>{
    const ctx=new Context()
    ctx.provide('sessions',{list:{getSnapshot:()=>({ids:[],byId:{}}),subscribe:()=>()=>{}}})
    ctx.provide('configForms',{get:()=>({getSnapshot:()=>({value:undefined}),subscribe:()=>()=>{}})})
    for(const name of ['conversation','inputTriggers','uiConversation'])ctx.provide(name,{})
    return ctx.plugin(module,{enableSearch:false,enableInsights:false,showCompactionNotice:false})
  }
  // Reproduce the browser's original failure with real Cordis property guards.
  const oldClient=patched.clientBytes.toString().replace('scope.get?.("projectPresetUi") ||','scope.get?.("projectPresetUi") || scope.projectPresetUi ||')
  assert.throws(()=>verifyComposerHistoryCompatibility(patched.manifestBytes,original[1],Buffer.from(oldClient)),/STAGED_CLIENT_DRIFT/)
  const historical=verifyComposerHistoryCompatibility(patched.manifestBytes,original[1],Buffer.from(oldClient),{allowHistorical:true});assert.equal(historical.stagedClientSha256,COMPOSER_HISTORICAL_CLIENT_SHA256);assert.equal(patched.adaptation.stagedClientSha256,COMPOSER_STAGED_CLIENT_SHA256)
  assert.throws(()=>verifyComposerHistoryCompatibility(patched.manifestBytes,original[1],Buffer.from(oldClient+' '),{allowHistorical:true}),/STAGED_CLIENT_DRIFT/)
  const broken=boot(materialize(oldClient));await assert.rejects(broken.await(),/cannot get property "projectPresetUi" without inject/);assert.equal(broken.state,3);await broken.dispose()
  const module=materialize(patched.clientBytes.toString());assert.deepEqual(Array.from(module.inject),['conversation','sessions','inputTriggers','configForms','uiConversation'])
  const fixed=boot(module);await fixed.await();assert.equal(fixed.state,2);await fixed.dispose()
})
