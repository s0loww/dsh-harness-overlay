window.__ModuleLoader__.load({ id: 'airules-dsh-onec-panels', factory: require => {
  const React = require('react'), h = React.createElement
  function Icon() { return h('span', { 'aria-hidden': true }, '1С') }
  const workbenchApi='/airules/onec-workbench'
  async function workbenchRequest(input,token){
    const response=await fetch(token?workbenchApi:`${workbenchApi}?${new URLSearchParams(input)}`,token?{method:'POST',headers:{'content-type':'application/json','x-airules-csrf':token},body:JSON.stringify(input)}:{headers:{accept:'application/json'}})
    const result=await response.json();if(!response.ok||!result.ok)throw new Error(result.error||'Не удалось получить данные.');return result
  }
  function GraphView({graph}){
    const [selected,setSelected]=React.useState('')
    React.useEffect(()=>setSelected(''),[graph?.callId])
    if(!graph)return h('section',null,h('h3',null,'Результат графового запроса'),h('p',null,'Выполните запрос связей через подключённый MCP в чате. Здесь появится диаграмма его ответа. Отдельный движок памяти эта панель не подключает.'))
    const points=new Map(graph.nodes.map((node,index)=>[node.id,{x:450+345*Math.cos(2*Math.PI*index/Math.max(1,graph.nodes.length)),y:260+200*Math.sin(2*Math.PI*index/Math.max(1,graph.nodes.length))}]))
    const chosen=graph.nodes.find(node=>node.id===selected)
    const related=graph.edges.filter(edge=>edge.from===selected||edge.to===selected)
    return h('section',null,h('h3',null,'Результат графового запроса'),h('p',null,`${graph.nodes.length} узлов / ${graph.edges.length} связей · ${graph.tool}${graph.project?` · ${graph.project}`:''}`),
      (graph.truncated||graph.degraded)&&h('p',{role:'status'},'Ответ неполный или ограничен. Диаграмма не доказывает полноту связей проекта.'),
      h('svg',{viewBox:'0 0 900 520',role:'img','aria-label':'Связи объектов из результата MCP',style:{width:'100%',minHeight:200}},
        graph.edges.map((edge,index)=>{const a=points.get(edge.from),b=points.get(edge.to);return h('line',{key:`edge-${index}`,x1:a.x,y1:a.y,x2:b.x,y2:b.y,stroke:selected&&(edge.from===selected||edge.to===selected)?'#79a4ff':'#667180',strokeWidth:selected&&(edge.from===selected||edge.to===selected)?2:1},h('title',null,`${edge.from} → ${edge.to}: ${edge.label}`))}),
        graph.nodes.map(node=>{const point=points.get(node.id);return h('g',{key:node.id,onClick:()=>setSelected(node.id),tabIndex:0,role:'button','aria-label':node.label,onKeyDown:event=>{if(event.key==='Enter'||event.key===' ')setSelected(node.id)}},h('circle',{cx:point.x,cy:point.y,r:node.id===selected?9:6,fill:node.id===selected?'#ffd074':'#79a4ff'}),h('title',null,node.label),(graph.nodes.length<=35||node.id===selected)&&h('text',{x:point.x+9,y:point.y+4,fill:'currentColor',fontSize:10},node.label.slice(0,22)))})),
      h('select',{'aria-label':'Объект графа',value:selected,onChange:event=>setSelected(event.target.value)},h('option',{value:''},'Выберите объект…'),graph.nodes.map(node=>h('option',{key:node.id,value:node.id},node.label))),
      chosen&&h('div',null,h('p',null,`${chosen.label}${chosen.type?` · ${chosen.type}`:''}`),h('ul',null,related.map((edge,index)=>h('li',{key:index},`${edge.from} → ${edge.to}: ${edge.label}`)))),graph.cursor&&h('p',null,'У источника есть продолжение ответа; запросите следующую часть в чате.'))
  }
  function WorkbenchPanel({sessionId}){
    const [data,setData]=React.useState(null),[error,setError]=React.useState(''),[busy,setBusy]=React.useState(false)
    const generation=React.useRef(0),sequence=React.useRef(0)
    const load=React.useCallback(async()=>{const epoch=generation.current,request=++sequence.current;try{if(!sessionId)throw new Error('Выберите сеанс проекта 1С.');const next=await workbenchRequest({sessionId});if(epoch===generation.current&&request===sequence.current){setData(next);setError('')}}catch(reason){if(epoch===generation.current&&request===sequence.current)setError(reason.message)}},[sessionId])
    React.useEffect(()=>{generation.current++;setData(null);void load();const timer=setInterval(()=>void load(),3000);return()=>{clearInterval(timer);generation.current++}},[load])
    async function cancel(job){if(!window.confirm('Запросить отмену этого задания? Отмена не откатывает уже выполненные действия.'))return;setBusy(true);try{await workbenchRequest({action:'cancel',sessionId,jobId:job.id,confirm:true},data.csrfToken);await load()}catch(reason){setError(reason.message)}finally{setBusy(false)}}
    return h('div',{className:'airules-onec-panel'},h('h2',null,'Связи и операции'),h('button',{disabled:busy||!sessionId,onClick:()=>void load()},'Обновить'),error&&h('p',{role:'alert'},error),h(GraphView,{graph:data?.graph}),h('h3',null,'Фоновые задания'),
      data?.jobs?.length?h('ul',null,data.jobs.map(job=>h('li',{key:job.id},h('strong',null,job.kind),` · ${{running:'выполняется',stopping:'отмена запрошена',completed:'завершено',failed:'ошибка',killed:'остановлено'}[job.status]??job.status} · ${job.id}`,job.progress&&h('p',null,job.progress),['running','stopping'].includes(job.status)&&h('button',{disabled:busy||job.status==='stopping',onClick:()=>void cancel(job)},job.status==='stopping'?'Отмена запрошена':'Отменить')))):h('p',null,'Здесь появятся задания этого сеанса, переведённые в фон.'))
  }
  function BackgroundSettings(){
    const [data,setData]=React.useState(null),[names,setNames]=React.useState(''),[minutes,setMinutes]=React.useState(30),[error,setError]=React.useState(''),[busy,setBusy]=React.useState(false)
    React.useEffect(()=>{let live=true;workbenchRequest({action:'configuration'}).then(value=>{if(live){setData(value);setNames(value.config.readOnlyTools.join('\n'));setMinutes(value.config.timeoutMs/60000)}},reason=>{if(live)setError(reason.message)});return()=>{live=false}},[])
    async function save(){setBusy(true);setError('');try{const result=await workbenchRequest({action:'configuration',expectedRevision:data.config.revision,config:{readOnlyTools:names.split(/[\s,]+/).filter(Boolean),timeoutMs:Math.round(Number(minutes)*60000)}},data.csrfToken);setData(result)}catch(reason){setError(reason.message)}finally{setBusy(false)}}
    return h('div',{className:'airules-onec-panel'},h('h2',null,'Долгие операции'),h('p',null,'Фоновые задания доступны в панели «Связи и операции». Оболочка использует свои штатные настройки таймаута. Для MCP отдельно разрешите проверенные методы чтения; агент сможет запускать их в фоне и получать результат через список заданий.'),
      h('label',null,'Проверенные MCP-инструменты только чтения',h('textarea',{rows:5,value:names,placeholder:'mcp__server__read_tool',onChange:event=>setNames(event.target.value)})),h('label',null,'Предел ожидания MCP, минут',h('input',{type:'number',min:1/60,max:30,step:1,value:minutes,onChange:event=>setMinutes(event.target.value)})),
      h('button',{disabled:busy||!data,onClick:()=>void save()},busy?'Сохранение…':'Сохранить'),error&&h('p',{role:'alert'},error))
  }
  function Panel({ sessionId }) {
    const [data, setData] = React.useState(null), [detail, setDetail] = React.useState(null), [error, setError] = React.useState(''), [loading, setLoading] = React.useState(false)
    const generation = React.useRef(0), request = React.useRef(0)
    const load = React.useCallback(async path => {
      const epoch = generation.current, sequence = ++request.current
      setError(''); setLoading(true)
      if (path) setDetail(null)
      try {
        if (!sessionId) throw new Error('Выберите сеанс проекта 1c-airules.')
        const response = await fetch(`/airules/onec-panels?sessionId=${encodeURIComponent(sessionId)}${path ? `&path=${encodeURIComponent(path)}` : ''}`, { headers: { accept: 'application/json' } })
        const body = await response.json()
        if (!response.ok || !body.ok) throw new Error(body.message || 'Метаданные недоступны.')
        if (generation.current === epoch && sequence === request.current) path ? setDetail(body) : setData(body)
      } catch (reason) { if (generation.current === epoch && sequence === request.current) setError(reason.message) }
      finally { if (generation.current === epoch && sequence === request.current) setLoading(false) }
    }, [sessionId])
    React.useEffect(() => { generation.current++; setData(null); setDetail(null); load(); return () => { generation.current++ } }, [load])
    const list = (items, render) => h('ul', null, ...items.map((item, i) => h('li', { key: i }, render(item))))
    const inspect = detail && h('section', null, h('h3', null, detail.path), h('p', null, `${detail.bytes} байт · сводка исходного XML`), h('h4', null, 'Объекты'), list(detail.objects, item => `${item.type}: ${item.name}`), h('h4', null, 'Элементы формы'), list(detail.elements, item => `${item.type}: ${item.name}${item.id ? ` (#${item.id})` : ''}`), h('h4', null, 'События'), list(detail.events, item => `${item.name}: ${item.handler}`), detail.truncated && h('p', null, 'Сводка ограничена по глубине и числу элементов.'))
    return h('div', { className: 'airules-onec-panel' }, h('h2', null, 'Метаданные 1С'), h('p', null, 'Объекты XML/EDT, пути модулей и структура форм из рабочей папки выбранного сеанса. Сводка формы показывает исходную структуру; вид в клиенте 1С зависит от платформы.'), h('button', { type: 'button', disabled: loading || !sessionId, onClick: () => { setDetail(null); load() } }, loading ? 'Чтение…' : 'Обновить'), error && h('p', { role: 'alert' }, error), data && h(React.Fragment, null, h('p', null, `Проверено XML: ${data.scannedXml}; записей: ${data.scannedEntries}.${data.truncated ? ' Показан ограниченный результат; уточняйте структуру проекта в редакторе.' : ''}`), h('h3', null, 'Объекты и формы'), data.files.length ? list(data.files, item => h('button', { type: 'button', onClick: () => load(item.path), disabled: loading }, `${item.objects.map(object => `${object.type}: ${object.name}`).join(', ') || item.path} · ${item.path}`)) : h('p', null, 'XML/EDT-метаданные в пределах поиска не найдены.'), h('h3', null, 'Модули BSL'), list(data.modules, item => item), data.warnings.length > 0 && h('p', null, `Пропущено файлов: ${data.warnings.length}. Ограничения размера, XML или безопасного пути.`)), inspect)
  }
  function apply(ctx) {
    ctx.effect(() => { const tag = document.createElement('style'); tag.textContent = '.airules-onec-panel{padding:16px;overflow:auto;max-height:100%;color:var(--dsw-alias-label-primary);font-size:13px;overflow-wrap:anywhere}.airules-onec-panel p{line-height:1.5}.airules-onec-panel label{display:grid;gap:6px;margin:12px 0}.airules-onec-panel input,.airules-onec-panel textarea,.airules-onec-panel select{font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);padding:8px;border-radius:6px;max-width:100%;box-sizing:border-box}.airules-onec-panel textarea{width:100%}.airules-onec-panel button{color:inherit;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:6px 8px;text-align:left;cursor:pointer}.airules-onec-panel li{margin:5px 0}.airules-onec-panel button:disabled{opacity:.6}.airules-onec-panel button:focus-visible{outline:2px solid currentColor}'; document.head.appendChild(tag); return () => tag.remove() })
    ctx.inject(['sidebarRight', 'sidebarRightTabs'], ready => {
      const id = 'airules-dsh-onec-panels/metadata', kind = 'airules-onec-metadata'
      ready.effect(() => ready.get('sidebarRightTabs').register({ id, kind, title: () => 'Метаданные 1С', icon: Icon, guide: [{ order: 30, title: () => 'Метаданные 1С', icon: Icon }] }))
      ready.effect(() => ready.slots.inject('sidebar.right.pane.tab', () => ready.slots.register({ name: 'sidebar.right.pane.tab', key: id }, ({ sessionId }) => h(Panel, { key: sessionId, sessionId }))))
      const workbenchId='airules-dsh-onec-panels/workbench'
      ready.effect(()=>ready.get('sidebarRightTabs').register({id:workbenchId,kind:'airules-onec-workbench',title:()=> 'Связи и операции',icon:Icon,guide:[{order:31,title:()=> 'Связи и операции',icon:Icon}]}))
      ready.effect(()=>ready.slots.inject('sidebar.right.pane.tab',()=>ready.slots.register({name:'sidebar.right.pane.tab',key:workbenchId},({sessionId})=>h(WorkbenchPanel,{key:sessionId,sessionId}))))
    })
    ctx.slots.inject('settings.section',()=>ctx.slots.register({name:'settings.section',id:'airules-onec-background',label:()=> 'Долгие операции',order:30},BackgroundSettings))
  }
  return { inject: ['slots'], apply, GraphView, WorkbenchPanel, BackgroundSettings }
} })
