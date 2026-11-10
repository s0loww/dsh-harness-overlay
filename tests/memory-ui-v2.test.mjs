import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {runInNewContext} from 'node:vm'

const source=await readFile(new URL('../src/memory-workspace/lib/client.js',import.meta.url),'utf8')
const flatten=node=>!node||typeof node!=='object'?[]:[node,...(node.children??[]).flatMap(flatten)]
const text=node=>typeof node==='string'?node:!node||typeof node!=='object'?'':typeof node.type==='function'&&['Result','Graph'].includes(node.type.name)?text(node.type(node.props)):(node.children??[]).map(text).join(' ')
const findButton=(tree,label)=>flatten(tree).find(row=>row.type==='button'&&text(row)===label)
const findField=(tree,label)=>flatten(tree).find(row=>row.type==='label'&&row.children[0]===label)?.children.find(row=>row&&typeof row==='object')
function harness(component,initialProps={},fetchImpl=async()=>({ok:true})) {
  let cursor=0,props=initialProps,client,css
  const state=[],refs=[],memo=[],effects=[],calls=[]
  const same=(a,b)=>a&&b&&a.length===b.length&&a.every((x,i)=>x===b[i])
  const React={Fragment:'fragment',createElement:(type,props,...children)=>({type,props:props??{},children:children.flat(Infinity)}),
    useState(initial){const i=cursor++;if(!(i in state))state[i]=initial;return[state[i],value=>{state[i]=typeof value==='function'?value(state[i]):value}]},
    useRef(initial){const i=cursor++;return refs[i]??={current:initial}},
    useCallback(fn,deps){const i=cursor++;if(!same(memo[i]?.deps,deps))memo[i]={deps,fn};return memo[i].fn},
    useEffect(fn,deps){const i=cursor++;if(!same(memo[i]?.deps,deps)){memo[i]?.cleanup?.();memo[i]={deps};effects.push(()=>{memo[i].cleanup=fn()})}},
    useSyncExternalStore(){cursor++;return{byId:{standard:{id:'standard',title:'Native standard',retainedBy:{mainView:1}}}}}}
  runInNewContext(source,{window:{confirm:()=>true,__ModuleLoader__:{load(module){client=module.factory(()=>React)}}},fetch:async(url,options)=>{
    const input=options?.body?JSON.parse(options.body):Object.fromEntries(new URL(url,'http://localhost').searchParams);calls.push({input,method:options?.method??'GET'});const value=await fetchImpl(input);return{ok:value.ok!==false,status:value.ok===false?400:200,json:async()=>value}},
    URLSearchParams,AbortController,setTimeout,clearTimeout,document:{createElement:()=>({remove(){}}),head:{appendChild(style){css=style.textContent}}}})
  client.apply({get:()=>({list:{}}),slots:{inject(){},register(){}},effect:fn=>fn()})
  return{client,calls,render(nextProps){if(nextProps)props=nextProps;cursor=0;return client[component](props)},flush(){effects.splice(0).forEach(fn=>fn())},settle:()=>new Promise(resolve=>setImmediate(resolve)),get css(){return css}}
}
const globalPolicy={schemaVersion:1,mode:'both',writeTarget:'auto'}
const projectPolicy={schemaVersion:1,mode:'inherit',writeTarget:'inherit'}
const processing={profile:{allowed:true,embeddings:{provider:'fastembed',model:'BAAI/bge-small-en-v1.5',dimensions:384},extraction:{provider:'gliner',model:'fastino/gliner2.5-base-v1'}},revision:'processing-v1',bindingAvailable:true,applied:{state:'observed',matchesDesired:true}}
const policy={global:globalPolicy,project:projectPolicy,effective:{mode:'both',writeTarget:'auto',source:'global'},globalRevision:'global-v1',projectRevision:'project-v1'}

test('global policy can be saved without a usable project session and mutation carries its own CAS revision',async()=>{
  const view={ok:true,config:{enabled:true,endpoint:'http://127.0.0.1:18080',localProcessing:true},revision:'connection-v1',csrfToken:'csrf-fixture',scope:null,projectError:'Open a project chat',policy,processing}
  const ui=harness('Memory',{},async input=>input.action==='configuration'?view:{ok:true})
  ui.render();ui.flush();await ui.settle();let tree=ui.render()
  assert.ok(text(tree).includes('Проектный чат не выбран'));assert.ok(text(tree).includes('Действует: Обе'))
  assert.equal(findButton(tree,'Проверить связь').props.disabled,true)
  const editor=flatten(tree).find(row=>row.type?.name==='PolicyPanel')
  assert.equal(editor.props.scope,null);assert.equal(editor.props.policy.globalRevision,'global-v1')
  await editor.props.onSave('policyGlobal',{policy:{...globalPolicy,mode:'memoria'},expectedRevision:'global-v1'})
  const saved=ui.calls.find(row=>row.input.action==='policyGlobal')
  assert.equal(saved.method,'POST');assert.equal(saved.input.expectedRevision,'global-v1');assert.equal(saved.input.sessionId,undefined)
  assert.equal(saved.input.policy.mode,'memoria')
  assert.equal(ui.calls.filter(row=>row.input.action==='configuration').length,2)
  assert.ok(!source.includes("useState('cognee')"));assert.ok(!source.includes('memoraSubmit'));assert.ok(!source.includes('Аргументы выбранного инструмента (JSON)'))
})

test('project inherits global policy and scoped edits preserve the project CAS and typed Memoria binding',()=>{
  const saved=[],props={policy,scope:{projectRoot:'D:/fixture',writable:true},sessionId:'lead',token:'csrf',busy:false,onSave:(action,input)=>saved.push({action,input})}
  const ui=harness('PolicyPanel',props);let tree=ui.render();ui.flush();tree=ui.render()
  assert.equal(findField(tree,'Режим памяти проекта').props.value,'inherit')
  findField(tree,'Режим памяти проекта').props.onChange({target:{value:'memoria'}});tree=ui.render()
  findField(tree,'Пространство проекта в Memoria').props.onChange({target:{value:'isolated-fixture'}});tree=ui.render()
  findField(tree,'Поле области в поиске').props.onChange({target:{value:'namespace'}});tree=ui.render()
  findButton(tree,'Сохранить настройку проекта').props.onClick()
  assert.equal(saved[0].action,'projectPolicy');assert.equal(saved[0].input.sessionId,'lead');assert.equal(saved[0].input.expectedRevision,'project-v1')
  assert.equal(saved[0].input.policy.schemaVersion,1);assert.equal(saved[0].input.policy.mode,'memoria');assert.equal(saved[0].input.policy.writeTarget,'inherit')
  assert.equal(saved[0].input.policy.memoria.namespace,'isolated-fixture');assert.equal(saved[0].input.policy.memoria.search.scopeArgument,'namespace')
})

test('write destinations follow the selected mode without silently changing an inherited project conflict',()=>{
  const saved=[],props={policy:{...policy,global:{...globalPolicy,writeTarget:'both'}},scope:{writable:true},sessionId:'lead',token:'csrf',busy:false,onSave:(action,input)=>saved.push({action,input})}
  const ui=harness('PolicyPanel',props);let tree=ui.render();ui.flush();tree=ui.render()
  findField(tree,'Режим памяти для новых и наследующих проектов').props.onChange({target:{value:'cognee'}});tree=ui.render()
  assert.equal(findField(tree,'Куда сохранять проверенные записи').props.value,'auto')
  const options=flatten(findField(tree,'Куда сохранять проверенные записи')).filter(row=>row.type==='option').map(row=>row.props.value)
  assert.deepEqual(options,['auto','cognee'])
  findField(tree,'Режим памяти проекта').props.onChange({target:{value:'memoria'}});tree=ui.render()
  assert.equal(findField(tree,'Назначение записей проекта').props.value,'inherit')
  assert.match(text(tree),/Наследуемое назначение записи несовместимо/)
  findButton(tree,'Сохранить настройку проекта').props.onClick()
  assert.equal(saved[0].input.policy.writeTarget,'inherit')
})

test('both-store partial results retain backend names and source evidence; unavailable is not rendered as an empty successful search',()=>{
  const ui=harness('Result'),result={mode:'both',status:'partial',backends:{cognee:{status:'ok',result:{results:[{text:'<script>untrusted</script>',document_id:'doc-1'}]}},memoria:{status:'unavailable',error:'Project binding unavailable'}}}
  const rendered=ui.client.Result({result,action:'recall'}),content=text(rendered)
  assert.match(content,/Частичный ответ/);assert.match(content,/Cognee: ответ получен/);assert.match(content,/Memoria: недоступен/);assert.match(content,/doc-1/);assert.match(content,/Project binding unavailable/)
  assert.ok(content.includes('<script>untrusted</script>'))
  assert.equal(flatten(rendered).some(row=>row.props.dangerouslySetInnerHTML!==undefined),false)
  const record=text(ui.client.Result({action:'recall',result:{backend:'memoria',results:[{text:'fact',source:{recordId:'mem-1',tool:'mcp__memora__search',scopeEvidence:{namespace:'fixture'}}}]}}))
  assert.match(record,/mem-1/);assert.match(record,/mcp__memora__search/);assert.match(record,/fixture/)
  assert.match(text(ui.client.Result({action:'remember',result:{backend:'memoria',state:'stored',indexed:null}})),/Запись сохранена/)
  assert.doesNotMatch(text(ui.client.Result({action:'status',result:{backend:'memoria',connected:null}})),/Cognee доступен/)
})

test('model catalogue shows verified states, preserves unverified saved choice, and discards a response for an old provider',async()=>{
  let resolve
  const changes=[],props={kind:'embeddings',value:{provider:'ollama',model:'saved-local',endpoint:'http://127.0.0.1:11434'},busy:false,onChange:value=>changes.push(value)}
  const ui=harness('ModelSelection',props,async()=>await new Promise(done=>{resolve=done}));let tree=ui.render();ui.flush();tree=ui.render()
  assert.match(text(tree),/Сохранено: saved-local · наличие не проверено/)
  findButton(tree,'Обновить список моделей').props.onClick();await ui.settle();tree=ui.render()
  assert.equal(findButton(tree,'Обновить список моделей').props.disabled,false)
  assert.equal(findButton(tree,'Обновить список моделей').props['aria-disabled'],true)
  findField(tree,'Провайдер модели').props.onChange({target:{value:'openrouter'}})
  assert.equal(changes[0].provider,'openrouter');assert.equal(changes[0].endpoint,undefined)
  tree=ui.render({...props,value:changes[0]});ui.flush();tree=ui.render()
  resolve({ok:true,models:[{id:'old-model',state:'loaded',dimensions:768}],available:true});await ui.settle();tree=ui.render()
  assert.doesNotMatch(text(tree),/old-model/)
  findField(tree,'Размерность эмбеддингов').props.onChange({target:{value:'1536'}})
  assert.equal(changes.at(-1).dimensions,1536)
  findField(tree,'Размерность эмбеддингов').props.onChange({target:{value:'999999'}})
  assert.equal(changes.at(-1).dimensions,1536)
})

test('model preference save does not apply or start a model; applying unsaved draft is blocked',()=>{
  const saved=[],props={processing,scope:{globalWritable:true},sessionId:'lead',token:'csrf',busy:false,onSave:(action,input)=>saved.push({action,input})}
  const ui=harness('ProcessingPanel',props);let tree=ui.render();ui.flush();tree=ui.render()
  assert.match(text(tree),/совпадает с сохранённым/)
  findButton(tree,'Сохранить выбор моделей').props.onClick()
  assert.equal(saved[0].action,'processingSave');assert.equal(saved[0].input.expectedRevision,'processing-v1');assert.equal(saved[0].input.sessionId,undefined)
  const fields=flatten(tree).filter(row=>row.type?.name==='ModelSelection')
  assert.deepEqual(fields.map(row=>row.props.kind),['embeddings','extraction'])
  fields[0].props.onChange({provider:'openrouter',model:'openai/text-embedding-3-small',dimensions:1536});tree=ui.render()
  assert.equal(findButton(tree,'Применить профиль к серверу').props.disabled,true)
  assert.match(text(tree),/Сначала сохраните выбранные модели/)
  assert.equal(saved.length,1)
  const exact=ui.render({...props,processing:{...processing,profile:{...processing.profile,embeddings:{provider:'openrouter',model:'openai/text-embedding-3-small',dimensions:1536}},revision:'processing-v2'}});ui.flush();tree=ui.render()
  assert.equal(findButton(tree,'Применить профиль к серверу').props.disabled,false)
  findButton(tree,'Применить профиль к серверу').props.onClick()
  assert.equal(saved[1].action,'processingApply');assert.equal(saved[1].input.expectedRevision,'processing-v2');assert.equal(saved[1].input.confirm,true)
  assert.match(text(ui.client.Result({action:'processingApply',result:{submitted:true}})),/модели ещё не считаются активными/)
})

test('global and processing preference POSTs are independent of project authority while graph keeps explicit Cognee ownership',async()=>{
  const scope={writable:true,globalWritable:true,projectRoot:'D:/fixture'},view={ok:true,config:{enabled:true,endpoint:'http://127.0.0.1:18080',localProcessing:true},revision:'connection-v1',csrfToken:'fixture',scope,policy,processing}
  const ui=harness('Memory',{},async input=>input.action==='configuration'?view:{ok:true,nodes:[],edges:[]})
  ui.render();ui.flush();await ui.settle();let tree=ui.render()
  findButton(tree,'Граф').props.onClick();await ui.settle();tree=ui.render()
  assert.equal(ui.calls.find(row=>row.input.action==='graph').input.backend,'cognee')
  assert.equal(ui.calls.find(row=>row.input.action==='graph').input.sessionId,'standard')
  const models=flatten(tree).find(row=>row.type?.name==='ProcessingPanel')
  await models.props.onSave('processingSave',{profile:processing.profile,expectedRevision:'processing-v1'})
  assert.equal(ui.calls.find(row=>row.input.action==='processingSave').input.sessionId,undefined)
  const view2={...view,policy:{...policy,effective:{mode:'memoria',source:'project',writeTarget:'auto'}}}
  const other=harness('Memory',{},async()=>view2);other.render();other.flush();await other.settle();const limited=other.render()
  assert.equal(findButton(limited,'Граф').props.disabled,true);assert.equal(findButton(limited,'Документы').props.disabled,true)
  assert.match(text(limited),/Действует: Memoria · переопределение проекта/)
})

test('OpenRouter key is write-only, blank on mount, clears after an attempt and never echoes an exception',async()=>{
  const credential={configured:true,revision:'credential-v1',source:'native-store'},saved=[]
  let settle
  const ui=harness('CredentialPanel',{credential,token:'csrf',busy:false,onSave:async(action,input)=>{saved.push({action,input});return await new Promise(resolve=>{settle=resolve})}})
  let tree=ui.render()
  const input=findField(tree,'Новый ключ OpenRouter')
  assert.equal(input.props.type,'password');assert.equal(input.props.value,'');assert.equal(input.props.autoComplete,'new-password')
  assert.match(text(tree),/В защищённом хранилище DSH сохранён ключ/)
  input.props.onChange({target:{value:'synthetic-secret-never-render'}});tree=ui.render()
  assert.ok(!text(tree).includes('synthetic-secret-never-render'))
  findButton(tree,'Сохранить ключ OpenRouter').props.onClick();tree=ui.render()
  assert.equal(findButton(tree,'Сохранить ключ OpenRouter').props['aria-disabled'],true)
  assert.equal(saved[0].action,'processingCredentialSave');assert.equal(saved[0].input.expectedRevision,'credential-v1');assert.equal(saved[0].input.secret,'synthetic-secret-never-render')
  assert.equal(saved[0].input.sessionId,undefined)
  settle(true);await ui.settle();tree=ui.render()
  assert.equal(findField(tree,'Новый ключ OpenRouter').props.value,'')
  assert.match(text(tree),/Ключ сохранён/);assert.ok(!text(tree).includes('synthetic-secret-never-render'))
  const failing=harness('CredentialPanel',{credential,token:'csrf',busy:false,onSave:async()=>{throw new Error('synthetic-secret-exception')}})
  tree=failing.render();findField(tree,'Новый ключ OpenRouter').props.onChange({target:{value:'synthetic-secret-exception'}});tree=failing.render()
  findButton(tree,'Сохранить ключ OpenRouter').props.onClick();await failing.settle();tree=failing.render()
  assert.equal(findField(tree,'Новый ключ OpenRouter').props.value,'');assert.ok(!text(tree).includes('synthetic-secret-exception'))
  const unknown=harness('CredentialPanel',{token:'csrf',busy:false,onSave:async()=>true});tree=unknown.render()
  assert.match(text(tree),/Состояние ключа.*ещё не получено/);assert.doesNotMatch(text(tree),/ключ OpenRouter не сохранён/)
})

test('credential response is ignored instead of entering technical Result or model prompt; refresh reads only public metadata',async()=>{
  const key='synthetic-native-store-key',view={ok:true,config:{enabled:true,endpoint:'http://127.0.0.1:18080',localProcessing:true},revision:'connection-v1',csrfToken:'fixture',scope:null,policy,processing:{...processing,openRouterCredential:{configured:false,revision:'missing',source:'native-store'}}}
  const ui=harness('Memory',{},async input=>{
    if(input.action==='processingCredentialSave') {view.processing.openRouterCredential={configured:true,revision:'credential-v2',source:'native-store'};return{ok:true,secret:key,untrustedEcho:key}}
    return view
  })
  ui.render();ui.flush();await ui.settle();let tree=ui.render()
  const panel=flatten(tree).find(row=>row.type?.name==='ProcessingPanel')
  const result=await panel.props.onSave('processingCredentialSave',{secret:key,expectedRevision:'missing'});tree=ui.render()
  assert.equal(result,true)
  assert.deepEqual(ui.calls.map(row=>row.input.action),['configuration','processingCredentialSave','configuration'])
  assert.equal(ui.calls[1].method,'POST');assert.equal(ui.calls[1].input.expectedRevision,'missing');assert.equal(ui.calls[1].input.sessionId,undefined)
  assert.ok(!text(tree).includes(key));assert.ok(!JSON.stringify(flatten(tree).filter(row=>row.type?.name==='Result')).includes(key))
  assert.equal(flatten(tree).find(row=>row.type?.name==='ProcessingPanel').props.processing.openRouterCredential.configured,true)
  const failed=harness('Memory',{},async input=>input.action==='processingCredentialSave'?{ok:false,message:key}:view)
  failed.render();failed.flush();await failed.settle();tree=failed.render()
  await flatten(tree).find(row=>row.type?.name==='ProcessingPanel').props.onSave('processingCredentialSave',{secret:key,expectedRevision:'credential-v2'});tree=failed.render()
  assert.ok(!text(tree).includes(key));assert.match(text(tree),/Сохранение ключа OpenRouter не подтверждено/)
  assert.ok(!source.includes('localStorage'));assert.ok(!source.includes('sessionStorage'))
})
