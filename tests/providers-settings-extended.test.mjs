import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'

const source=await readFile(new URL('../src/providers-settings/client.js',import.meta.url),'utf8')
const metadata=JSON.parse(await readFile(new URL('../src/providers-settings/package.json',import.meta.url),'utf8'))
const plans=[{id:'airules-zai-plan',name:'GLM · Coding Plan'},{id:'airules-qwen-plan',name:'Qwen Token Plan · International'},{id:'airules-opencode-go',name:'OpenCode Go'}]
const drivers=[{id:'google',name:'Google Gemini · Antigravity ACP'},{id:'muse',name:'Meta Muse · ACP'}]
const h=(type,props,...children)=>({type,props:props??{},children:children.flat()})
const flatten=node=>!node||typeof node!=='object'?[]:[node,...(node.children??[]).flatMap(flatten)]
function fixture(values=[],missing=false){
  let exported,index=0;const effects=[],state=[...values],calls=[]
  const components=Object.fromEntries(['SubscriptionProviderPanel','KimiSettings','ApiPlanSettings','DriverSettings','CursorSettings'].map(name=>[name,function Panel(){calls.push(name);return h('p',null,name)}]))
  const native={getSnapshot:()=>undefined,subscribe:()=>()=>{}},accountNative={getSnapshot:()=>undefined,subscribe:()=>()=>{}}
  const React={createElement:h,Fragment:'fragment',useState(initial){const current=index++;if(state[current]===undefined)state[current]=initial;return[state[current],next=>{state[current]=typeof next==='function'?next(state[current]):next}]},useSyncExternalStore:(subscribe,get)=>get(),useEffect:fn=>effects.push(fn)}
  const modules={react:React,'@deepseek-ai/dsh-client-ui-settings-models':{airulesProviders:native},'@deepseek-ai/dsh-client-ui-settings-account':{airulesProvidersAccount:accountNative},'airules-dsh-subscriptions':components,'airules-dsh-additional-providers':{...components,PLAN_SUBSCRIPTIONS:plans},'airules-dsh-provider-extensions':{...components,DRIVER_PROVIDERS:drivers},'airules-dsh-cursor-provider':components}
  runInNewContext(source,{window:{__ModuleLoader__:{load(value){exported=value.factory(id=>{if(missing&&['airules-dsh-provider-extensions','airules-dsh-cursor-provider'].includes(id))throw new Error('MISSING_COMPONENT');assert.ok(modules[id],id);return modules[id]})}}}})
  const ctx={connection:{rpc:{}},remote:{session:{async modelCatalog(){calls.push('catalog');return {ok:true,value:{groups:[]}}}},$on(){return()=>{}}}}
  return {plugin:exported,components,ctx,calls,effects,state,reset(){index=0}}
}

test('unified provider metadata includes three plans, Google/Muse and Cursor without live catalog',()=>{
  const f=fixture(),tree=f.plugin.ProvidersPage({ctx:f.ctx,renderSlot:()=>null}),cards=flatten(tree).filter(node=>node.type===f.plugin.Card)
  assert.equal(cards.length,12)
  for(const title of ['GLM · Coding Plan','Qwen Token Plan · International','OpenCode Go','Google Gemini · Antigravity ACP','Meta Muse · ACP','Cursor · подписка'])assert.ok(cards.some(row=>row.props.title===title),title)
  assert.ok(cards.every(card=>card.props.count===undefined),'unknown catalogs are not displayed as confirmed zero')
  assert.equal(f.calls.length,0,'rendering does not mount panels or invoke OAuth/SDK requests')
  assert.ok(metadata.dsh.client.inject.includes('airules-dsh-provider-extensions'))
  assert.ok(metadata.dsh.client.inject.includes('airules-dsh-cursor-provider'))
})

test('embedded extended panels pass exact native provider ids to reusable components',()=>{
  const f=fixture()
  for(const spec of plans){const panel=f.plugin.ExtendedPanel({row:{...spec,kind:'plan'}});assert.equal(panel.type,f.components.ApiPlanSettings);assert.equal(panel.props.providerId,spec.id)}
  for(const spec of drivers){const panel=f.plugin.ExtendedPanel({row:{...spec,kind:'driver'}});assert.equal(panel.type,f.components.DriverSettings);assert.equal(panel.props.providerId,spec.id)}
  assert.equal(f.plugin.ExtendedPanel({row:{id:'airules-cursor',kind:'cursor'}}).type,f.components.CursorSettings)
  assert.equal(f.calls.length,0)
})

test('search finds runtime cards and their configured ACP model aliases while API group remains independent',()=>{
  const groups=[{id:'acp-airules-google',models:[{id:'gemini-fixture',name:'Fixture Google'}]},{id:'acp-airules-muse',models:[{id:'muse-fixture'}]},{id:'airules-cursor',models:[{id:'cursor-fixture'}]}]
  const google=fixture(['gemini-fixture','subscriptions',groups,0,false,'ready'])
  const cards=flatten(google.plugin.ProvidersPage({ctx:google.ctx,renderSlot:()=>null})).filter(node=>node.type===google.plugin.Card)
  assert.equal(cards.length,1);assert.equal(cards[0].props.title,'Google Gemini · Antigravity ACP');assert.equal(cards[0].props.count,1)
  assert.equal(google.plugin.catalogModels(groups,'muse')[0].id,'muse-fixture')
  const api=fixture(['','api',groups,0,false,'ready'])
  assert.equal(flatten(api.plugin.ProvidersPage({ctx:api.ctx,renderSlot:()=>null})).filter(node=>node.type===api.plugin.Card).length,0)
})

test('model counters describe catalog availability, never imply authenticated accounts',()=>{
  const f=fixture(['','subscriptions',[{id:'airules-zai-plan',models:[{id:'glm-fixture'}]}],0,false,'ready'])
  const tree=f.plugin.ProvidersPage({ctx:f.ctx,renderSlot:()=>null}),nodes=flatten(tree)
  assert.equal(nodes.find(n=>n.props.className==='airulesProvidersGroupCount').children[0],'С моделями: 1 из 12')
  assert.match(f.plugin.providerTag({kind:'plan'},[],true),/нужна настройка/u)
  assert.doesNotMatch(f.plugin.providerTag({kind:'plan'},[{id:'fixture'}],true),/подключён|подключено/u)
})

test('closed card does not mount its panel; visited card stays mounted when collapsed',()=>{
  const f=fixture(),child=h(f.components.DriverSettings,{providerId:'google'})
  let tree=f.plugin.Card({title:'Google',tag:'Настройка',children:child})
  assert.equal(flatten(tree).some(node=>node.props.className==='airulesProviderBody'),false)
  tree.props.onToggle({currentTarget:{open:true}});f.reset()
  tree=f.plugin.Card({title:'Google',tag:'Настройка',children:child})
  assert.equal(flatten(tree).find(node=>node.props.className==='airulesProviderBody').props.hidden,false)
  tree.props.onToggle({currentTarget:{open:false}});f.reset()
  tree=f.plugin.Card({title:'Google',tag:'Настройка',children:child})
  const body=flatten(tree).find(node=>node.props.className==='airulesProviderBody');assert.equal(body.props.hidden,true);assert.equal(body.children[0],child)
  assert.equal(f.calls.length,0)
})

test('Claude card explains actual disabled direct route and does not offer its broken OAuth form',()=>{
  const f=fixture(['claude','subscriptions',[],0,false,'ready']),tree=f.plugin.ProvidersPage({ctx:f.ctx,renderSlot:()=>null}),cards=flatten(tree).filter(node=>node.type===f.plugin.Card)
  assert.equal(cards.length,1);assert.match(cards[0].props.tag,/прямой OAuth отключён/u)
  assert.ok(!f.plugin.SUBSCRIPTIONS.some(row=>row.id==='claude'))
  const panel=f.plugin.ExtendedPanel({row:{id:'claude-cli',kind:'claude-cli'}})
  assert.match(flatten(panel).flatMap(node=>node.children.filter(c=>typeof c==='string')).join(' '),/официальный Claude CLI/u)
  assert.ok(!flatten(panel).some(node=>node.type===f.components.SubscriptionProviderPanel))
})

test('missing advanced client module exposes a cold setup error rather than authenticated placeholder',()=>{
  const f=fixture([],true),panel=f.plugin.ExtendedPanel({row:{id:'google',kind:'driver'}}),tree=panel.type(panel.props)
  assert.equal(tree.props.role,'alert');assert.match(tree.children[0],/не загружен/u)
})
