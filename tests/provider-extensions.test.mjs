import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp,writeFile,readFile,rm,mkdir,readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join,resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { validateDriver,verifyDriver,isolatedEnvironment,makeProfile,publishProfile,detachMuseHome } from '../src/provider-extensions/lib/runtime.js'
import { createDriverController } from '../src/provider-extensions/lib/controller.js'
import { museAccount,googleLogin } from '../src/provider-extensions/lib/auth.js'
import { createDriverHandler } from '../src/provider-extensions/lib/control.js'

const tick=()=>new Promise(resolve=>setImmediate(resolve))
async function fixture(authOverrides={}){
  const home=await mkdtemp(join(tmpdir(),'airules-provider-test-')), published=new Map(), calls=[]
  const config={command:join(home,'runtime.exe'),sha256:'a'.repeat(64),args:[]}
  const controller=createDriverController({home,node:process.execPath,launcher:resolve('src/provider-extensions/lib/launch.mjs'),
    write(path,value){return writeFileSyncFixture(path,value)},verify:async value=>validateDriver(value),environment:async(directory,id)=>isolatedEnvironment(directory,id,{}),
    enabled:spec=>published.has(spec.profile),publish:async(spec,profile)=>{calls.push([spec.id,profile]);if(profile)published.set(spec.profile,profile);else published.delete(spec.profile)},
    auth:{async googleLogin(options){calls.push(['login',options]);return {connected:true}},async googleStatus(){return {connected:true}},async googleLogout(){calls.push(['logout'])},async museAccount(){return {connected:true,models:[{id:'muse-1',name:'Muse 1'}]}},...authOverrides},
  })
  function writeFileSyncFixture(path,value){writeFileSync(path,JSON.stringify(value))}
  const {writeFileSync}=await import('node:fs')
  return {home,config,controller,published,calls,async cleanup(){await controller.close();await rm(home,{recursive:true,force:true})}}
}
const get=async(f,id='google')=>(await f.controller.snapshot()).providers.find(row=>row.id===id)
const configure=(f,id='google')=>f.controller.action({action:'configure',provider:id,config:f.config})

test('driver verification rejects shells, relative executable, bad args and mismatched digest',async()=>{
  const home=await mkdtemp(join(tmpdir(),'airules-driver-digest-'))
  try {
    const command=join(home,'runtime.exe'),content='fixture-not-a-runtime';await writeFile(command,content)
    const config={command,sha256:createHash('sha256').update(content).digest('hex'),args:[]}
    assert.equal((await verifyDriver(config)).command,command)
    await assert.rejects(verifyDriver({...config,sha256:'0'.repeat(64)}),/DIGEST_MISMATCH/)
    assert.throws(()=>validateDriver({...config,command:'runtime'}),/EXECUTABLE_REQUIRED/)
    assert.throws(()=>validateDriver({...config,command:join(home,'cmd.exe')}),/EXECUTABLE_REQUIRED/)
    assert.throws(()=>validateDriver({...config,args:['bad\0arg']}),/ARGUMENTS_INVALID/)
    assert.throws(()=>validateDriver({...config,token:'hidden'}),/CONFIG_INVALID/)
  }finally{await rm(home,{recursive:true,force:true})}
})

test('isolated runtime environment imports no external credentials, home or proxy secrets',()=>{
  const home=resolve('fixture-home'),env=isolatedEnvironment(home,'muse',{PATH:'safe',OPENAI_API_KEY:'foreign',META_API_KEY:'foreign',GOOGLE_APPLICATION_CREDENTIALS:'foreign',HOME:'foreign',HTTPS_PROXY:'secret-proxy'})
  assert.equal(env.PATH,'safe');assert.equal(env.META_API_KEY,undefined);assert.equal(env.OPENAI_API_KEY,undefined);assert.equal(env.GOOGLE_APPLICATION_CREDENTIALS,undefined);assert.equal(env.HTTPS_PROXY,undefined)
  assert.equal(env.HOME,join(home,'home'));assert.equal(env.MUSE_NO_AUTO_UPDATE,'1')
  assert.equal(isolatedEnvironment(home,'google',{}).GEMINI_HOME,home)
})

test('publishing reuses exactly one native ACP registry and preserves unrelated settings',async()=>{
  const entry={options:{name:'@zaimokuza/dsh-acp-adapter'}},original={agents:{existing:{name:'old'}},custom:1}
  let updated;const editor={entries:()=>[entry],async edit(found,change){assert.equal(found,entry);updated=change(original)}}
  const profile=makeProfile('google',{node:process.execPath,launcher:resolve('launch.mjs'),manifest:resolve('manifest.json')})
  await publishProfile(editor,{profile:'airules-google'},profile)
  assert.deepEqual(updated.agents.existing,original.agents.existing);assert.equal(updated.toolApprovalDefault,'ask');assert.equal(updated.custom,1)
  assert.deepEqual(original,{agents:{existing:{name:'old'}},custom:1})
  await assert.rejects(publishProfile({...editor,entries:()=>[]},{profile:'airules-google'},profile),/REGISTRY_REQUIRED/)
})

test('provider setup never replaces an explicitly chosen global ACP approval policy',async()=>{
  const entry={options:{name:'@zaimokuza/dsh-acp-adapter'}},profile={name:'fixture'}
  // The pinned public adapter currently accepts auto/ask. Preserve any explicit
  // value here; validation of its supported values belongs to native ConfigEditor.
  for(const policy of ['auto','ask','deny']){
    const original={agents:{unrelated:{name:'Existing'}},toolApprovalDefault:policy};let updated
    await publishProfile({entries:()=>[entry],async edit(found,change){updated=change(original)}},{profile:'airules-google'},profile)
    assert.equal(updated.toolApprovalDefault,policy);assert.equal(updated.agents.unrelated,original.agents.unrelated)
    assert.equal(original.agents['airules-google'],undefined)
  }
})

test('cold start and GET never launch CLI, login, import accounts or enable a profile',async()=>{
  const f=await fixture();try{const snapshot=await f.controller.snapshot();assert.equal(f.calls.length,0);assert.ok(snapshot.providers.every(row=>!row.configured&&!row.connected&&!row.enabled))}finally{await f.cleanup()}
})

test('configured runtimes explicitly login/check/enable through native profile; only own profile is disabled',async()=>{
  const f=await fixture();try{
    await configure(f);assert.equal((await get(f)).configured,true);assert.equal((await get(f)).enabled,false)
    await f.controller.action({action:'login',provider:'google'});await tick()
    assert.equal((await get(f)).connected,true)
    await f.controller.action({action:'enable',provider:'google'})
    const profile=f.published.get('airules-google');assert.equal(profile.command,process.execPath);assert.equal(profile.env.ELECTRON_RUN_AS_NODE,'1')
    assert.ok(profile.args.includes(join(f.home,'google.json')))
    await f.controller.action({action:'disable',provider:'google'});assert.equal(f.published.size,0)
    await configure(f,'muse');await f.controller.action({action:'check',provider:'muse'});assert.equal((await get(f,'muse')).modelCount,1)
  }finally{await f.cleanup()}
})

test('cancel discards late successful login, unknown actions and foreign fields fail closed',async()=>{
  let finish;const f=await fixture({googleLogin:()=>new Promise(resolve=>{finish=resolve})});try{
    await configure(f)
    await assert.rejects(f.controller.action({action:'enable',provider:'unknown'}),/REJECTED/)
    await assert.rejects(f.controller.action({action:'import',provider:'google'}),/REJECTED/)
    await assert.rejects(f.controller.action({action:'login',provider:'google',source:'foreign-cli'}),/REJECTED/)
    await f.controller.action({action:'login',provider:'google'});await tick();await f.controller.action({action:'cancel',provider:'google'});finish({connected:true});await tick()
    assert.equal((await get(f)).phase,'idle');assert.equal((await get(f)).connected,false)
  }finally{await f.cleanup()}
})

test('untrusted OAuth links never reach browser UI and failure details stay redacted',async()=>{
  const f=await fixture({async googleLogin({notify}){notify({url:'https://evil.invalid/?secret=fixture'})}})
  try{await configure(f);await f.controller.action({action:'login',provider:'google'});await tick();const state=await get(f);assert.equal(state.error,'DRIVER_AUTH_FAILED');assert.equal(state.notice,undefined);assert.doesNotMatch(JSON.stringify(state),/evil.invalid|secret=fixture/)}finally{await f.cleanup()}
})

test('actual generation wrapper verifies executable and strips inherited key/Electron flag before fixture launch',async()=>{
  const home=await mkdtemp(join(tmpdir(),'airules-wrapper-test-'))
  try {
    const hash=createHash('sha256');for await(const chunk of createReadStream(process.execPath))hash.update(chunk)
    const manifest=join(home,'google.json'),launcher=resolve('src/provider-extensions/lib/launch.mjs')
    await writeFile(manifest,JSON.stringify({id:'google',config:{command:process.execPath,sha256:hash.digest('hex'),args:['-e',"process.stdout.write(JSON.stringify({key:!!process.env.OPENAI_API_KEY,electron:!!process.env.ELECTRON_RUN_AS_NODE,home:process.env.HOME}))"]}}))
    const child=spawn(process.execPath,[launcher,'--manifest',manifest],{env:{...process.env,OPENAI_API_KEY:'fixture-foreign-key',ELECTRON_RUN_AS_NODE:'1'},windowsHide:true,stdio:['pipe','pipe','pipe']})
    let output='',error='';child.stdout.on('data',value=>output+=value);child.stderr.on('data',value=>error+=value)
    const code=await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{child.kill();reject(new Error('WRAPPER_FIXTURE_TIMEOUT'))},10000);child.on('error',reject);child.on('exit',code=>{clearTimeout(timeout);resolve(code)})})
    assert.equal(code,0,error);assert.deepEqual(JSON.parse(output),{key:false,electron:false,home:join(home,'google','home')})
  }finally{await rm(home,{recursive:true,force:true})}
})

test('Muse local disconnect detaches only the owned home and never guesses a logout RPC',async()=>{
  const home=await mkdtemp(join(tmpdir(),'airules-detach-test-'))
  try {
    await mkdir(join(home,'muse'));await mkdir(join(home,'google'))
    await writeFile(join(home,'muse','own-auth-fixture'),'fixture')
    await writeFile(join(home,'google','other-auth-fixture'),'preserved')
    await detachMuseHome(home)
    await assert.rejects(readFile(join(home,'muse','own-auth-fixture')),/ENOENT/)
    assert.equal(await readFile(join(home,'google','other-auth-fixture'),'utf8'),'preserved')
    const backup=(await readdir(home)).find(name=>name.startsWith('muse-disconnected-'));assert.ok(backup)
    assert.equal(await readFile(join(home,backup,'own-auth-fixture'),'utf8'),'fixture')
  }finally{await rm(home,{recursive:true,force:true})}
})

test('Muse MSP uses explicit runtime, isolated env, official request methods and closes on completion',async()=>{
  const calls=[],notifications=[];let closed=0
  const connection={onNotification(fn){notifications.push(fn)},async request(method,params){calls.push([method,params]);if(method==='account/loginStart'){queueMicrotask(()=>notifications.forEach(fn=>fn({method:'account/loginCompleted',params:{outcome:'granted'}})));return {verificationUrl:'https://auth.meta.com/device',userCode:'AB'}}if(method==='account/read')return {state:'accountLogin'};if(method==='model/list')return {models:[{modelId:'muse',displayLabel:'Muse'}]}}}
  const result=await museAccount({config:{command:resolve('muse.exe')},env:{HOME:resolve('own-home')},notify:value=>calls.push(['notify',value]),load:async spec=>{assert.equal(spec,'@muse-code/sdk');return {spawnMspConnection(options){assert.deepEqual(options.args,['serve','--provider','meta','--no-session-log','--disable-write','--disable-shell']);return {initialize:async()=>({connection}),exited:new Promise(()=>{}),close:async()=>closed++}}}}})
  assert.equal(result.connected,true);assert.deepEqual(result.models,[{id:'muse',name:'Muse'}]);assert.equal(closed,1)
  assert.deepEqual(calls.filter(c=>!['notify'].includes(c[0])).map(c=>c[0]),['account/loginStart','account/read','model/list'])
})

test('Google login injects explicit pinned connection factory so runtime does not use managed auto-setup',async()=>{
  let options,closed=false
  class Connection{constructor(value){options=value}}
  class Runtime{constructor(factory){factory({cwd:'fixture'})}async loginGoogle(signal,progress,manual){manual.showAuthorizationUrl('https://accounts.google.com/auth')}async close(){closed=true}}
  const config={command:resolve('google.exe'),args:['--acp']},env={HOME:resolve('isolated')},urls=[]
  assert.equal((await googleLogin({config,env,notify:value=>urls.push(value.url),load:async spec=>spec.endsWith('/runtime.js')?{AntigravityRuntime:Runtime}:{AntigravityAcpConnection:Connection}})).connected,true)
  assert.equal(options.command,config.command);assert.equal(options.env,env);assert.deepEqual(options.args,['--acp']);assert.equal(closed,true);assert.equal(urls.length,1)
})

test('driver HTTP route refuses foreign admission/CSRF and never reflects raw SDK errors',async()=>{
  const handler=createDriverHandler({snapshot:async()=>({providers:[]}),action:async()=>{throw new Error('sdk private-token-value')}},{token:'csrf',connection:{requestRejection:req=>req.admitted?undefined:'deny'}})
  async function call(method,body='',csrf='',admitted=true){const request=Readable.from(body?[body]:[]);Object.assign(request,{method,admitted,headers:{'x-dsh-csrf':csrf,'content-type':'application/json'}});let status,output;await handler(request,{writeHead(code){status=code},end(value){output=JSON.parse(value)}});return {status,output}}
  assert.equal((await call('GET','','',false)).status,403);assert.equal((await call('POST','{}')).status,403)
  const failed=await call('POST','{}','csrf');assert.equal(failed.output.error,'DRIVER_OPERATION_FAILED');assert.doesNotMatch(JSON.stringify(failed),/private-token-value/)
  assert.equal((await call('POST','x'.repeat(12289),'csrf')).status,400)
})

test('driver UI provides explicit cold setup and disables launch while unknown',()=>{
  let exported;const React={createElement:(type,props,...children)=>({type,props,children}),useState:value=>[value,()=>{}],useRef:value=>({current:value}),useCallback:value=>value,useEffect(){}}
  runInNewContext(readFileSync(new URL('../src/provider-extensions/lib/client.js',import.meta.url),'utf8'),{window:{__ModuleLoader__:{load(module){exported=module.factory(()=>React)}}}})
  const tree=exported.DriverSettings({providerId:'muse'}),nodes=[];function visit(node){if(!node||typeof node!=='object')return;nodes.push(node);node.children?.flat().forEach(visit)}visit(tree)
  assert.equal(nodes.find(n=>n.props?.role==='status').children[0],'Статус неизвестен')
  assert.equal(nodes.find(n=>n.type==='button'&&n.children[0]==='Включить ACP').props.disabled,true)
  assert.equal(exported.DRIVER_PROVIDERS.length,2)
})
