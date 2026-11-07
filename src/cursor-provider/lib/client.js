window.__ModuleLoader__.load({id:'airules-dsh-cursor-provider',factory:require=>{
  const React=require('react'),h=React.createElement,path='/airules/cursor-provider'
  function CursorSettings(){
    const[state,setState]=React.useState(),[packageRoot,setRoot]=React.useState(''),[busy,setBusy]=React.useState(false),[error,setError]=React.useState('')
    const request=async body=>{setBusy(true);setError('');try{const response=await fetch(path,{method:body?'POST':'GET',headers:body?{'content-type':'application/json','x-dsh-csrf':state?.csrfToken??''}:{},...(body?{body:JSON.stringify(body)}:{})});const value=await response.json();if(!response.ok||!value.ok)throw new Error();setState(value)}catch{setError('Не удалось выполнить действие Cursor. Проверьте внешний SDK и повторите.')}finally{setBusy(false)}}
    React.useEffect(()=>{request()},[])
    React.useEffect(()=>{if(!['starting','waiting'].includes(state?.phase))return;const timer=setInterval(()=>request(),2000);return()=>clearInterval(timer)},[state?.phase])
    return h('section',null,h('h3',null,'Cursor · подписка через внешний SDK'),h('p',null,'SDK 1.0.38 устанавливается отдельно. CLI-профили и переменные окружения не импортируются. Запросы выполняются только в BUILD с полным нативным доступом.'),
      h('label',null,'Каталог пакета @cursor/sdk',h('input',{value:packageRoot,onChange:e=>setRoot(e.target.value),placeholder:'C:\\Tools\\cursor-runtime\\node_modules\\@cursor\\sdk',disabled:busy})),
      h('button',{disabled:busy||!state||!packageRoot,onClick:()=>request({action:'inspect',packageRoot})},'Проверить SDK'),
      state?.inspected&&h('div',null,h('p',null,`${state.inspected.version} · SHA-256 ${state.inspected.sha256}`),h('button',{disabled:busy,onClick:()=>request({action:'configure',packageRoot:state.inspected.packageRoot,sha256:state.inspected.sha256})},'Доверять этому SDK')),
      h('p',null,state?.connected?'Подписка подключена':'Подписка не подключена'),state?.runtime&&h('small',null,'Внешний runtime: '+state.runtime.packageRoot),
      h('div',null,h('button',{disabled:busy||!state?.runtime||['starting','waiting'].includes(state?.phase),onClick:()=>request({action:'login'})},'Войти в Cursor'),' ',h('button',{disabled:busy,onClick:()=>request({action:'cancel'})},'Отменить вход'),' ',h('button',{disabled:busy||!state?.connected,onClick:()=>request({action:'refresh'})},'Обновить модели'),' ',h('button',{disabled:busy||!state?.connected,onClick:()=>request({action:'logout'})},'Отключить')),
      state?.authorizeUrl&&h('a',{href:state.authorizeUrl,target:'_blank',rel:'noopener noreferrer'},'Подтвердить вход на cursor.com'),
      h('p',{role:'status'},`${state?.phase??'Загрузка'} · Моделей: ${state?.models?.length??0}`),state?.error&&h('p',{role:'alert'},state.error),error&&h('p',{role:'alert'},error))
  }
  return{CursorSettings,inject:[],apply(){}}
}})
