import test from 'node:test'
import assert from 'node:assert/strict'
import{readFile,mkdtemp,mkdir,writeFile,symlink,rm}from'node:fs/promises'
import{resolve,join}from'node:path'
import{tmpdir}from'node:os'
import{pathToFileURL}from'node:url'
import vm from'node:vm'
import{patchSettingsShell}from'../src/settings-shell/patch.mjs'
import{patchNativeModelsClient,patchNativeAccountClient}from'../src/providers-settings/patch-native.mjs'
import{patchComposerHistory,verifyComposerHistoryCompatibility}from'../src/composer-history-compat/patch.mjs'
import{patchOnecLspManifest,verifyOnecLspCompatibility}from'../src/onec-lsp-compat/patch.mjs'
import{directoryState}from'../installer/fs-state.mjs'
import{validateUiOverlayManifest}from'../src/ui-overlay/contracts.mjs'
const sdk=resolve(process.env.AIRULES_HOST022_MODULES??'var/host-upgrade/rc022/asar/dsh/node_modules'),options={hostVersion:'0.2.2-rc.1'}
const {Context}=await import(pathToFileURL(join(sdk,'@deepseek-ai/cordis/lib/index.js')))
const {evaluatePluginCompatibility}=await import(pathToFileURL(join(sdk,'@deepseek-ai/dsh-app-boot/lib/index.js')))
const native=async name=>readFile(join(sdk,'@deepseek-ai/dsh-client-ui-settings-'+name,'lib/client.js'),'utf8')
const composerRoot=resolve('dist/airules-ui-overlay-0.12.0-ui17/payload/packages/dsh-composer-history')
const composer=await Promise.all(['package.json','lib/index.js','lib/client.js'].map(path=>readFile(join(composerRoot,path))))
const result=patchComposerHistory(...composer,options)
function materialize(source){let module;vm.runInNewContext(source,{window:{__ModuleLoader__:{load:row=>{module=row.factory(()=>{throw Error('UNEXPECTED_IMPORT')})}},addEventListener(){},removeEventListener(){}},setTimeout,clearTimeout});return module}

test('actual022 general/models/account exact native bytes patch and compile; source drift and wrong host rejected',async()=>{
 for(const[name,patch]of[['general',patchSettingsShell],['models',patchNativeModelsClient],['account',patchNativeAccountClient]]){
  const source=await native(name),output=patch(source,options);new vm.Script(output)
  assert.throws(()=>patch(source),/MISMATCH|BASELINE_CHANGED/);assert.throws(()=>patch(source+' ',options),/MISMATCH|BASELINE_CHANGED/)
 }
 const locks=JSON.parse(await readFile('upstream/native-ui-compat-0.2.2-rc.1.lock.json'))
 for(const[name,hash]of Object.entries(locks))assert.equal((await directoryState(join(sdk,name))).digest,hash)
})

test('account bridge follows native account/watch grant and clears on revoke',async()=>{
 const source=patchNativeAccountClient(await native('account'),options)
 assert.equal((source.match(/ctx\.remoteAccess\.whenAccess\("account\/watch"/g)||[]).length,( (await native('account')).match(/ctx\.remoteAccess\.whenAccess\("account\/watch"/g)||[]).length+1)
 const begin=source.indexOf('ctx.remoteAccess.whenAccess("account/watch", () => {\n                const airulesCurrentFace'),end=source.indexOf('\n\t\t\tctx.remoteAccess.whenAccess',begin)
 let grant,face,notifications=0
 const state='let airulesProvidersFace;const airulesProvidersListeners=new Set([()=>notify()]);'
 vm.runInNewContext(state+source.slice(begin,end)+'\nglobalThis.read=()=>airulesProvidersFace;',{operations:{id:'synthetic'},notify(){notifications++},ctx:{remoteAccess:{whenAccess(_permission,fn){grant=fn}}},set read(value){face=value}})
 assert.equal(face(),undefined);const revoke=grant();assert.equal(face().id,'synthetic');assert.equal(notifications,1);revoke();assert.equal(face(),undefined);assert.equal(notifications,2)
})

test('composer exact022 admission and actual022 Cordis client lifecycle preserve optional-service guards',async()=>{
 const pkg=JSON.parse(result.manifestBytes)
 assert.equal(evaluatePluginCompatibility(pkg,{},options.hostVersion),undefined)
 assert.ok(evaluatePluginCompatibility(pkg,{},'0.2.2-rc.2'))
 assert.deepEqual(result.adaptation,verifyComposerHistoryCompatibility(result.manifestBytes,composer[1],result.clientBytes,options))
 assert.throws(()=>verifyComposerHistoryCompatibility(result.manifestBytes,composer[1],result.clientBytes),/DRIFT/)
 assert.throws(()=>verifyComposerHistoryCompatibility(result.manifestBytes,composer[1],result.clientBytes,{...options,allowHistorical:true}),/HISTORICAL_HOST/)
 const ctx=new Context()
 ctx.provide('sessions',{list:{getSnapshot:()=>({ids:[],byId:{}}),subscribe:()=>()=>{}}})
 ctx.provide('configForms',{get:()=>({getSnapshot:()=>({value:undefined}),subscribe:()=>()=>{}})})
 for(const name of ['conversation','inputTriggers','uiConversation'])ctx.provide(name,{})
 const fiber=ctx.plugin(materialize(result.clientBytes.toString()),{enableSearch:false,enableInsights:false,showCompactionNotice:false});await fiber.await();assert.equal(fiber.state,2);await fiber.dispose()
 const conversation=await readFile(join(sdk,'@deepseek-ai/dsh-client-ui-conversation/lib/client.js'),'utf8'),chat=await readFile(join(sdk,'@deepseek-ai/dsh-client-ui-chat/lib/client.js'),'utf8')
 assert.match(conversation,/binding\(source\) \{/);assert.match(conversation,/source\.sessionId/);assert.match(chat,/legacy[\s\S]{0,150}nodes/)
})

test('composer unchanged host entry mounts in actual022 Cordis with isolated modules',async t=>{
 const root=await mkdtemp(join(tmpdir(),'airules-composer022-'));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(join(root,'plugin/lib'),{recursive:true});await symlink(sdk,join(root,'node_modules'),'junction');await writeFile(join(root,'plugin/package.json'),result.manifestBytes);await writeFile(join(root,'plugin/lib/index.js'),composer[1]);const entry=await import(pathToFileURL(join(root,'plugin/lib/index.js')));const fiber=new Context().plugin(entry,{});await fiber.await();assert.equal(fiber.state,2);await fiber.dispose()
})

test('LSP exact022 native admission remains narrow and verifier returns matching evidence',async()=>{
 const root=resolve('E:/DSH-Desktop-1C-0.1.0-20261103-134539-win-x64/DSH-Desktop-1C-0.1.0/dsh-1c-bundle/node_modules/dsh-lsp-actions')
 const [manifest,entry]=await Promise.all(['package.json','lib/index.js'].map(p=>readFile(join(root,p))))
 const patched=patchOnecLspManifest(manifest,entry,options)
 assert.equal(patched.adaptation.hostVersion,options.hostVersion);assert.match(patched.adaptation.contract,/rc022/)
 assert.deepEqual(verifyOnecLspCompatibility(patched.manifestBytes,entry,options),patched.adaptation)
 assert.equal(evaluatePluginCompatibility(JSON.parse(patched.manifestBytes),{},options.hostVersion),undefined)
 assert.ok(evaluatePluginCompatibility(JSON.parse(patched.manifestBytes),{},'0.2.2-rc.2'))
})

test('actual staged022 UI preserves donor origin and exact new native provenance',async()=>{
 const root='dist/airules-ui-overlay-0.13.0-host022-ui5',manifest=JSON.parse(await readFile(join(root,'ui-overlay-manifest.json'))),inventory=JSON.parse(await readFile('src/ui-overlay/ui-component-inventory.json'))
 validateUiOverlayManifest(manifest,inventory);assert.deepEqual(manifest.target.hostVersions,['0.2.2-rc.1']);assert.equal(manifest.sourceRelease.releaseId,inventory.source.releaseId)
 const broken=structuredClone(manifest);broken.packageProvenance.find(r=>r.name.endsWith('settings-general')).hostVersion='0.2.1-rc.5';assert.throws(()=>validateUiOverlayManifest(broken,inventory),/NATIVE_PROVENANCE/)
 for(const name of ['general','models','account']){const pkg=JSON.parse(await readFile(join(root,'payload/packages/@deepseek-ai/dsh-client-ui-settings-'+name,'package.json')));assert.equal(pkg.version,'0.2.2-rc.1')}
})


test('staged022 storage closure and RU peer use new native versions',async()=>{
 const root='dist/airules-ui-overlay-0.13.0-host022-ui5',locks=JSON.parse(await readFile('upstream/native-ui-runtime-0.2.2-rc.1.lock.json'))
 for(const[name,row]of Object.entries(locks)){
  const source=join(sdk,name),target=join(root,'payload/packages',name)
  assert.equal((await directoryState(source)).digest,row.digest)
  const pkg=JSON.parse(await readFile(join(target,'package.json')));assert.equal(pkg.version,row.version)
 }
 const ru=JSON.parse(await readFile(join(root,'payload/packages/airules-dsh-russian-localization/package.json')))
 assert.equal(ru.peerDependencies['@deepseek-ai/dsh-client-locale'],'0.2.2-rc.1')
 assert.equal(evaluatePluginCompatibility(ru,{},options.hostVersion),undefined)
 const storage=JSON.parse(await readFile(join(root,'payload/packages/@deepseek-ai/dsh-storage-domain/package.json')))
 assert.equal(evaluatePluginCompatibility(storage,{},options.hostVersion),undefined)
})

test('RU overlay retains native Russian catalog entry and disposes only its own dictionaries',async()=>{
 const source=await readFile('dist/airules-ui-overlay-0.13.0-host022-ui5/payload/packages/airules-dsh-russian-localization/lib/client.js','utf8')
 let plugin;vm.runInNewContext(source,{window:{__ModuleLoader__:{load:row=>{plugin=row.factory(()=>{throw Error('UNEXPECTED_IMPORT')})}}}})
 let dictionaryCount=0,disposed=0,dispose
 plugin.apply({locale:{getSnapshot:()=>({locales:[{id:'en'},{id:'ru'}]}),addLanguage(){throw Error('NATIVE_LANGUAGE_MUST_REMAIN')},register(){dictionaryCount++;return()=>disposed++}},effect(fn){dispose=fn()}})
 assert.ok(dictionaryCount>20);assert.equal(disposed,0);dispose();assert.equal(disposed,dictionaryCount)
})

test('real022 LocaleRuntime native Russian namespaces and retained donor dictionaries coexist',async()=>{
 let nativePlugin,ruPlugin
 const loader=(source,requires)=>{let plugin;vm.runInNewContext(source,{window:{__ModuleLoader__:{load:row=>{plugin=row.factory(id=>requires[id]??{})}}},navigator:{languages:['ru'],language:'ru'}});return plugin}
 nativePlugin=loader(await readFile(join(sdk,'@deepseek-ai/dsh-client-locale/lib/client.js'),'utf8'),{})
 let locale
 const stop=Error('NATIVE_DICTIONARIES_REGISTERED')
 await assert.rejects(nativePlugin.apply({emit(){},effect(fn){return fn()},configForms:{get(){}},provide(name,value){assert.equal(name,'locale');locale=value},slots:{installLocale(){throw stop}}}),error=>error===stop)
 assert.ok(locale.getSnapshot().locales.some(x=>x.id==='ru'))
 const themePlugin=loader(await readFile(join(sdk,'@deepseek-ai/dsh-client-ui-theme/lib/client.js'),'utf8'),{})
 const themeStop=Error('NATIVE_THEME_DICTIONARY_REGISTERED')
 assert.throws(()=>themePlugin.apply({locale,effect(fn,label){if(label==='ui-theme: settings row dictionaries'){fn();throw themeStop}}}),error=>error===themeStop)
 const nativeTheme=JSON.stringify(locale.dicts.get('settings.theme').get('ru'))
 const nativeCommon=JSON.stringify(locale.dicts.get(nativePlugin.COMMON_NS).get('ru'))
 const nativeSettings=JSON.stringify(locale.dicts.get(nativePlugin.SETTINGS_NS).get('ru'))
 const nativeSource=await readFile(join(sdk,'@deepseek-ai/dsh-client-locale/lib/client.js'),'utf8')
 const nativeNamespaces=new Set()
 // Populate actual namespace identifiers from the new SDK. The Runtime itself
 // enforces duplicate registration and proves the overlay preserves native data.
 const {readdir}=await import('node:fs/promises')
 for(const row of await readdir(join(sdk,'@deepseek-ai'),{withFileTypes:true})){
   if(!row.isDirectory())continue
   let source;try{source=await readFile(join(sdk,'@deepseek-ai',row.name,'lib/client.js'),'utf8')}catch(error){if(error.code==='ENOENT')continue;throw error}
   for(const m of source.matchAll(/(?:locale\.register|ctx\.locale\.register)\("([^"]+)"/g))nativeNamespaces.add(m[1])
 }
 for(const namespace of nativeNamespaces)locale.register(namespace,'ru',{sentinel:'native'})
 locale.setLocale('ru')
 ruPlugin=loader(await readFile('dist/airules-ui-overlay-0.13.0-host022-ui5/payload/packages/airules-dsh-russian-localization/lib/client.js','utf8'),{})
 let dispose;ruPlugin.apply({locale,effect(fn){dispose=fn()}})
 assert.ok(nativeNamespaces.size>5)
 for(const namespace of nativeNamespaces)assert.equal(locale.translate(namespace,'sentinel'),'native')
 assert.equal(JSON.stringify(locale.dicts.get('settings.theme').get('ru')),nativeTheme)
 assert.equal(JSON.stringify(locale.dicts.get(nativePlugin.COMMON_NS).get('ru')),nativeCommon)
 assert.equal(JSON.stringify(locale.dicts.get(nativePlugin.SETTINGS_NS).get('ru')),nativeSettings)
 assert.ok(locale.getSnapshot().locales.some(x=>x.id==='ru'));dispose()
 for(const namespace of nativeNamespaces)assert.equal(locale.translate(namespace,'sentinel'),'native')
 assert.ok(locale.getSnapshot().locales.some(x=>x.id==='ru'))
})


test('actual staged RU payload never claims the native settings.theme namespace',async()=>{
 const source=await readFile('dist/airules-ui-overlay-0.13.0-host022-ui5/payload/packages/airules-dsh-russian-localization/lib/client.js','utf8')
 const line=source.split('\n').find(line=>line.includes('const payload = ')),payload=JSON.parse(line.slice(line.indexOf('= ')+2).trim().replace(/;$/,''))
 assert.equal(Object.hasOwn(payload.namespaces,'settings.theme'),false)
})
