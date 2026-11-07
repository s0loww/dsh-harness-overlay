window.__ModuleLoader__.load({id:'airules-dsh-provider-extensions',factory:require=>{
  const React=require('react'),h=React.createElement
  const DRIVER_PROVIDERS=[{id:'google',name:'Google Gemini · Antigravity ACP'},{id:'muse',name:'Meta Muse · ACP'}]
  const errors={DRIVER_SETUP_REQUIRED:'Сначала укажите установленный runtime.',DRIVER_DIGEST_MISMATCH:'SHA-256 файла не совпадает. Проверьте выбранный runtime.',DRIVER_DIGEST_REQUIRED:'Нужен SHA-256 из доверенного манифеста установленного runtime.',DRIVER_ACP_REGISTRY_REQUIRED:'Нужен один установленный адаптер «Внешние агенты ACP».',DRIVER_LOGIN_REQUIRED:'Выполните отдельный вход в этой карточке.',DRIVER_AUTH_FAILED:'Вход не завершён. Проверьте runtime и повторите.',DRIVER_BUSY:'Дождитесь входа или отмените его.'}
  function DriverSettings({providerId}={}){
    const [selected,setSelected]=React.useState(providerId??'google'),id=providerId??selected
    const [state,setState]=React.useState(null),[busy,setBusy]=React.useState(false),[error,setError]=React.useState('')
    const [command,setCommand]=React.useState(''),[digest,setDigest]=React.useState(''),[args,setArgs]=React.useState('[]'),[callback,setCallback]=React.useState('')
    const csrf=React.useRef(''),epoch=React.useRef(0)
    const request=React.useCallback(async action=>{
      const generation=++epoch.current;setBusy(true);setError('')
      try {
        const response=await fetch('/airules/provider-drivers',{method:action?'POST':'GET',credentials:'same-origin',mode:'same-origin',headers:{accept:'application/json',...(action?{'content-type':'application/json','x-dsh-csrf':csrf.current}:{})},...(action?{body:JSON.stringify(action)}:{}),signal:AbortSignal.timeout(45000)})
        const data=await response.json();if(!response.ok||!data.ok)throw new Error(data.error)
        if(epoch.current===generation){csrf.current=data.csrfToken;setState(data)}
      } catch(err){if(epoch.current===generation)setError(errors[err.message]??'Операция не выполнена. Проверьте настройки runtime и обновите состояние.')}
      finally {if(epoch.current===generation)setBusy(false)}
    },[])
    React.useEffect(()=>{void request();return()=>{epoch.current++}},[request])
    const row=state?.providers?.find(value=>value.id===id)
    React.useEffect(()=>{setCommand(row?.config?.command??'');setDigest(row?.config?.sha256??'');setArgs(JSON.stringify(row?.config?.args??[]));setCallback('')},[id,row?.config?.command,row?.config?.sha256])
    React.useEffect(()=>{if(row?.phase!=='pending')return;const timer=setInterval(()=>{void request()},2500);return()=>clearInterval(timer)},[row?.phase,request])
    const act=action=>request({action,provider:id})
    function configure(){try{const parsed=JSON.parse(args);if(!Array.isArray(parsed))throw new Error();void request({action:'configure',provider:id,config:{command,sha256:digest,args:parsed}})}catch{setError('Аргументы должны быть JSON-массивом строк.')}}
    return h('section',{style:{display:'grid',gap:12},'aria-label':'Runtime подписки'},
      !providerId&&h('select',{value:selected,onChange:e=>setSelected(e.target.value)},...DRIVER_PROVIDERS.map(p=>h('option',{value:p.id,key:p.id},p.name))),
      h('h3',null,DRIVER_PROVIDERS.find(p=>p.id===id)?.name),
      h('p',null,id==='google'?'Используется установленный Antigravity ACP runtime Google. Обычный Gemini CLI не подходит.':'Используется установленный Muse CLI: MSP для входа и каталога, ACP для работы.'),
      h('p',{role:'status'},!row?'Статус неизвестен':row.phase==='pending'?'Ожидаем подтверждение входа…':row.phase==='stopping'?'Закрываем процесс входа…':row.enabled?'Включён в каталоге ACP':row.connected?'Вход подтверждён; можно включить ACP':row.configured?'Runtime настроен; проверьте вход':'Нужно настроить runtime'),
      h('label',null,'Полный путь к установленному исполняемому файлу',h('input',{value:command,disabled:busy||row?.phase==='pending',onChange:e=>setCommand(e.target.value)})),
      h('label',null,'SHA-256 из доверенного манифеста runtime',h('input',{value:digest,disabled:busy||row?.phase==='pending',onChange:e=>setDigest(e.target.value)})),
      id==='google'&&h('label',null,'Аргументы запуска ACP (JSON)',h('input',{value:args,disabled:busy||row?.phase==='pending',onChange:e=>setArgs(e.target.value)})),
      h('div',null,h('button',{disabled:busy||!row||row.phase==='pending'||!command||!/^[a-f0-9]{64}$/.test(digest),onClick:configure},'Проверить и сохранить runtime'),' ',
        h('button',{disabled:busy||!row?.configured||row.phase==='pending',onClick:()=>act('login')},'Войти отдельно'),' ',
        h('button',{disabled:busy||row?.phase!=='pending',onClick:()=>act('cancel')},'Отменить вход'),' ',
        h('button',{disabled:busy||!row?.configured||row.phase==='pending',onClick:()=>act('check')},'Проверить вход'),' ',
        h('button',{disabled:busy||!row?.configured||!row?.connected||row?.enabled,onClick:()=>act('enable')},'Включить ACP'),' ',
        h('button',{disabled:busy||!row?.enabled,onClick:()=>act('disable')},'Выключить ACP'),' ',
        h('button',{disabled:busy||!row?.configured||row.phase==='pending',onClick:()=>act('logout')},id==='muse'?'Отключить локальный вход':'Выйти'),' ',
        h('button',{disabled:busy,onClick:()=>request()},'Обновить статус')),
      row?.notice&&h('div',null,h('a',{href:row.notice.url,target:'_blank',rel:'noopener noreferrer'},'Открыть подтверждение входа'),row.notice.code&&h('p',null,'Код: ',h('code',null,row.notice.code))),
      row?.manualCallback&&h('label',null,'Итоговый адрес localhost после входа Google',h('input',{type:'password',autoComplete:'off',value:callback,onChange:e=>setCallback(e.target.value)}),h('button',{disabled:busy||!callback,onClick:()=>{void request({action:'callback',provider:id,callback});setCallback('')}},'Передать адрес')),
      (error||row?.error)&&h('p',{role:'alert'},error||errors[row.error]||'Вход не подтверждён. Повторите настройку.'),
      h('small',null,'Runtime автоматически не скачивается. Создаётся отдельный профиль DSH; существующие аккаунты CLI не импортируются. Генерация идёт через штатный ACP: нужны режим разработки и Native Agent Access. Ключи API из окружения не передаются. MCP проекта эта карточка не изменяет. Выход Muse отсоединяет локальный профиль и сохраняет защищённый резервный каталог; доступ на стороне Meta не отзывается.'))
  }
  return {DRIVER_PROVIDERS,DriverSettings,inject:['slots'],apply(ctx){ctx.slots.inject('settings.section',()=>ctx.slots.register({name:'settings.section',id:'airules-provider-drivers',order:93,label:()=> 'Google / Muse · runtime'},DriverSettings))}}
}})
