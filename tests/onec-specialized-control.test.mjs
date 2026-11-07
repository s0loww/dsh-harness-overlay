import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve, isAbsolute, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { specializedHandler } from '../src/onec-specialized/lib/control.js'
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'airules-specialized-http-'));t.after(async()=>{const rel=relative(resolve(tmpdir()),root);assert.ok(!isAbsolute(rel)&&rel.startsWith('airules-specialized-http-'));await rm(root,{recursive:true,force:true})})
  const agent={id:'owner',status:'idle',ctx:{},session:{id:'owner',header:{id:'owner',cwd:root}},followup(message){agent.message=message}},policy={mode:'workspace-write',workspaceRoot:root},calls=[]
  const fs={resolve:async path=>({displayPath:path,targetKey:path}),stat:async target=>{try{const bytes=await readFile(target.targetKey);return {type:'file',size:bytes.length,version:hash(bytes)}}catch(error){if(error.code==='ENOENT')return undefined;throw error}},readBytes:async target=>readFile(target.targetKey),writeText:async(target,content,expected,_signal,current)=>{assert.equal(current.mode,'workspace-write');const before=await fs.stat(target);if(expected.kind==='replaceIfVersion'&&before?.version!==expected.version)throw Object.assign(new Error('stale'),{code:'FS_STALE_VERSION'});if(expected.kind==='createIfAbsent'&&before)throw new Error('unexpected overwrite');await mkdir(dirname(target.targetKey),{recursive:true});await writeFile(target.targetKey,content)}}
  const ctx={fs,connection:{requestRejection:()=>undefined},agents:{get:id=>id===agent.id?agent:undefined},agentPresets:{composedPreset:()=> '1c-airules'},sandboxPolicy:{resolve:()=>policy},airulesOnecSpecialized:{machineConfigView:{trustedRunnerDigests:[]},async act(args,exec){assert.equal(exec.agent,agent);calls.push(args);return args.action==='status'?{domains:[]}:args.action==='validatePlan'?{valid:true}:{planDigest:'a'.repeat(64),execution:'configured'}}}}
  const handler=specializedHandler(ctx,{createUserMessage:value=>value})
  async function request(method,input={},token){let code,body;const req=Readable.from(method==='POST'?[JSON.stringify(input)]:[]);Object.assign(req,{method,url:`/?${new URLSearchParams(input)}`,headers:token?{'x-airules-csrf':token}:{}});await handler(req,{writeHead(value){code=value},end(value){body=JSON.parse(value)}});return {code,body}}
  return {root,agent,policy,ctx,calls,request}
}
test('specialized UI rejects GET mutations and unauthenticated or unprotected POST before side effects',async t=>{
  const f=await fixture(t)
  for(const action of ['save-binding','run-in-chat','plan','cancel']){assert.equal((await f.request('GET',{sessionId:'owner',action})).code,405)}
  assert.equal(f.calls.length,0);assert.equal(f.agent.message,undefined)
  assert.equal((await f.request('POST',{sessionId:'owner',action:'save-binding'})).code,403)
  f.ctx.connection.requestRejection=()=> 'denied'
  assert.equal((await f.request('GET',{sessionId:'owner'})).code,403)
})
test('binding save uses native per-call policy, preserves BOM/CRLF and rejects a stale version',async t=>{
  const f=await fixture(t);await mkdir(join(f.root,'.dsh'));await writeFile(join(f.root,'.dsh/onec-specialized.json'),'\uFEFF{\r\n  "schemaVersion": 1\r\n}\r\n')
  const first=await f.request('GET',{sessionId:'owner'});assert.equal(first.code,200)
  const saved=await f.request('POST',{sessionId:'owner',action:'save-binding',text:'{"schemaVersion":1,"repository":{"allowForce":false}}',expectedVersion:first.body.binding.version},first.body.csrfToken)
  assert.equal(saved.code,200)
  const result=await readFile(join(f.root,'.dsh/onec-specialized.json'),'utf8');assert.ok(result.startsWith('\uFEFF'));assert.ok(result.includes('\r\n'))
  assert.equal((await f.request('POST',{sessionId:'owner',action:'save-binding',text:'{"schemaVersion":1}',expectedVersion:first.body.binding.version},first.body.csrfToken)).code,409)
  f.policy.mode='read-only'
  assert.equal((await f.request('POST',{sessionId:'owner',action:'save-binding',text:'{"schemaVersion":1}',expectedVersion:saved.body.binding.version},saved.body.csrfToken)).body.error,'SPECIALIZED_WORKSPACE_WRITE_REQUIRED')
})
test('run-in-chat validates owned plan and submits a user message, never forges a runner approval',async t=>{
  const f=await fixture(t),first=await f.request('GET',{sessionId:'owner'})
  const queued=await f.request('POST',{sessionId:'owner',action:'run-in-chat',planDigest:'a'.repeat(64)},first.body.csrfToken)
  assert.equal(queued.code,200);assert.equal(queued.body.submitted,true)
  assert.equal(f.calls.filter(row=>row.action==='run').length,0)
  assert.equal(f.calls.filter(row=>row.action==='validatePlan').length,1)
  assert.match(f.agent.message.content[0].text,/airules_onec_specialized/)
  f.agent.status='running'
  assert.equal((await f.request('POST',{sessionId:'owner',action:'run-in-chat',planDigest:'a'.repeat(64)},first.body.csrfToken)).body.error,'SPECIALIZED_CHAT_BUSY')
  assert.equal((await f.request('GET',{sessionId:'foreign'})).code,400)
})

test('runner setup installs only packaged exact bytes under native write policy and CAS',async t=>{
  const f=await fixture(t),first=await f.request('GET',{sessionId:'owner'})
  assert.equal((await f.request('GET',{sessionId:'owner',action:'install-runner'})).code,405)
  const installed=await f.request('POST',{sessionId:'owner',action:'install-runner',expectedVersion:null},first.body.csrfToken)
  assert.equal(installed.code,200)
  const bytes=await readFile(join(f.root,installed.body.runnerTemplate.path))
  assert.equal(hash(bytes),installed.body.runnerTemplate.sha256)
  assert.equal((await f.request('POST',{sessionId:'owner',action:'install-runner',expectedVersion:null},first.body.csrfToken)).code,409)
  f.policy.mode='read-only'
  assert.equal((await f.request('POST',{sessionId:'owner',action:'install-runner',expectedVersion:installed.body.runnerTemplate.version},first.body.csrfToken)).body.error,'SPECIALIZED_WORKSPACE_WRITE_REQUIRED')
  assert.equal(f.calls.filter(row=>row.action==='run').length,0)
})

test('invalid runtime binding remains editable through authenticated setup without launching anything',async t=>{
 const f=await fixture(t);await mkdir(join(f.root,'.dsh'));await writeFile(join(f.root,'.dsh/onec-specialized.json'),'broken json')
 f.ctx.airulesOnecSpecialized.act=async()=>{throw new Error('SPECIALIZED_BINDING_JSON_INVALID')}
 const first=await f.request('GET',{sessionId:'owner'});assert.equal(first.code,200);assert.equal(first.body.binding.text,'broken json');assert.equal(first.body.status.inspectionError,'SPECIALIZED_BINDING_JSON_INVALID')
 const saved=await f.request('POST',{sessionId:'owner',action:'save-binding',text:'{"schemaVersion":1}',expectedVersion:first.body.binding.version},first.body.csrfToken);assert.equal(saved.code,200)
 assert.equal((await readFile(join(f.root,'.dsh/onec-specialized.json'),'utf8')).trim(),'{\n  "schemaVersion": 1\n}')
})
