import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { MATRIX, validateRun, publicModels, loadSubscriptionPlugin } from '../scripts/probe-live-model-orchestration.mjs'

const safeRemove = async root => { const rel=relative(tmpdir(),root); assert.ok(!isAbsolute(rel)&&!rel.startsWith('..')&&rel.startsWith('airules-live-test-')); await rm(root,{recursive:true,force:true}) }

test('live matrix pins exact discovered ids/efforts and budget; alternate models and request inflation fail closed',()=>{
  assert.equal(MATRIX.length,4)
  for(const row of MATRIX)assert.equal(validateRun(row),true)
  assert.throws(()=>validateRun({...MATRIX[0],effort:'low'}),/EXACT_AUTHORIZED_MATRIX/)
  assert.throws(()=>validateRun({...MATRIX[0],maxRequests:25}),/BUDGET/)
  assert.equal(MATRIX.filter(row=>row.mcp).length,2)
})

test('metadata serialization never includes account or adapter private fields',()=>{
  assert.deepEqual(publicModels('codex',[{id:'gpt-6.1-sol',name:'Sol',accessToken:'synthetic',account:{email:'synthetic'},reasoning:{efforts:[{id:'medium',private:'synthetic'}],defaultEffort:'low'}}]),[{provider:'codex',id:'gpt-6.1-sol',name:'Sol',efforts:['medium'],defaultEffort:'low'}])
})

test('explicit auth-store seam isolates native token IO and auth-controller writes without replacing home resolver',async t=>{
  const root=await mkdtemp(join(tmpdir(),'airules-live-test-'));t.after(()=>safeRemove(root))
  process.env.DSH_HOME=join(root,'isolated-home');process.env.DSH_AGENTS_HOME=join(root,'isolated-agents')
  const runtime=await loadSubscriptionPlugin(root), path=join(root,'explicit-auth.json'), untouched=join(root,'other-installation.json')
  const session={accessToken:'synthetic-access',refreshToken:'synthetic-refresh',expiresAt:Date.now()+3600000,accountId:'synthetic-id'}
  const store={codex:{default:'synthetic-one',accounts:{'synthetic-one':session}}}
  await writeFile(path,JSON.stringify(store));await writeFile(untouched,'untouched\n')
  const adapters=new Map(), disposers=[]
  const ctx={logger:{warn(){}},get:()=>undefined,llm:{registerAdapter(ids,adapter){for(const id of ids)adapters.set(id,adapter);return{replace(){},dispose(){}}}},
    effect(factory){const dispose=factory();if(typeof dispose==='function')disposers.push(dispose)},inject(){}}
  t.after(()=>{for(const dispose of disposers.reverse())dispose()})
  runtime.apply(ctx,{providers:['codex'],pool:{enabled:false}}, {authStorePath:path})
  const tokens=adapters.get('codex').options.tokens
  assert.equal(await tokens.defaultAccount(),'synthetic-one')
  assert.equal((await tokens.session()).accessToken,'synthetic-access')
  const idle={isBusy:()=>false,pending:()=>undefined}
  const controller=new runtime.SubscriptionsAuthController(idle,idle,()=>{},()=>undefined,{},()=>undefined,undefined,new Map([['codex',tokens]]),path)
  assert.equal((await controller.status('codex')).accounts.length,1)
  await controller.setEnabled('codex','synthetic-one',false)
  assert.equal(JSON.parse(await readFile(path,'utf8')).codex.accounts['synthetic-one'].enabled,false)
  assert.equal(await readFile(untouched,'utf8'),'untouched\n')
  await controller.setEnabled('codex','synthetic-one',true)
  await controller.logout('codex','synthetic-one')
  assert.equal((await tokens.list()).length,0)
  assert.throws(()=>runtime.apply(ctx,{}, {authStorePath:'relative-auth.json'}),/absolute path/)
})
