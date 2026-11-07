window.__ModuleLoader__.load({ id: 'airules-dsh-model-orchestration', factory: require => {
  const React = require('react'), h = React.createElement
  const roles = ['analytic','arch-reviewer','architect','code-reviewer','developer','doc-writer','error-fixer','explorer','metadata-manager','performance-optimizer','planner','refactoring','tester']
  const labels = { analytic:'Аналитик', 'arch-reviewer':'Ревью архитектуры', architect:'Архитектор', 'code-reviewer':'Ревью кода', developer:'Разработчик', 'doc-writer':'Документация', 'error-fixer':'Исправление ошибок', explorer:'Исследование проекта', 'metadata-manager':'Метаданные', 'performance-optimizer':'Оптимизация', planner:'Планирование', refactoring:'Рефакторинг', tester:'Тестирование' }
  const key = value => value ? JSON.stringify([value.provider,value.model]) : ''
  const parse = value => { const [provider,model] = JSON.parse(value); return {provider,model} }
  const style = { font: 'inherit', padding: '6px 9px', border: '1px solid var(--dsw-alias-border-l2, #777)', borderRadius: 6, background: 'var(--dsw-alias-bg-layer-1, transparent)', color: 'inherit', minWidth: 0, maxWidth: '100%' }
  function Settings({ rotation }) {
    const [settings,setSettings] = React.useState(null), [catalog,setCatalog] = React.useState([]), [error,setError] = React.useState(''), [busy,setBusy] = React.useState(false), [saved,setSaved] = React.useState(false)
    const csrf = React.useRef('')
    const request = React.useCallback(async action => {
      setBusy(true); setSaved(false)
      try {
        const response = await fetch('/airules/model-orchestration', { method: action ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', headers: { accept:'application/json', ...(action ? { 'content-type':'application/json', 'x-dsh-csrf':csrf.current } : {}) }, ...(action ? {body:JSON.stringify(action)} : {}), signal:AbortSignal.timeout(25000) })
        const body = await response.json(); if (!response.ok || !body.ok) throw new Error('REQUEST_REJECTED')
        csrf.current = body.csrfToken
        if (action?.action !== 'catalog') setSettings(body.settings)
        if (body.catalog) setCatalog(body.catalog)
        if (action?.action === 'save') setSaved(true)
        setError(''); return body
      } catch { setError('Настройки не сохранены или каталог недоступен. Проверьте подключение моделей, совместимость пула и обновите страницу.'); return null } finally { setBusy(false) }
    }, [])
    React.useEffect(() => { void request().then(body => { if (body) void request({action:'catalog'}) }) }, [request])
    const update = change => { setSettings(old => change(JSON.parse(JSON.stringify(old)))); setSaved(false) }
    const picker = (value, onChange, allowInherit = true, forPool = false) => {
      const available = catalog.filter(row => !forPool || row.provider !== 'airules-rotation')
      const choices = [...available]
      if (!forPool) for (const pool of settings.pools.filter(row => row.enabled)) if (!choices.some(row => row.provider === 'airules-rotation' && row.model === pool.id)) choices.push({provider:'airules-rotation',providerName:'Ротация',model:pool.id,name:pool.name})
      if (value && !choices.some(row => key(row) === key(value))) choices.push({...value,name:'Недоступно: '+value.provider+' / '+value.model,providerName:'Сохранённая модель'})
      return h('select', {style,value:key(value),disabled:busy,onChange:event => onChange(event.target.value ? parse(event.target.value) : null)},
        h('option',{value:''},allowInherit?'Наследовать текущую модель':'Выберите модель'),
        ...choices.map(row => h('option',{key:key(row),value:key(row)},(row.providerName||row.provider)+' · '+row.name)))
    }
    const poolChange = (id, fn) => update(next => { fn(next.pools.find(row => row.id===id)); return next })
    return h('section',{style:{display:'grid',gap:14,padding:16}},
      h('h3',null,rotation?'Ротация моделей':'Модели для ролей 1С'),
      h('p',null,rotation?'Выключено по умолчанию. Новый чат получает модель по очереди; после первого ответа модель фиксируется для всего чата. Пулы предназначены для текста. Изображения отправляйте прямой модели.':'13 ролей из project_rules. Привязка применяется инструментом airules_delegate к реальному native spawn; airules_role остаётся справочником persona.'),
      error?h('p',{role:'alert'},error):null, saved?h('p',{role:'status'},'Сохранено. Новые привязки действуют на следующие делегирования; работающие субагенты сохраняют свою модель.'):null,
      h('div',null,h('button',{style,disabled:busy,onClick:()=>request({action:'catalog'})},'Обновить каталог'),h('button',{style,disabled:busy||!settings,onClick:()=>request({action:'save',settings})},'Сохранить настройки')),
      !settings?h('p',{role:'status'},'Загрузка настроек…'):rotation?h(React.Fragment,null,
        ...settings.pools.map(pool=>h('fieldset',{key:pool.id,style:{display:'grid',gap:10,border:'1px solid var(--dsw-alias-border-l2, #777)',borderRadius:8,padding:12}},
          h('legend',null,pool.name),
          h('label',null,'Название ',h('input',{style,value:pool.name,onChange:event=>poolChange(pool.id,row=>{row.name=event.target.value})})),
          h('label',null,h('input',{type:'checkbox',checked:pool.enabled,onChange:event=>poolChange(pool.id,row=>{row.enabled=event.target.checked})}),' Включить пул для новых чатов'),
          h('label',null,h('input',{type:'checkbox',checked:pool.failover,onChange:event=>poolChange(pool.id,row=>{row.failover=event.target.checked})}),' Пробовать следующую модель при временной ошибке до первого вывода'),
          h('p',null,'Только один провайдер и адаптер с подтверждённым общим протоколом: PiAiAdapter или OpenAI OAuth Codex. Auth/policy/context ошибки и частичный ответ не повторяются. Каждая попытка может расходовать квоту.'),
          ...pool.routes.map((row,index)=>h('div',{key:key(row)},h('span',null,(index+1)+'. '+row.provider+' / '+row.model+' '),h('button',{style,onClick:()=>poolChange(pool.id,p=>{p.routes.splice(index,1)})},'Убрать'))),
          picker(null,row=>{if(row)poolChange(pool.id,p=>{if(!p.routes.some(existing=>key(existing)===key(row)))p.routes.push(row)})},false,true),
          h('button',{style,onClick:()=>update(next=>{next.pools=next.pools.filter(row=>row.id!==pool.id);return next})},'Удалить пул'))),
        h('button',{style,disabled:busy||settings.pools.length>=24,onClick:()=>update(next=>{next.pools.push({id:'pool-'+Date.now().toString(36),name:'Новый пул',enabled:false,failover:false,routes:[]});return next})},'Добавить пул')):
        h('div',{style:{display:'grid',gap:12}},...roles.map(id=>{
          const selected=settings.roles[id], metadata=catalog.find(row=>key(row)===key(selected)), efforts=metadata?.efforts??[]
          return h('div',{key:id,style:{display:'grid',gridTemplateColumns:'minmax(130px, 1fr) minmax(220px, 2fr) minmax(120px, 1fr)',gap:10,alignItems:'center'}},
            h('label',null,labels[id],h('small',{style:{display:'block',opacity:.65}},id)),
            picker(selected,row=>update(next=>{if(row)next.roles[id]=row;else delete next.roles[id];return next})),
            selected?h('select',{style,value:selected.reasoningEffort??'',disabled:busy,onChange:event=>update(next=>{if(event.target.value)next.roles[id].reasoningEffort=event.target.value;else delete next.roles[id].reasoningEffort;return next})},h('option',{value:''},'Effort модели'),...efforts.map(e=>h('option',{key:e.id,value:e.id},e.name)),selected.reasoningEffort&&!efforts.some(e=>e.id===selected.reasoningEffort)?h('option',{value:selected.reasoningEffort},selected.reasoningEffort+' (сохранено)'):null):h('span',null,'Из родителя'))
        })))
  }
  const RoleModelsSettings=()=>h(Settings,{rotation:false}), RotationSettings=()=>h(Settings,{rotation:true})
  return { RoleModelsSettings, RotationSettings, inject:['slots'],apply(ctx){ctx.slots.inject('settings.section',()=>{
    const stopRoles=ctx.slots.register({name:'settings.section',id:'airules-role-models',order:94,label:()=> 'Модели для ролей 1С'},RoleModelsSettings)
    const stopRotation=ctx.slots.register({name:'settings.section',id:'airules-model-rotation',order:95,label:()=> 'Ротация моделей'},RotationSettings)
    return()=>{stopRoles?.();stopRotation?.()}
  })} }
} })
