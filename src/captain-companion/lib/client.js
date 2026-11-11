window.__ModuleLoader__.load({id:'airules-dsh-captain-companion',factory:require=>{
 const React=require('react'),h=React.createElement
 const API='/airules/captain-companion',DEFAULTS={schemaVersion:1,enabled:true,automatic:true,intervalSeconds:180,bubbleSeconds:12,phrases:{}}
 const CATALOG=Object.freeze({
 idle:[
  'Йо-хо-хо! Семь футов под килем и ни одной блокировки в регистре.',
  'Казна любит порядок, а капитан — запросы с параметрами.',
  'Я норвежский лесной. Дремучий код меня не пугает.',
  'В сундуке золото, в расширении — только нужные изменения.',
  'Карта сокровищ хороша, но метаданные точнее.',
  'Кто спрятал дублоны в забалансовый регистр?',
  'Попутного ветра и понятных имён переменных!',
  'Пока море спокойно, можно перечитать запрос. И почесать кота.',
  'Настоящий пират отличает сокровища от временных таблиц.',
  'Мой хвост пушист, а план запроса должен быть короток.',
  'Ром — в трюм, бизнес-логику — в подходящий модуль.',
  'Не всё, что блестит в консоли, является доказательством.',
  'Йо-хо-хо и три ведра временных таблиц!',
  'На абордаж! Но сначала ЗавершитьТранзакцию().',
  'Провести() нельзя отменить похмельем. А жаль.',
  'Селёдку — капитану, остатки — в регистр накопления.',
  'Норвежский лесной кот: зимой греет экипаж, летом пугает дедлоки.',
  'Где мой ПараметрСеанса? Я без него даже рыбу не провожу.',
  'Пока матрос спорил с Неопределено, капитан доел определённую селёдку.',
  'У каждого пирата есть Справочник.Сокровища. У меня ещё и избранное.',
  'Регистр сведений «КудаДеласьРыба» почему-то всегда пуст.',
  'Запрос.Выполнить()! Сколько можно любоваться этой картой?',
  'Двадцать дублонов за хвост! НДС сверху, шерсть в подарок.',
  'Пиратский учёт прост: Дт Сундук, Кт ЧужойСундук.'
 ],
 start:[
  'Поднять паруса! Сначала разведаем задачу, потом возьмём код на абордаж.',
  'Команда за работой. Капитан следит, чтобы не унесло в чужой контур.',
  'Курс проложен. Ищем источник истины, а не легенду о нём.',
  'На палубе работа! Проверим условия, прежде чем махать саблей.',
  'Расчехляй подзорную трубу: в коде могут прятаться рифы.',
  'Матросы заняты задачей. Я отвечаю за грозный вид и мех.'
 ],
 completion:[
  'Ход агента завершён. Добычу ещё надо сверить по описи.',
  'На мостик пришёл результат. Приёмка — по фактам, не по салюту.',
  'Паруса приспущены: агент закончил ход. Загляни в отчёт.',
  'Получен ответ. Проверка результата — отдельная статья судового журнала.',
  'Команда вернулась с докладом. Сундук пока не считаем полным.',
  'Агент завершил ход. Капитан предлагает осмотреть добычу.'
 ],
 error:[
  'Риф по курсу! Читаем ошибку, не стреляем командами наугад.',
  'Палуба скрипит. Сначала причина, потом ремонт.',
  'Поймали сбой. Ещё один слепой повтор не станет навигацией.',
  'В трюме что-то гремит. Сохраним следы и найдём источник.',
  'Ошибка — отметка на карте, а не повод затопить весь корабль.',
  'Штормит. Проверим последний шаг и условия, без лишнего героизма.'
 ],
 approval:[
  'Капитан, требуется твоё решение. Кнопки подтверждения — в штатном окне DSH.',
  'Команда ждёт приказа. Моя реплика разрешением не считается.',
  'На мостик! DSH ждёт ответа или подтверждения.',
  'Без приказа якорь не поднимать. Проверь запрос в интерфейсе.',
  'Тут нужен кожаный капитан. Я пока посторожу сундук.',
  'Поступил запрос к владельцу. Прочитай условия перед решением.'
 ],
 tests:[
  'Зелёный флаг хорош, но сначала убедись, что тест что-нибудь проверял.',
  'Exit zero — ещё не сундук с доказательствами.',
  'Без утверждений тест похож на пушку без ядра.',
  'Проверь и счастливый рейс, и близкий промах мимо маршрута.',
  'Не гоняй боевую базу по морям ради проверки формулировки.',
  'Регрессия ходит тихо. Держи проверку у затронутого борта.'
 ],
 context:[
  'После тумана сверяй карту: правила, текущий шаг и незавершённые дела.',
  'Сжатая карта не отменяет рифов. Важные правила перечитай.',
  'Перед сдачей вахты оставь журнал: что сделано и куда плыть дальше.',
  'Чужую правку за борт не бросаем. Сначала узнаём, чья она.',
  'Ленивая загрузка: берём нужную карту, а не весь адмиралтейский архив.',
  'Новый чат — новая вахта, но настройки корабля принадлежат проекту.'
 ],
 memory:[
  'В память — проверенный маршрут, а не весь шум прибоя.',
  'Cognee плетёт сеть связей. Главное — не поймать в неё догадку как факт.',
  'Memoria хранит заметки, а капитан требует источник.',
  'Два хранилища — две описи. Пустой ответ ещё не доказывает пустой трюм.',
  'Повтор старой байки не становится независимым подтверждением.',
  'Нашёл рабочий приём? Сохрани процедуру, а историю рейса оставь в журнале.'
 ]})
 const LABELS={idle:'Морские байки',start:'Начало работы',completion:'Завершение хода',error:'Сбой',approval:'Ожидание решения',tests:'Проверки',context:'Контекст',memory:'Память'}
 function category(snapshot){const pose=snapshot?.notifications?.activity?.pose;return({running:'start',waiting:'approval',failed:'error',review:'completion'})[pose]??'idle'}
 function isCaptain(snapshot){return snapshot?.config?.visible===true&&snapshot?.pet?.id==='custom:captain-diesel'}
 function createPicker(random=Math.random){const previous=new Map();return (key,overrides={})=>{const keyName=CATALOG[key]?key:'idle',lines=overrides[keyName]?.length?overrides[keyName]:CATALOG[keyName];let index=Math.min(lines.length-1,Math.max(0,Math.floor(random()*lines.length)));if(index===previous.get(keyName))index=(index+1)%lines.length;previous.set(keyName,index);return lines[index]}}
 function speechPosition(rect,viewport,hasLine=false){
  const width=Math.min(hasLine?260:86,Math.max(40,viewport.width-24)),left=Math.max(12,Math.min(viewport.width-width-12,rect.left+(rect.width-width)/2)),above=rect.top>=(hasLine?140:42),space=above?rect.top-18:viewport.height-rect.bottom-18
  return{left,width,top:above?'auto':Math.max(12,rect.bottom+6),bottom:above?Math.max(12,viewport.height-rect.top+6):'auto',maxHeight:Math.max(32,space)}
 }
 function raisePopover(node){if(typeof node?.showPopover!=='function')return false;try{if(node.matches?.(':popover-open'))node.hidePopover();node.showPopover();return true}catch{return false}}
 function createSpeechGate(now=Date.now){let last=-Infinity,lastKey='',initial=true,closed=false;const running=new Set();return{event(snapshot,config,manual=false){if(closed||!config.enabled||!isCaptain(snapshot))return null;const kind=category(snapshot),identity=snapshot?.notifications?.activity?.sessionId??'',key=identity+'|'+kind;if(kind==='start')running.add(identity);if(initial&&!manual){initial=false;lastKey=key;return null}if(kind==='completion'&&!manual&&!running.has(identity)){lastKey=key;return null}if(kind==='completion')running.delete(identity);initial=false;if(!manual&&(!config.automatic||key===lastKey||now()-last<20000)){lastKey=key;return null}lastKey=key;last=now();return kind},idle(snapshot,config){if(closed||!config.enabled||!config.automatic||!isCaptain(snapshot)||category(snapshot)!=='idle'||now()-last<config.intervalSeconds*1000)return null;last=now();return'idle'},dispose(){closed=true}}}
 const styles=`.ad-captain-settings{display:flex;flex-direction:column;gap:13px;font-size:13px;line-height:1.5;min-width:0}.ad-captain-settings h2,.ad-captain-settings p{margin:0}.ad-captain-settings h2{font-size:24px}.ad-captain-settings label{display:flex;gap:9px;align-items:center;flex-wrap:wrap}.ad-captain-settings textarea{width:100%;min-height:110px;resize:vertical;font:inherit}.ad-captain-settings input[type=number],.ad-captain-settings select,.ad-captain-settings textarea{min-height:34px;background:var(--dsw-alias-bg-input,#141a2b);color:inherit;border:1px solid #566489;border-radius:7px;padding:6px;max-width:100%}.ad-captain-settings button,.ad-captain-speech button{border:1px solid #566489;background:var(--dsw-alias-bg-input,#141a2b);color:inherit;border-radius:7px;padding:7px 10px;cursor:pointer;font:inherit}.ad-captain-settings button:disabled{opacity:.5;cursor:default}.ad-captain-toolbar{display:flex;flex-wrap:wrap;gap:8px}.ad-captain-preview{padding:14px;border:1px solid #566489;border-radius:10px;min-height:62px}.ad-captain-speech{position:fixed;inset:auto;margin:0;padding:0;border:0;background:transparent;overflow:auto;z-index:2147483001;color:var(--dsw-alias-label-primary,#e5e8f0);font:12px/1.5 system-ui;pointer-events:auto;max-width:260px}.ad-captain-speech aside{padding:12px 30px 12px 13px;background:var(--dsw-alias-bg-popover,#1a2237);border:1px solid #65779c;border-radius:14px;box-shadow:0 5px 22px #0004;overflow-wrap:anywhere}.ad-captain-speech aside strong{display:block;font-size:12px;margin-bottom:4px}.ad-captain-speech .ad-close{position:absolute;right:4px;top:3px;border:0;background:transparent;padding:4px 7px}.ad-captain-speech .ad-quip{font-size:11px;padding:3px 7px;margin-top:4px}.ad-captain-settings :focus-visible,.ad-captain-speech :focus-visible{outline:2px solid #7fa2ff;outline-offset:3px}@media(prefers-reduced-motion:reduce){.ad-captain-speech *{animation:none!important;transition:none!important}}`
 async function request(body,token){const response=await fetch(API,body?{method:'POST',headers:{'content-type':'application/json','x-airules-csrf':token},body:JSON.stringify(body)}:{}),data=await response.json();if(!response.ok||!data.ok)throw Error(data.error??'CAPTAIN_UNAVAILABLE');return data}
 function createSettings(){let snapshot={config:{...DEFAULTS},revision:null,csrfToken:null,error:'',loading:true};const listeners=new Set();const publish=value=>{snapshot={...snapshot,...value};for(const fn of listeners)fn()};return{getSnapshot:()=>snapshot,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},async refresh(){try{publish({...await request(),loading:false,error:''})}catch(error){publish({loading:false,error:error.message})}},async save(config){const data=await request({config,revision:snapshot.revision},snapshot.csrfToken);publish({...data,error:''});return data}}}
 function useProvider(){const[snapshot,setSnapshot]=React.useState(()=>window.dshPet?.getSnapshot?.()??null);React.useEffect(()=>{let off;const bind=()=>{off?.();off=undefined;const api=window.dshPet;if(api?.version===1){setSnapshot(api.getSnapshot());off=api.subscribe(setSnapshot)}else setSnapshot(null)};bind();window.addEventListener('dsh-pet-ready',bind);window.addEventListener('dsh-pet-disposed',bind);return()=>{off?.();window.removeEventListener('dsh-pet-ready',bind);window.removeEventListener('dsh-pet-disposed',bind)}},[]);return snapshot}
 function Overlay({store}){
  const state=React.useSyncExternalStore(store.subscribe,store.getSnapshot),snapshot=useProvider(),[line,setLine]=React.useState(''),[position,setPosition]=React.useState(null),[sequence,setSequence]=React.useState(0),picker=React.useRef(createPicker()),gate=React.useRef(createSpeechGate()),timer=React.useRef(null),latest=React.useRef(null),layer=React.useRef(null)
  latest.current={snapshot,config:state.config,line};const present=text=>{if(typeof text!=='string'||!text.trim()||text.length>240)return;clearTimeout(timer.current);setLine(text);setSequence(value=>value+1);timer.current=setTimeout(()=>setLine(''),(latest.current?.config?.bubbleSeconds??12)*1000)}
  const speak=kind=>present(picker.current(kind==='idle'?['idle','idle','idle','tests','context','memory'][Math.floor(Math.random()*6)]:kind,latest.current?.config?.phrases))
  React.useEffect(()=>{const kind=gate.current.event(snapshot,state.config);if(kind)speak(kind)},[snapshot,state.config])
  React.useEffect(()=>{if(!state.config.enabled||!isCaptain(snapshot)){clearTimeout(timer.current);setLine('');setPosition(null)}},[state.config.enabled,snapshot?.config?.visible,snapshot?.pet?.id])
  React.useEffect(()=>{const preview=event=>{const current=latest.current;if(current.config.enabled&&isCaptain(current.snapshot))present(event.detail?.text)};window.addEventListener('airules-captain-preview',preview);return()=>window.removeEventListener('airules-captain-preview',preview)},[])
  React.useEffect(()=>{gate.current=createSpeechGate();let previousModal=null;const tick=()=>{const current=latest.current;if(document.visibilityState!=='visible'||!current.config.enabled||!isCaptain(current.snapshot)){setPosition(null);return}const node=document.querySelector('.dcp-floating .dcp-pet-button'),rect=node?.getBoundingClientRect();if(!rect||rect.width<=0||rect.height<=0){setPosition(null);return}const next=speechPosition(rect,{width:window.innerWidth,height:window.innerHeight},!!current.line);setPosition(previous=>previous&&Object.keys(next).every(key=>previous[key]===next[key])?previous:next);const modal=document.querySelector('dialog[open]');if(modal!==previousModal){previousModal=modal;raisePopover(layer.current)}const kind=gate.current.idle(current.snapshot,current.config);if(kind)speak(kind)};const id=setInterval(tick,250);tick();return()=>{clearInterval(id);clearTimeout(timer.current);gate.current.dispose()}},[])
  React.useLayoutEffect(()=>{const node=layer.current;if(!node)return;const rect=document.querySelector('.dcp-floating .dcp-pet-button')?.getBoundingClientRect();if(rect?.width>0){const next=speechPosition(rect,{width:window.innerWidth,height:window.innerHeight},!!line);setPosition(previous=>previous&&Object.keys(next).every(key=>previous[key]===next[key])?previous:next)}raisePopover(node);return()=>{try{if(node.matches?.(':popover-open'))node.hidePopover()}catch{}}},[line,sequence,!!position])
  if(!position||!state.config.enabled||!isCaptain(snapshot))return null
  return h('div',{className:'ad-captain-speech',popover:'manual',ref:layer,style:position},line&&h('aside',{'aria-live':'polite',role:'status'},h('strong',null,'Капитан Дизель'),line,h('button',{className:'ad-close',type:'button','aria-label':'Скрыть реплику Капитана',onClick:()=>{clearTimeout(timer.current);setLine('')}},'×')),h('button',{className:'ad-quip',type:'button',title:'Новая пиратско-1Сная реплика',onClick:()=>speak(category(snapshot))},'⚓ Реплика'))
 }
 function Panel({store}){
  const state=React.useSyncExternalStore(store.subscribe,store.getSnapshot),snapshot=useProvider(),[draft,setDraft]=React.useState(state.config),[busy,setBusy]=React.useState(false),[notice,setNotice]=React.useState(''),[preview,setPreview]=React.useState(''),[kind,setKind]=React.useState('idle'),picker=React.useRef(createPicker())
  React.useEffect(()=>setDraft({...state.config}),[state.revision]);const change=(key,value)=>setDraft({...draft,[key]:value})
  function previewPhrase(){const text=picker.current(kind,draft.phrases);setPreview(text);window.dispatchEvent(new CustomEvent('airules-captain-preview',{detail:{text}}));setNotice(isCaptain(snapshot)&&state.config.enabled?'Реплика показана рядом с Капитаном.':'Предпросмотр ниже. Чтобы увидеть пузырь, включите реплики и покажите Капитана.')}
  async function save(){setBusy(true);try{await store.save(draft);setNotice('Сохранено. Реплики работают локально и не расходуют токены.')}catch(error){setNotice(error.message)}finally{setBusy(false)}}
  async function showCaptain(){setBusy(true);try{if(!window.dshPet?.updateConfig)throw Error('Сначала включите плагин Pets.');await window.dshPet.updateConfig({selected:'custom:captain-diesel',visible:true});setNotice('Капитан выбран и показан. Его прежние размер и положение сохранены.')}catch(error){setNotice(error.message)}finally{setBusy(false)}}
  return h('section',{className:'ad-captain-settings'},h('h2',null,'Капитан Дизель'),h('p',null,'Норвежский лесной кот-пират и хранитель регистров. Реплики из локального каталога: без модели, отправки в чат и расхода токенов.'),h('p',null,snapshot?isCaptain(snapshot)?'Капитан на палубе.':'Pets доступен; Капитан скрыт или выбран другой персонаж.':'Ожидается плагин Pets.'),
   h('label',null,h('input',{type:'checkbox',checked:draft.enabled,disabled:busy,onChange:e=>change('enabled',e.target.checked)}),'Включить реплики Капитана'),h('label',null,h('input',{type:'checkbox',checked:draft.automatic,disabled:busy,onChange:e=>change('automatic',e.target.checked)}),'Автоматические реплики по событиям и в ожидании'),
   h('label',null,'Пауза между байками в ожидании, секунд',h('input',{type:'number',min:30,max:1800,value:draft.intervalSeconds,disabled:busy,onChange:e=>change('intervalSeconds',Number(e.target.value))})),h('label',null,'Показывать реплику, секунд',h('input',{type:'number',min:5,max:30,value:draft.bubbleSeconds,disabled:busy,onChange:e=>change('bubbleSeconds',Number(e.target.value))})),
   h('div',{className:'ad-captain-toolbar'},h('button',{type:'button',disabled:busy||state.loading||!!state.error,onClick:save},'Сохранить'),h('button',{type:'button',disabled:busy||!snapshot,onClick:showCaptain},'Показать Капитана')),
   h('label',null,'Тема реплики',h('select',{value:kind,onChange:e=>setKind(e.target.value)},Object.keys(CATALOG).map(key=>h('option',{value:key,key},LABELS[key])))),h('label',null,'Свои реплики для выбранной темы: одна строка — одна реплика',h('textarea',{rows:6,value:(draft.phrases?.[kind]??[]).join('\n'),maxLength:3000,disabled:busy,onChange:e=>change('phrases',{...(draft.phrases??{}),[kind]:e.target.value.split(/\r?\n/u)})})),h('p',null,'До 12 строк по 240 символов на тему. Пустое поле возвращает встроенный набор. Это только текст пузыря; команды и инструкции не исполняются.'),h('button',{type:'button',onClick:previewPhrase},'Проверить реплику'),h('div',{className:'ad-captain-preview',role:'status','aria-live':'polite'},preview||'Выберите тему и попросите Капитана высказаться.'),h('p',null,'В ожидании автоматические реплики появляются с выбранной паузой (по умолчанию 180 секунд). Кнопка «Проверить реплику» сразу показывает текст и пузырь рядом с Капитаном. Завершение хода не означает успешный тест или деплой. Капитан не подтверждает операции и не нажимает кнопки за пользователя. Настройки общие для этой установки DSH.'),h('p',{role:'status'},state.error||notice))
 }
 return{CATALOG,LABELS,category,isCaptain,createPicker,speechPosition,raisePopover,createSpeechGate,createSettings,inject:['slots'],apply(ctx){const store=createSettings();ctx.effect(()=>{void store.refresh()});ctx.slots.inject('settings.section',()=>ctx.slots.register({name:'settings.section',id:'airules-captain-companion',label:()=> 'Капитан Дизель',order:74},()=>h(Panel,{store})));ctx.slots.inject('shell.overlay',()=>ctx.slots.register({name:'shell.overlay',id:'airules-captain-companion',order:102},()=>h(React.Fragment,null,h('style',null,styles),h(Overlay,{store}))))}}
}})
