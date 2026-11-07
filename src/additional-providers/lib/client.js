window.__ModuleLoader__.load({ id: 'airules-dsh-additional-providers', factory: require => {
  const React = require('react'), h = React.createElement
  function Providers() {
    const [state, setState] = React.useState(null), [busy, setBusy] = React.useState(false), [error, setError] = React.useState('')
    const csrf = React.useRef('')
    const refresh = React.useCallback(async action => {
      setBusy(true)
      try {
        const response = await fetch('/airules/additional-providers', { method: action ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', headers: { accept: 'application/json', ...(action ? { 'content-type': 'application/json', 'x-dsh-csrf': csrf.current } : {}) }, ...(action ? { body: JSON.stringify({ action }) } : {}), signal: AbortSignal.timeout(15000) })
        const body = await response.json(); if (!response.ok || !body.ok) throw new Error('FAILED')
        csrf.current = body.csrfToken; setState(body); setError('')
      } catch { setState(null); setError('Не удалось получить состояние. Обновите статус.') } finally { setBusy(false) }
    }, [])
    React.useEffect(() => { void refresh() }, [refresh])
    React.useEffect(() => { if (state?.phase !== 'pending') return; const timer = setInterval(() => { void refresh() }, 2500); return () => clearInterval(timer) }, [state?.phase, refresh])
    return h('section', { style: { display: 'grid', gap: 12, padding: 16 }, 'aria-label': 'Дополнительные провайдеры' },
      h('h3', null, 'Дополнительные провайдеры · Kimi Code'),
      h('p', null, 'Отдельный вход в подписку Kimi. Аккаунты из CLI и других установок не импортируются.'),
      h('p', { role: 'status' }, !state ? 'Статус неизвестен' : state.connected === true ? 'Подписка подключена' : state.phase === 'pending' ? 'Ожидаем подтверждения…' : 'Вход не выполнен'),
      error || state?.error ? h('p', { role: 'alert' }, error || 'Вход не завершён. Повторите подключение.') : null,
      state?.notice ? h('div', null, h('a', { href: state.notice.url, target: '_blank', rel: 'noopener noreferrer' }, 'Открыть подтверждение Kimi'), h('p', null, 'Код: ', h('code', null, state.notice.code))) : null,
      h('div', null,
        h('button', { disabled: busy || !state || state.connected || state.phase === 'pending', onClick: () => refresh('login') }, 'Подключить Kimi'),
        h('button', { disabled: busy || state?.phase !== 'pending', onClick: () => refresh('cancel') }, 'Отменить вход'),
        h('button', { disabled: busy || state?.connected !== true, onClick: () => refresh('logout') }, 'Отключить'),
        h('button', { disabled: busy, onClick: () => refresh() }, 'Обновить статус')),
      h('p', null, 'После подключения выберите «Kimi Code · отдельная подписка» в списке моделей. Один аккаунт; ротация и статистика квот пока не перенесены.'))
  }
  const PLAN_SUBSCRIPTIONS=[
    {id:'airules-zai-plan',name:'GLM · Coding Plan'},
    {id:'airules-qwen-plan',name:'Qwen Token Plan · International'},
    {id:'airules-opencode-go',name:'OpenCode Go'},
  ]
  function ApiPlanSettings({providerId}={}) {
    const [selected,setSelected]=React.useState(providerId??PLAN_SUBSCRIPTIONS[0].id), [state,setState]=React.useState(null)
    const [key,setKey]=React.useState(''), [busy,setBusy]=React.useState(false), [error,setError]=React.useState(''), [notice,setNotice]=React.useState('')
    const csrf=React.useRef(''), epoch=React.useRef(0), id=providerId??selected
    const refresh=React.useCallback(async()=>{
      const current=++epoch.current;setBusy(true);setError('')
      try {
        const response=await fetch('/airules/additional-provider-plans',{credentials:'same-origin',mode:'same-origin',headers:{accept:'application/json'},signal:AbortSignal.timeout(15000)})
        const data=await response.json();if(!response.ok||!data.ok)throw new Error('FAILED')
        if(epoch.current===current){csrf.current=data.csrfToken;setState(data)}
      } catch {if(epoch.current===current){setState(null);setError('Не удалось получить состояние плана. Обновите статус.')}}
      finally {if(epoch.current===current)setBusy(false)}
    },[])
    React.useEffect(()=>{void refresh();return()=>{epoch.current++}},[refresh])
    React.useEffect(()=>{setKey('');setNotice('');setError('')},[id])
    const row=state?.providers?.find(value=>value.id===id)
    async function action(operation) {
      if(!row)return
      const current=++epoch.current;setBusy(true);setError('');setNotice('')
      try {
        const response=await fetch('/airules/additional-provider-plans',{method:'POST',credentials:'same-origin',mode:'same-origin',headers:{'content-type':'application/json','x-dsh-csrf':csrf.current},
          body:JSON.stringify({action:operation,provider:id,revision:row.revision,...(operation==='save'?{key}:{})}),signal:AbortSignal.timeout(15000)})
        const data=await response.json();if(!response.ok||!data.ok)throw new Error(data.error==='PLAN_STALE'?'STALE':'FAILED')
        if(epoch.current===current){csrf.current=data.csrfToken;setState(data);setKey('');setNotice(operation==='save'?'Ключ сохранён. Модели доступны в каталоге.':'Ключ отключён. Новые запросы этого плана заблокированы.')}
      } catch(err) {if(epoch.current===current)setError(err.message==='STALE'?'Настройки уже изменились. Обновите статус и повторите.':'Не удалось сохранить настройку. Проверьте ввод и обновите статус.')}
      finally {if(epoch.current===current)setBusy(false)}
    }
    return h('section',{className:'airulesApiPlanSettings',style:{display:'grid',gap:12},'aria-label':'Планы по ключу'},
      !providerId&&h('label',null,'План',h('select',{value:selected,disabled:busy,onChange:event=>setSelected(event.target.value)},...PLAN_SUBSCRIPTIONS.map(value=>h('option',{key:value.id,value:value.id},value.name)))),
      h('h3',null,PLAN_SUBSCRIPTIONS.find(value=>value.id===id)?.name??'План'),
      h('p',null,'Введите ключ своего аккаунта этого плана. Ключ хранится в штатном защищённом хранилище DSH; аккаунты, переменные окружения и настройки CLI не импортируются.'),
      h('p',{role:'status'},!row?'Статус неизвестен':!row.available?'Провайдер отсутствует в установленном runtime':row.connected?'Ключ подключён':'Ключ не подключён'),
      row?.available&&h('small',null,`В нативном каталоге: ${row.modelCount} моделей. Доступ конкретной модели определяет ваш план.`),
      h('label',null,'Ключ плана',h('input',{type:'password',autoComplete:'off',spellCheck:false,value:key,disabled:busy||!row?.available,onChange:event=>setKey(event.target.value),placeholder:row?.connected?'Новый ключ для замены':'Введите ключ плана'})),
      h('div',null,h('button',{disabled:busy||!row?.available||key.trim().length<8,onClick:()=>action('save')},'Сохранить ключ'),' ',h('button',{disabled:busy||!row?.connected,onClick:()=>action('logout')},'Отключить'),' ',h('button',{disabled:busy,onClick:refresh},'Обновить статус')),
      error&&h('p',{role:'alert'},error),notice&&h('p',{role:'status'},notice),
      h('small',null,'Один аккаунт на план. Автоматическая ротация и сведения об остатке квот не заявляются; подключение ключа само не выполняет сетевой запрос.'))
  }
  return { KimiSettings: Providers, ApiPlanSettings, PLAN_SUBSCRIPTIONS, inject: ['slots'], apply(ctx) {
    ctx.slots.inject('settings.section', () => ctx.slots.register({name:'settings.section',id:'airules-api-plans',order:92,label:()=> 'Планы GLM / Qwen / OpenCode'},ApiPlanSettings))
    ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'airules-kimi', order: 91, label: () => 'Kimi Code' }, Providers))
  } }
} })
