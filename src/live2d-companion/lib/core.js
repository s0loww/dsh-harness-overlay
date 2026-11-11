import {createHash, randomUUID} from 'node:crypto'
import {readFileSync, writeFileSync, mkdirSync, lstatSync, realpathSync, renameSync, unlinkSync} from 'node:fs'
import {dirname, resolve} from 'node:path'
export const MODELS=Object.freeze({Miara:'Miara/miara_pro_t03.model3.json',Hiyori:'Hiyori/hiyori_pro_t11.model3.json'})
export const DEFAULT_CONFIG=Object.freeze({enabled:false,model:'Miara',height:220,corner:'br',notifications:true,lookAtCursor:true,phrases:{}})
export const DEFAULT_PHRASES=Object.freeze({
 Miara:{idle:['Пусть мысли плывут спокойно.','Я рядом, пока складывается замысел.','На тихой воде хорошо видны новые идеи.'],working:['Собираю созвездие из маленьких шагов.','Работа движется своим течением.','Пока вы строите решение, я берегу спокойствие.'],waiting:['Здесь нужен ваш выбор.','Жду вашего решения в чате.','Сделаем паузу: дальше нужен ваш ответ.'],complete:['Ход завершён. Заглянем в результат?','Ещё один маленький причал достигнут. Подробности — в чате.','Можно выдохнуть: этот ход окончен.'],error:['Кажется, течение изменилось. Ошибка описана в чате.','Здесь встретился подводный камень. Посмотрим сообщение об ошибке.','Небольшой шторм. Подробности доступны в чате.'],stopped:['Пауза — тоже часть пути.','Работа остановлена. Я остаюсь рядом.','Остановились, чтобы выбрать следующий шаг.']},
 Hiyori:{idle:['Есть идея? Давайте попробуем!','Я на месте. Какой план?','Новая задача уже машет нам рукой.'],working:['Поехали! Шаг за шагом.','Держим темп — задача в работе!','Работа кипит. Заглянем в чат чуть позже.'],waiting:['Ваш ход! Нужен ответ в чате.','Секундочку: DSH ждёт вашего решения.','Дальше — после вашего подтверждения.'],complete:['Ход окончен! Смотрим, что получилось.','Готово с этим ходом. Проверки и результат — в чате.','Есть финиш хода! Подробности уже в чате.'],error:['Ой, препятствие! Ошибка — в чате.','План споткнулся. Посмотрим подробности ошибки.','Нужен новый заход: сначала разберём ошибку.'],stopped:['Стоп принят. Переведём дух!','Остановились. Следующий ход — за вами.','Пауза! Вернёмся с новым планом.']}
})
export const PHASES=Object.freeze(['idle','working','waiting','complete','error','stopped'])
export function phrasesFor(config,model,phase){const custom=config.phrases?.[model]?.[phase];return custom?.length?custom:DEFAULT_PHRASES[model]?.[phase]??[]}
export function choosePhrase(values,last,random=Math.random){const candidates=values.filter(value=>value!==last),pool=candidates.length?candidates:values;return pool[Math.min(pool.length-1,Math.max(0,Math.floor(random()*pool.length)))]??''}
function validatePhrases(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)fail('LIVE2D_CONFIG_INVALID')
 const result={};for(const [model,phases]of Object.entries(value)){
  if(!Object.hasOwn(MODELS,model)||!phases||typeof phases!=='object'||Array.isArray(phases)||Object.getPrototypeOf(phases)!==Object.prototype)fail('LIVE2D_CONFIG_INVALID')
  result[model]={};for(const [phase,lines]of Object.entries(phases)){
   if(!PHASES.includes(phase)||!Array.isArray(lines)||lines.length>12||lines.some(line=>typeof line!=='string'||!line.trim()||line.length>240||/[\r\n]/u.test(line)))fail('LIVE2D_CONFIG_INVALID')
   result[model][phase]=lines.map(line=>line.trim())
  }
 }
 return result
}
const fail=code=>{throw Error(code)}
export function validateConfig(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!Object.hasOwn(DEFAULT_CONFIG,k)))fail('LIVE2D_CONFIG_INVALID')
 const config={...DEFAULT_CONFIG,...value}
 if(typeof config.enabled!=='boolean'||typeof config.notifications!=='boolean'||typeof config.lookAtCursor!=='boolean'||!Object.hasOwn(MODELS,config.model)||!Number.isInteger(config.height)||config.height<160||config.height>420||!['bl','br','tl','tr'].includes(config.corner))fail('LIVE2D_CONFIG_INVALID')
 config.phrases=validatePhrases(config.phrases)
 if(Buffer.byteLength(JSON.stringify(config,null,2)+'\n','utf8')>32768)fail('LIVE2D_CONFIG_INVALID')
 return config
}
const key=p=>process.platform==='win32'?resolve(p).toLowerCase():resolve(p)
export function createConfigStore(file){
 const directory=dirname(file),hash=bytes=>createHash('sha256').update(bytes).digest('hex')
 function guard(){let at=directory;const paths=[];while(true){paths.unshift(at);const parent=dirname(at);if(parent===at)break;at=parent}for(const path of paths){try{const stat=lstatSync(path);if(!stat.isDirectory()||stat.isSymbolicLink()||key(realpathSync(path))!==key(path))fail('LIVE2D_CONFIG_PATH_INVALID')}catch(error){if(error.code!=='ENOENT')throw error}}}
 function read(){guard();try{const stat=lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>32768)fail('LIVE2D_CONFIG_INVALID');const bytes=readFileSync(file);if(bytes.length>32768)fail('LIVE2D_CONFIG_INVALID');return{config:validateConfig(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes).replace(/^\uFEFF/u,''))),revision:hash(bytes)}}catch(error){if(error.code==='ENOENT')return{config:{...DEFAULT_CONFIG},revision:'missing'};throw error}}
 function save(config,revision){config=validateConfig(config);guard();mkdirSync(directory,{recursive:true});guard();const lock=file+'.lock',temp=file+'.'+randomUUID()+'.tmp';let locked=false;try{try{writeFileSync(lock,'live2d-config',{flag:'wx',mode:0o600});locked=true}catch(error){if(error.code==='EEXIST')fail('LIVE2D_CONFIG_BUSY');throw error}const before=read();if(before.revision!==revision)fail('LIVE2D_CONFIG_STALE');const bytes=JSON.stringify(config,null,2)+'\n';writeFileSync(temp,bytes,{flag:'wx',mode:0o600});if(read().revision!==revision)fail('LIVE2D_CONFIG_STALE');guard();renameSync(temp,file);return read()}finally{try{unlinkSync(temp)}catch{}if(locked)try{unlinkSync(lock)}catch{}}}
 return{read,save}
}
export function phaseForEvent(session,event){
 if(!session?.id||session.header?.origin==='subagent'||session.header?.parentSession||session.header?.parentSessionId)return null
 let phase
 if(event?.type==='turn/start'||event?.type==='tool/call')phase='working'
 else if(event?.type==='approval/asked')phase='waiting'
 else if(event?.type==='approval/decided'){
  const outcome=event.data?.outcome
  if(outcome==='cancelled')phase='stopped'
  else if(['allowed-once','rejected','unavailable'].includes(outcome))phase='working'
 }else if(event?.type==='turn/end'){
  const kind=event.data?.reason?.kind
  phase=kind==='completed'?'complete':kind==='error'?'error':'stopped'
 }
 if(!phase)return null
 // Only closed task phase vocabulary; never copy approval reasons, errors or content.
 return{sessionId:session.id,phase}
}
