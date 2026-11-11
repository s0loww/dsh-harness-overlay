import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,writeFile,mkdir,symlink,link,rm} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {createServer} from 'node:http'
import {createConfigStore,validateConfig,DEFAULT_CONFIG,MODELS,phaseForEvent,DEFAULT_PHRASES,phrasesFor,choosePhrase} from '../src/live2d-companion/lib/core.js'
import {createController,API} from '../src/live2d-companion/lib/index.js'
async function fixture(t){const temp=await mkdtemp(join(tmpdir(),'airules-live2d-'));t.after(()=>rm(temp,{recursive:true,force:true}));return{temp,file:join(temp,'live2d/settings.json')}}
test('Live2D settings default off; enum, dimensions and privacy boundary are strict',()=>{
 assert.equal(DEFAULT_CONFIG.enabled,false);assert.deepEqual(Object.keys(MODELS),['Miara','Hiyori'])
 for(const patch of [{model:'Nicole'},{model:'../secret'},{height:159},{height:421},{height:NaN},{enabled:'true'},{corner:'top'},{showReasoning:true},{showComposer:true},{url:'https://external.test'}])assert.throws(()=>validateConfig({...DEFAULT_CONFIG,...patch}),/LIVE2D_CONFIG_INVALID/)
 assert.equal(validateConfig({model:'Hiyori'}).height,220)
})
test('configuration CAS persists both model choices, guards stale writes, and does not store a session identity',async t=>{
 const{file}=await fixture(t),store=createConfigStore(file),initial=store.read();assert.equal(initial.revision,'missing')
 const saved=store.save({...initial.config,model:'Hiyori',enabled:true},initial.revision);assert.equal(saved.config.model,'Hiyori');assert.notEqual(saved.revision,'missing');assert.deepEqual(store.read(),saved)
 assert.throws(()=>store.save({...saved.config,enabled:false},initial.revision),/STALE/);assert.equal(store.read().config.enabled,true);assert.equal((await readFile(file,'utf8')).includes('sessionId'),false)
 store.save({...saved.config,enabled:false},saved.revision);assert.equal(store.read().config.enabled,false)
})
test('configuration store rejects linked parents, hardlink files and oversized input',async t=>{
 const{temp,file}=await fixture(t),external=join(temp,'external');await mkdir(external);await symlink(external,join(temp,'live2d'),'junction');assert.throws(()=>createConfigStore(file).read(),/PATH_INVALID/)
 const home=join(temp,'normal');await mkdir(home);const target=join(home,'target');await writeFile(target,JSON.stringify(DEFAULT_CONFIG));const hard=join(home,'settings.json');await link(target,hard);assert.throws(()=>createConfigStore(hard).read(),/CONFIG_INVALID/)
 const huge=join(home,'huge.json');await writeFile(huge,' '.repeat(32769));assert.throws(()=>createConfigStore(huge).read(),/CONFIG_INVALID/)
})
test('native task bridge emits phase only and excludes child agents and arbitrary event bodies',()=>{
 const session={id:'lead-123',header:{}};assert.deepEqual(phaseForEvent(session,{type:'turn/start',data:{prompt:'private'}}),{sessionId:'lead-123',phase:'working'})
 assert.equal(phaseForEvent(session,{type:'assistant/message',data:{text:'secret'}}),null)
 assert.equal(phaseForEvent({...session,header:{origin:'subagent'}},{type:'turn/end'}),null)
 assert.equal(phaseForEvent({...session,header:{parentSessionId:'parent'}},{type:'turn/end'}),null)
 assert.deepEqual(phaseForEvent(session,{type:'turn/end',data:{reason:{kind:'error',error:'private'}}}),{sessionId:'lead-123',phase:'error'})
})
async function host(t){
 const{file}=await fixture(t);const controller=createController({connection:{requestRejection:request=>request.headers['x-test-native']==='yes'?undefined:{}}},createConfigStore(file));const server=createServer(controller.handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{controller.dispose();server.closeAllConnections();server.close()});const base='http://127.0.0.1:'+server.address().port
 const request=async(path,options={})=>{const response=await fetch(base+API+path,{...options,headers:{'x-test-native':'yes',...options.headers}});return{status:response.status,value:await response.json()}}
 return{controller,base,request}
}
test('native HTTP admission covers configuration and static assets; mutation requires CSRF and exact CAS',async t=>{
 const{base,request}=await host(t)
 for(const path of ['/configuration','/assets/vendor/pixi.min.js','/events?sessionId=test']){const response=await fetch(base+API+path);assert.equal(response.status,403)}
 const initial=await request('/configuration');assert.equal(initial.status,200);assert.equal(initial.value.config.enabled,false)
 const body=JSON.stringify({config:{...initial.value.config,enabled:true,model:'Hiyori'},expectedRevision:initial.value.revision})
 assert.equal((await request('/configuration',{method:'POST',headers:{'content-type':'application/json'},body})).status,403)
 const headers={'content-type':'application/json','x-airules-csrf':initial.value.csrfToken},saved=await request('/configuration',{method:'POST',headers,body});assert.equal(saved.status,200);assert.equal(saved.value.config.model,'Hiyori')
 assert.equal((await request('/configuration',{method:'POST',headers,body})).status,409)
 assert.equal((await request('/configuration',{method:'POST',headers,body:JSON.stringify({config:{...initial.value.config,model:'Nicole'},expectedRevision:saved.value.revision})})).value.error,'LIVE2D_CONFIG_INVALID')
 assert.equal((await request('/configuration',{method:'DELETE'})).status,405)
})
test('static asset closure resolves models, textures and motion files with native admission and blocks traversal',async t=>{
 const{base,request}=await host(t)
 for(const [name,path]of Object.entries(MODELS)){
  const response=await request('/assets/model/'+path);assert.equal(response.status,200)
  const refs=response.value.FileReferences,dir=path.slice(0,path.lastIndexOf('/')+1)
  for(const item of [refs.Moc,...refs.Textures,refs.Physics,...Object.values(refs.Motions).flat().map(row=>row.File)]){const result=await fetch(base+API+'/assets/model/'+dir+item,{headers:{'x-test-native':'yes'}});assert.equal(result.status,200,name+': '+item);assert.ok(Number(result.headers.get('content-length'))>0)}
 }
 for(const rel of ['vendor/pixi.min.js','vendor/live2dcubismcore.min.js','vendor/cubism4.min.js']){const response=await fetch(base+API+'/assets/'+rel,{headers:{'x-test-native':'yes'}});assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/javascript/)}
 for(const path of ['/assets/model/%2e%2e%5csecret','/assets/vendor/C:%5ctest','/assets/model/Miara/not-found.json','/assets/lib/index.js']){const response=await request(path);assert.notEqual(response.status,200)}
})
test('SSE is scoped to the selected chat and does not stream message, tool or provider content',async t=>{
 const{base,controller}=await host(t),abort=new AbortController(),response=await fetch(base+API+'/events?sessionId=lead-123',{headers:{'x-test-native':'yes'},signal:abort.signal});assert.equal(response.status,200)
 const reader=response.body.getReader(),decode=new TextDecoder();assert.match(decode.decode((await reader.read()).value),/"phase":"idle"/)
 controller.publish({id:'other',header:{}},{type:'turn/start',data:{prompt:'SECRET'}});controller.publish({id:'lead-123',header:{}},{type:'turn/end',data:{reason:{kind:'completed'},text:'SECRET'}})
 const frame=decode.decode((await reader.read()).value);assert.match(frame,/"phase":"complete"/);assert.equal(frame.includes('SECRET'),false);assert.equal(frame.includes('sessionId'),false);abort.abort();await reader.cancel().catch(()=>{})
})
test('client has no chat submission, cloud script, history or credential route and uses public native settings/session services',async()=>{
 const client=await readFile(new URL('../src/live2d-companion/lib/client.js',import.meta.url),'utf8')
 assert.match(client,/id:'airules-live2d-companion'/);assert.match(client,/inject:\['uiSession','slots'\]/);assert.match(client,/model\.motion/);assert.match(client,/app\.destroy/)
 for(const forbidden of ['sessionController.prompt','assistant-stream','showReasoning','/say','/cancel','https://cdn','credentials','innerHTML = text'])assert.equal(client.includes(forbidden),false,forbidden)
})

test('per-model custom phrases are isolated, fallback is exact, and choice avoids immediate repetition',()=>{
 const config=validateConfig({...DEFAULT_CONFIG,phrases:{Miara:{working:['Тихий путь к решению.','Ещё один шаг.']}}})
 assert.deepEqual(phrasesFor(config,'Miara','working'),['Тихий путь к решению.','Ещё один шаг.']);assert.deepEqual(phrasesFor(config,'Hiyori','working'),DEFAULT_PHRASES.Hiyori.working);assert.equal(choosePhrase(['a','b'],'a',()=>0),'b');assert.equal(choosePhrase(['a'],'a',()=>0),'a')
 assert.deepEqual(phrasesFor(validateConfig({...config,phrases:{Miara:{working:[]}}}),'Miara','working'),DEFAULT_PHRASES.Miara.working)
 for(const phrases of [{Nicole:{}},{Miara:{unknown:['a']}},{Miara:{idle:Array(13).fill('a')}},{Miara:{idle:['x'.repeat(241)]}},{Miara:{idle:['a\nb']}},{Miara:{idle:[' ']}},{Miara:[]},JSON.parse('{"__proto__":{}}')])assert.throws(()=>validateConfig({...DEFAULT_CONFIG,phrases}),/CONFIG_INVALID/)
 const huge={};for(const model of Object.keys(MODELS)){huge[model]={};for(const phase of Object.keys(DEFAULT_PHRASES[model]))huge[model][phase]=Array(12).fill('Я'.repeat(240))}assert.throws(()=>validateConfig({...DEFAULT_CONFIG,phrases:huge}),/CONFIG_INVALID/)
})

test('SDK022 actual approval audit and end reason vocabulary selects truthful task phases',()=>{
 const session={id:'native-lead',header:{}}
 const phase=event=>phaseForEvent(session,event)?.phase
 assert.equal(phase({type:'approval/asked',data:{reason:'PRIVATE'}}),'waiting')
 for(const outcome of ['allowed-once','rejected','unavailable'])assert.equal(phase({type:'approval/decided',data:{outcome}}),'working')
 assert.equal(phase({type:'approval/decided',data:{outcome:'cancelled'}}),'stopped')
 for(const kind of ['aborted','blocked','max-tokens','process-crash','future-unknown'])assert.equal(phase({type:'turn/end',data:{reason:{kind}}}),'stopped')
 assert.equal(phase({type:'turn/end',data:{reason:{kind:'error',error:{message:'PRIVATE'}}}}),'error')
 assert.equal(phase({type:'turn/end',data:{reason:{kind:'completed'}}}),'complete')
 assert.equal(phase({type:'turn/end',data:{}}),'stopped')
 for(const type of ['approval/request','turn/error','turn/cancel','agent/error'])assert.equal(phase({type}),undefined)
 assert.equal(phaseForEvent({id:'native-child',header:{parentSession:'parent'}},{type:'turn/start'}),null)
})

test('exact persisted UTF-8 budget rejects pretty-JSON overhead before commit and accepted boundary roundtrips',async t=>{
 const {file}=await fixture(t),store=createConfigStore(file);let boundary=null,overhead=null
 for(let size=1;size<=240;size++){const phrases={};for(const model of Object.keys(MODELS)){phrases[model]={};for(const phase of Object.keys(DEFAULT_PHRASES[model]))phrases[model][phase]=Array(12).fill('Я'.repeat(size))}const candidate={...DEFAULT_CONFIG,phrases},compact=Buffer.byteLength(JSON.stringify(candidate)),persisted=Buffer.byteLength(JSON.stringify(candidate,null,2)+'\n');if(persisted<=32768)boundary=candidate;else if(compact<=32768){overhead=candidate;break}}
 assert.ok(overhead);assert.ok(boundary);assert.throws(()=>store.save(overhead,'missing'),/CONFIG_INVALID/);assert.equal(store.read().revision,'missing')
 const saved=store.save(boundary,'missing');assert.ok((await readFile(file)).length<=32768);assert.deepEqual(store.read(),saved)
 assert.throws(()=>store.save(overhead,saved.revision),/CONFIG_INVALID/);assert.deepEqual(store.read(),saved)
})
