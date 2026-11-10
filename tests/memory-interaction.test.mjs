import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
const source = await readFile(new URL('../src/memory-workspace/lib/client.js', import.meta.url), 'utf8')
function harness() {
  const states = [], effects = [], callbacks = [], refs = []
  let cursor = 0, client, deferred, requests = [], css
  const same = (a,b) => a && b && a.length === b.length && a.every((x,i) => x === b[i])
  const React = {
    Fragment: 'fragment', createElement: (type,props,...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    useState(initial) { const i=cursor++; if (!(i in states)) states[i]=initial; return [states[i], value => { states[i]=typeof value === 'function' ? value(states[i]) : value }] },
    useRef(initial) { const i=cursor++; return refs[i] ??= { current:initial } },
    useCallback(fn,deps) { const i=cursor++; if (!same(callbacks[i]?.deps,deps)) callbacks[i]={deps,fn}; return callbacks[i].fn },
    useEffect(fn,deps) { const i=cursor++; if (!same(callbacks[i]?.deps,deps)) { callbacks[i]?.cleanup?.(); callbacks[i]={deps}; effects.push(() => { callbacks[i].cleanup=fn() }) } },
    useSyncExternalStore() { cursor++; return { byId: { one: { id:'one', title:'Fixture', retainedBy:{mainView:1} } } } },
  }
  const config={enabled:true,endpoint:'http://127.0.0.1:18080',localProcessing:true}
  const fetch = async (url, options) => {
    const input=options?.body ? JSON.parse(options.body) : Object.fromEntries(new URL(url,'http://localhost').searchParams)
    requests.push(input)
    if (input.action==='configuration') return {ok:true,json:async()=>({ok:true,config,revision:'r1',csrfToken:'fixture',scope:{writable:true,globalWritable:true,projectRoot:'D:/fixture',dataset:'fixture'}})}
    return await new Promise(resolve => { deferred = value => resolve({ok:true,json:async()=>({ok:true,...value})}) })
  }
  const window={confirm:()=>false,__ModuleLoader__:{load(module){client=module.factory(()=>React)}}}
  runInNewContext(source,{window,fetch,URLSearchParams,AbortController,setTimeout,clearTimeout,document:{createElement:()=>({remove(){}}),head:{appendChild(style){css=style.textContent}}}})
  client.apply({get:()=>({list:{}}),slots:{inject(){},register(){}},effect:fn=>fn()})
  return { render() {cursor=0; return client.Memory()}, flushEffects(){effects.splice(0).forEach(fn=>fn())}, settle:()=>new Promise(resolve=>setImmediate(resolve)), reply(value){deferred(value)}, requests, get css(){return css} }
}
const flatten=node=>!node||typeof node!=='object'?[]:[node,...(node.children??[]).flatMap(flatten)]
const label=node=>(node.children??[]).filter(x=>typeof x==='string').join('')

test('memory action keeps native focusable button and fixed feedback mounted while pending; result precedes forms', async()=>{
  const ui=harness(); ui.render(); ui.flushEffects(); await ui.settle()
  let tree=ui.render(), button=flatten(tree).find(x=>x.type==='button'&&label(x)==='Документы')
  button.props.onClick(); await ui.settle()
  tree=ui.render(); button=flatten(tree).find(x=>x.type==='button'&&label(x)==='Документы')
  assert.equal(button.props.disabled,false)
  assert.equal(button.props['aria-disabled'],true)
  assert.equal(flatten(tree).filter(x=>x.props.className==='am-feedback').length,1)
  button.props.onClick(); assert.equal(ui.requests.filter(x=>x.action==='documents').length,1)
  ui.reply({documents:[]}); await ui.settle(); tree=ui.render()
  const nodes=flatten(tree)
  assert.ok(nodes.findIndex(x=>x.props.className==='am-feedback') < nodes.findIndex(x=>x.type==='form'))
  assert.ok(nodes.some(x=>x.props.result?.documents?.length===0))
  assert.equal(nodes.find(x=>x.type==='button'&&label(x)==='Документы').props['aria-disabled'],false)
  assert.match(ui.css,/\.am-result\{height:180px;/u)
  assert.match(ui.css,/flex-direction:column/u)
  assert.doesNotMatch(ui.css,/(?:^|\})\.am-toolbar\{/u)
  const search=flatten(tree).find(x=>x.type==='input'&&x.props.maxLength===4000)
  search.props.onChange({target:{value:'fixture'}}); tree=ui.render()
  flatten(tree).find(x=>x.type==='form').props.onSubmit({preventDefault(){}})
  await ui.settle(); tree=ui.render()
  const find=flatten(tree).find(x=>x.type==='button'&&label(x)==='Найти')
  assert.equal(find.props.disabled,false); assert.equal(find.props['aria-disabled'],true)
  ui.reply({results:[]}); await ui.settle()
})
