import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { createRequire } from 'node:module'

async function fixture(t, { nativeLlm = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'airules-subscriptions-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const pkg = join(root, 'package'), home = join(root, 'dsh-home')
  cpSync(resolve('src/subscriptions'), pkg, { recursive: true })
  const modules = {
    '@deepseek-ai/schemastery': 'const x = new Proxy(function(){return x},{get:()=>x});export default x',
    '@deepseek-ai/dsh-llm': `export class LlmAdapter {}
      export class LlmError extends Error {constructor(message,code){super(message);this.code=code}}
      export const CONTEXT_WINDOW_EXCEEDED_CODE='CONTEXT_WINDOW_EXCEEDED',EMPTY_RESPONSE_CODE='EMPTY_RESPONSE',QUOTA_EXCEEDED_CODE='QUOTA_EXCEEDED';
      export const ReasoningEffortId=x=>x,attributionHeaders=()=>({}),errorChain=e=>e.message,isContextWindowExceededError=()=>false,isQuotaExceededError=()=>false,resolveRetryPolicy=x=>x;`,
    '@deepseek-ai/dsh-home-paths': `import {join} from 'node:path';export const dshHomePath=(...parts)=>join(${JSON.stringify(home)},...parts)`,
    '@deepseek-ai/dsh-attachment': 'export const AttachmentId = x => x',
    '@deepseek-ai/dsh-tools': 'export const defineTool = x => x',
    'undici': 'export class ProxyAgent{};export const fetch = (...args) => globalThis.fetch(...args)',
  }
  if (nativeLlm) {
    modules['@deepseek-ai/dsh-llm'] = `export * from ${JSON.stringify(pathToFileURL(resolve('var/asar-extract-rc5/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js')).href)}`
    modules['@deepseek-ai/schemastery'] = `export { default } from ${JSON.stringify(pathToFileURL(resolve('var/asar-extract-rc5/dsh/node_modules/@deepseek-ai/schemastery/lib/index.mjs')).href)}`
    modules.undici = `export { ProxyAgent, fetch } from ${JSON.stringify(pathToFileURL(resolve('dist/airules-official-policy-0.12.0-dev12/payload/packages/airules-dsh-subscriptions/node_modules/undici/index.js')).href)}`
  }
  for (const [name, code] of Object.entries(modules)) {
    const dir = join(pkg, 'node_modules', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, type: 'module', exports: './index.js' }))
    writeFileSync(join(dir, 'index.js'), code)
  }
  const runtime = await import(pathToFileURL(join(pkg, 'lib/index.js')))
  const routes = new Map(), adapters = new Map(), disposers = [], injects = []
  const ctx = {
    logger: { warn() {} },
    get(name) { if (name === 'llm') return this.llm },
    llm: {
      registerAdapter(names, adapter) { for (const name of names) adapters.set(name, adapter);return {replace(){},dispose(){}} },
      async listProviders() { return [...adapters.keys()].map(id=>({id})) },
      async listModels(provider) { return adapters.get(provider).listModels(provider) },
      async resolveModelInfo() {},
    },
    effect(factory) { const dispose = factory(); if (typeof dispose === 'function') disposers.push(dispose) },
    inject(names, callback) {
      injects.push(names)
      if (names.includes('connection')) callback({connection:{register(owner,channel,handler){routes.set(channel,{handler,owner});return ()=>{}}},effect:factory=>{const dispose=factory();if(typeof dispose==='function')disposers.push(dispose)}})
    },
  }
  t.after(()=>{for(const dispose of disposers.reverse())dispose()})
  return {root,pkg,home,runtime,ctx,routes,adapters,injects}
}

test('pinned host actually mounts and dispatches subscription POST RPC routes', async t => {
  const { Context, Service } = await import('../var/asar-extract-rc5/dsh/node_modules/@deepseek-ai/cordis/lib/index.js')
  const { HostConnectionService } = await import('../var/asar-extract-rc5/dsh/node_modules/@deepseek-ai/dsh-client-connection/lib/index.js')
  const { WebServer } = await import('../var/asar-extract-rc5/dsh/node_modules/@deepseek-ai/dsh-host-webserver/lib/index.js')
  const f = await fixture(t, { nativeLlm: true }), root = new Context()
  let web
  const webFiber = root.plugin({ name: 'native-test-webserver', apply(ctx) { web = new WebServer(ctx, { host: '127.0.0.1', port: 0, compression: 'none' }) } })
  await webFiber.await(); await web[Service.init](); t.after(() => webFiber.dispose())
  const { LlmRuntime } = await import('../var/asar-extract-rc5/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js')
  new LlmRuntime(root)
  const fiber = root.plugin(f.runtime)
  await fiber.await(); t.after(() => fiber.dispose())
  const connection = new HostConnectionService(root, [], {})
  // Keep the real native route/bridge/envelope path, isolate only authentication.
  connection.admit = () => ({ peer: {} })
  await new Promise(resolve => setTimeout(resolve, 20))
  for (const runtime of root.registry.values()) for (const child of runtime.fibers) if (child.state === 3) assert.fail(JSON.stringify(child.inject) + '\n' + (child._error?.stack ?? 'NATIVE_FIBER_FAILED'))
  for (const [method, payload] of [['status', {}], ['providerSettings', { provider: 'codex' }], ['proxyGet', {}], ['login', { provider: 'invalid' }]]) {
    const response = await fetch(`${web.getOrigin()}/airules-subscriptions-auth/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'native-test', method, payload }) })
    assert.equal(response.status, 200, method)
    const body = await response.json(); assert.equal(body.type, 'server-response'); assert.equal(typeof body.result.ok, 'boolean')
    if (method !== 'login') assert.equal(body.result.ok, true, method)
  }
  connection.admit = () => ({ rejection: 403 })
  const denied = await fetch(`${web.getOrigin()}/airules-subscriptions-auth/status`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  assert.equal(denied.status, 403)
})

test('native explicit session effort overrides subscription model default and reaches Codex wire unchanged', async t => {
  const f = await fixture(t, { nativeLlm: true })
  f.runtime.apply(f.ctx, { providers: ['codex'], pool: { enabled: false }, models: { codex: [{ id: 'gpt-6.1-sol', name: 'GPT 6.1 Sol' }] } })
  const adapter = f.adapters.get('codex')
  // Represent the discovered model's Low default while retaining real adapter capabilities.
  adapter.options.defaultEffortOf = () => 'low'
  const { Context } = await import('../var/asar-extract-rc5/dsh/node_modules/@deepseek-ai/cordis/lib/index.js')
  const { LlmRuntime } = await import('../var/asar-extract-rc5/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js')
  const native = new LlmRuntime(new Context()), registration = native.registerAdapter(['codex'], adapter)
  t.after(() => registration())
  const defaulted = await native.resolveCallConfig({ provider: 'codex', model: 'gpt-6.1-sol' })
  assert.equal(defaulted.reasoningEffort, 'low')
  const require = createRequire(import.meta.url)
  const { MockAgent, getGlobalDispatcher, setGlobalDispatcher } = require('../dist/airules-official-policy-0.12.0-dev12/payload/packages/airules-dsh-subscriptions/node_modules/undici')
  const previous = getGlobalDispatcher(), dispatcher = new MockAgent(); dispatcher.disableNetConnect(); setGlobalDispatcher(dispatcher)
  t.after(async () => { setGlobalDispatcher(previous); await dispatcher.close() })
  const wireEfforts = []
  // MockAgent rejects every request not explicitly admitted here; no paid requests.
  for (const effort of ['high', 'xhigh']) {
    const selected = await native.resolveCallConfig({ provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: effort })
    assert.equal(selected.reasoningEffort, effort)
    dispatcher.get('https://chatgpt.com').intercept({ path: '/backend-api/codex/responses', method: 'POST' }).reply(options => {
      wireEfforts.push(JSON.parse(options.body).reasoning.effort)
      return { statusCode: 200, data: '' }
    })
    const response = await adapter.request({ ...selected, messages: [], modelParameters: { speedTier: 'standard' } }, { accessToken: 'synthetic-no-network', accountId: 'synthetic' }, new AbortController().signal)
    await response.text()
  }
  assert.deepEqual(wireEfforts, ['high', 'xhigh'])
  await assert.rejects(native.resolveCallConfig({ provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'unsupported' }))
})

test('subscriptions cold boot and status stay offline and do not migrate legacy account stores', async t => {
  const f = await fixture(t)
  const old = join(f.home,'plugins/router/auth.json')
  mkdirSync(join(f.home,'plugins/router'),{recursive:true})
  writeFileSync(old,'not a subscription store; must remain unread')
  const originalFetch = globalThis.fetch
  let requests=0
  globalThis.fetch=async()=>{requests++;throw Error('unexpected network')}
  t.after(()=>{globalThis.fetch=originalFetch})
  f.runtime.apply(f.ctx)
  assert.deepEqual([...f.adapters.keys()],['codex','claude','grok','copilot'])
  const endpoint=f.routes.get('/airules-subscriptions-auth')
  assert.ok(endpoint.owner)
  const status=await endpoint.handler('status',{})
  assert.equal(status.ok,true)
  for(const provider of ['codex','claude','grok','copilot']) {
    assert.deepEqual(status.value.providers[provider].accounts,[])
    assert.deepEqual(await f.adapters.get(provider).listModels(provider),[])
  }
  assert.equal(requests,0)
  assert.equal(readFileSync(old,'utf8'),'not a subscription store; must remain unread')
  assert.equal(existsSync(join(f.home,'plugins/airules-subscriptions/auth.json')),false)
  assert.equal(f.injects.some(names=>names.includes('tools')),false)
})

test('model visibility settings persist without supplier cleanup or session/history rewrites', async t => {
  const f=await fixture(t)
  f.runtime.apply(f.ctx)
  const rpc=f.routes.get('/airules-subscriptions-auth').handler
  const result=await rpc('setProviderSettings',{provider:'codex',settings:{visibleModels:[]}})
  assert.equal(result.ok,true)
  assert.deepEqual(result.value.cleanup,{groups:[],errors:[]})
  const settings=JSON.parse(readFileSync(join(f.home,'plugins/airules-subscriptions/provider-settings.json'),'utf8'))
  assert.deepEqual(settings.providers.codex.visibleModels,[])
  const modelView=await rpc('providerSettings',{provider:'codex'})
  assert.equal(modelView.ok,true)
  assert.deepEqual(modelView.value.tools,[])
  const invalid=await rpc('setProviderSettings',{provider:'codex',settings:{contextWindows:{demo:-1}}})
  assert.equal(invalid.ok,false)
})

test('explicit account operations support defaults and per-account logout while status omits credentials', async t => {
  const f=await fixture(t)
  const path=join(f.home,'plugins/airules-subscriptions/auth.json')
  mkdirSync(join(f.home,'plugins/airules-subscriptions'),{recursive:true})
  const account=label=>({accessToken:'synthetic-access-'+label,refreshToken:'synthetic-refresh-'+label,expiresAt:Date.now()+3600000,accountId:label})
  writeFileSync(path,JSON.stringify({codex:{default:'one',accounts:{one:account('one'),two:account('two')}}}))
  const noFlow={isBusy:()=>false,pending:()=>undefined}
  const controller=new f.runtime.SubscriptionsAuthController(noFlow,noFlow,()=>{},()=>undefined)
  const first=await controller.status('codex')
  assert.equal(first.accounts.length,2)
  assert.equal(JSON.stringify(first).includes('synthetic-'),false)
  await controller.setDefault('codex','two')
  assert.equal((await controller.status('codex')).accounts[0].key,'two')
  await controller.logout('codex','one')
  assert.deepEqual((await controller.status('codex')).accounts.map(row=>row.key),['two'])
})

test('ordinary Claude login uses explicit OAuth; only explicit keychain action imports credentials', async t => {
  const f=await fixture(t)
  let reads=0,starts=0
  const flow={start:async()=>{starts++;return {authorizeUrl:'https://example.invalid/manual-login',waitCode:()=>new Promise(()=>{})}},pending:()=>undefined,isBusy:()=>false}
  const controller=new f.runtime.SubscriptionsAuthController(flow,flow,()=>{},()=>undefined,{},()=>{reads++;return undefined})
  assert.equal((await controller.login('claude')).authorizeUrl,'https://example.invalid/manual-login')
  assert.equal(reads,0)
  assert.equal(starts,1)
  await assert.rejects(controller.login('claude','keychain'),/no Claude Code credentials/)
  assert.equal(reads,1)
})

test('client exposes the full standalone settings section without supplier Models page props', () => {
  let loaded
  const React={useState:initial=>[typeof initial==='function'?initial():initial,()=>{}],useEffect(){},useCallback:fn=>fn,useMemo:fn=>fn(),useRef:value=>({current:value}),useSyncExternalStore:(_subscribe,snapshot)=>snapshot()}
  const jsx=(type,props)=>({type,props})
  const document={addEventListener(){},removeEventListener(){},createElement:()=>({setAttribute(){},remove(){}}),head:{appendChild(){}}}
  runInNewContext(readFileSync(resolve('src/subscriptions/lib/client.js'),'utf8'),{
    window:{__ModuleLoader__:{load:definition=>{loaded=definition}}},document,console,
  })
  assert.equal(loaded.id,'airules-dsh-subscriptions')
  const client=loaded.factory(name=>name==='react'?React:name==='react/jsx-runtime'?{jsx,jsxs:jsx}: {})
  const slots=[]
  const ctx={effect:fn=>fn(),inject(){},locale:{register(){},bind:()=>key=>key},get:name=>name==='connection'?{rpc:{}}:undefined,
    slots:{inject:(_name,fn)=>fn(),register:(definition,component)=>{slots.push({definition,component})}}}
  client.apply(ctx)
  const section=slots.find(row=>row.definition.name==='settings.section')
  assert.equal(section.component.name,'SubscriptionsSection')
  const rendered=section.component({rpc:{},t:key=>key})
  assert.notEqual(rendered,null)
  const contents=JSON.stringify(rendered)
  assert.match(contents,/OpenAI \(OAuth\)/)
  assert.match(contents,/Claude/)
  assert.match(contents,/Grok/)
  assert.match(contents,/Copilot/)
})
