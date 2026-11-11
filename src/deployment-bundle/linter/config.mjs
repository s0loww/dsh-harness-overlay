import {readFile,mkdir,unlink,writeFile} from 'node:fs/promises'
import {join,resolve,dirname,isAbsolute} from 'node:path'
import {absolute,safeRelative,guard,state,same,json,writeAtomic,writeJson,seal,validSeal,fail,pathKey} from '../lib/fs.mjs'

const SETTINGS='bsl-linter/settings.json',EDITOR='bsl-editor/plugin-config.json',DEFAULT_CONFIG='bsl-linter/bsl-language-server.json'
const fileBytes=value=>Buffer.from(JSON.stringify(value,null,2)+'\n')
const plain=v=>v&&typeof v==='object'&&!Array.isArray(v)
const safeArgs=value=>Array.isArray(value)&&value.length<=64&&value.every(v=>typeof v==='string'&&v.length<=8192&&!/[\0\r\n]/u.test(v))
const textPath=value=>typeof value==='string'&&isAbsolute(value)&&!/[\0\r\n]/u.test(value)
async function executable(path){if(!textPath(path)||(await state(path)).type!=='file')fail('DEPLOY_LINTER_COMMAND_UNAVAILABLE')}
function defaults(ctx){
 const c=ctx.manifest.components.linter,java=safeRelative(ctx.bundleRoot,c.java),jar=safeRelative(ctx.bundleRoot,c.jar),command=safeRelative(ctx.bundleRoot,c.command)
 return{schemaVersion:1,java:{command:java,home:dirname(dirname(java))},bsl:{command:java,jar,args:['-Dfile.encoding=UTF-8','-Dserver.address=127.0.0.1','-Xms128m','-Xmx1g','-jar',jar,'lsp']},cli:{command},defaults:{configuration:join(ctx.dshHome,...DEFAULT_CONFIG.split('/'))}}
}
async function validateSettings(value){
 if(!plain(value)||value.schemaVersion!==1||!plain(value.java)||!plain(value.bsl)||!plain(value.cli)||!safeArgs(value.bsl.args)||!textPath(value.java.home)||!textPath(value.bsl.jar)||!textPath(value.cli.command))fail('DEPLOY_LINTER_SETTINGS_INVALID')
 await executable(value.java.command);await executable(value.bsl.command);await executable(value.cli.command)
 if(pathKey(value.bsl.command)===pathKey(value.java.command))await executable(value.bsl.jar)
 return value
}
async function editorPreferences(value,settings){
 if(!plain(value))fail('DEPLOY_LINTER_EDITOR_INVALID')
 if(value.lspEnabled!==undefined&&typeof value.lspEnabled!=='boolean'||value.interceptChatOpen!==undefined&&typeof value.interceptChatOpen!=='boolean'||value.serverPort!==undefined&&(!Number.isSafeInteger(value.serverPort)||value.serverPort<1024||value.serverPort>65535)||value.sourceExtensions!==undefined&&(!Array.isArray(value.sourceExtensions)||value.sourceExtensions.some(v=>!['.bsl','.os'].includes(v)))||value.serverArgs!==undefined&&!safeArgs(value.serverArgs)||value.serverMode!==undefined&&!['modern','legacy'].includes(value.serverMode)||value.bundledRuntime!==undefined&&typeof value.bundledRuntime!=='boolean')fail('DEPLOY_LINTER_EDITOR_INVALID')
 const custom=value.serverBin!==undefined&&value.serverBin!==''
 if(custom)await executable(value.serverBin)
 return{lspEnabled:true,interceptChatOpen:true,serverPort:8025,sourceExtensions:['.bsl','.os'],...value,serverBin:custom?value.serverBin:settings.bsl.command,serverArgs:custom?(value.serverArgs??[]):settings.bsl.args.slice(0,-1),serverMode:custom?(value.serverMode??'legacy'):'modern',bundledRuntime:custom?(value.bundledRuntime??false):true}
}
/** Machine defaults only. No project, MCP, PATH or registry file is edited. */
export async function configureLinter(ctx){
 if(ctx.manifest.components?.linter?.enabled!==true)return{status:'not-configured',reason:'component-disabled'}
 const home=absolute(ctx.dshHome),backup=join(absolute(ctx.stateRoot),'components','linter',ctx.deploymentId,...(ctx.purpose==='candidate'?['candidate']:[])),receiptPath=join(backup,'receipt.json')
 const target=join(home,...SETTINGS.split('/')),beforeSettings=await state(target),oldSettings=await json(target,{maxBytes:256*1024}),base=defaults(ctx)
 const selected=oldSettings?await validateSettings(oldSettings):await validateSettings(base)
 const editor=join(home,...EDITOR.split('/')),beforeEditor=await state(editor);let oldEditor=await json(editor,{maxBytes:256*1024}),legacyImported=false
 if(!oldEditor&&!ctx.skipLegacy&&ctx.purpose!=='candidate'){
  const legacyPath=ctx.legacyEditorConfigPath===null?null:ctx.legacyEditorConfigPath??(process.env.LOCALAPPDATA?join(process.env.LOCALAPPDATA,'dsh-bsl-editor/plugin-config.json'):null)
  if(legacyPath){const legacy=await json(absolute(legacyPath),{maxBytes:256*1024});if(legacy){oldEditor=legacy;legacyImported=true}}
 }
 const desiredEditor=await editorPreferences(oldEditor??{},selected),editorBytes=fileBytes(desiredEditor),config=join(home,...DEFAULT_CONFIG.split('/')),beforeConfig=await state(config),rows=[]
 if(beforeSettings.type==='missing')rows.push({path:SETTINGS,before:beforeSettings,data:fileBytes(selected)})
 if(!same(beforeEditor,{type:'file',bytes:editorBytes.length,sha256:(await import('../lib/fs.mjs')).sha(editorBytes)}))rows.push({path:EDITOR,before:beforeEditor,data:editorBytes})
 if(beforeConfig.type==='missing')rows.push({path:DEFAULT_CONFIG,before:beforeConfig,data:fileBytes({language:'ru',sendErrors:'never'})})
 else{const existing=await json(config,{maxBytes:256*1024});if(!existing)fail('DEPLOY_LINTER_CONFIG_INVALID')}
 const {sha}=await import('../lib/fs.mjs');const receipt={schemaVersion:1,kind:'deployment-linter-config',status:'prepared',dshHome:home,backupRoot:backup,legacyImported,rows:rows.map(({data,...r})=>({...r,after:{type:'file',bytes:data.length,sha256:sha(data)},written:false}))}
 await mkdir(backup,{recursive:true});await guard(backup)
 for(const row of rows){if(row.before.type==='file'){const p=safeRelative(backup,'before/'+row.path);await mkdir(dirname(p),{recursive:true});await guard(p);await writeFile(p,await readFile(safeRelative(home,row.path)),{flag:'wx',mode:0o600});if(!same(await state(p),row.before))fail('DEPLOY_LINTER_BACKUP_CHANGED')}}
 await writeJson(receiptPath,seal(receipt))
 try{
  for(const[i,row]of rows.entries()){const p=safeRelative(home,row.path);if(!same(await state(p),row.before))fail('DEPLOY_LINTER_SETTINGS_CHANGED');await writeAtomic(p,row.data,{expected:row.before});receipt.rows[i].written=true;await writeJson(receiptPath,seal(receipt))}
  receipt.status='applied';await writeJson(receiptPath,seal(receipt));return{status:'configured',receiptPath,files:rows.length,legacyImported,settingsPath:target,editorPath:editor,projectSettingsChanged:false}
 }catch(error){receipt.status='interrupted';await writeJson(receiptPath,seal(receipt)).catch(()=>{});error.receiptPath=receiptPath;error.componentReceipt={receiptPath};throw error}
}
export async function rollbackLinter(ctx){
 const receiptPath=absolute(ctx.componentReceipt.receiptPath),receipt=await json(receiptPath),home=absolute(ctx.dshHome),backup=join(absolute(ctx.stateRoot),'components','linter',ctx.deploymentId,...(ctx.purpose==='candidate'?['candidate']:[]))
 if(!validSeal(receipt)||receipt.kind!=='deployment-linter-config'||!['applied','interrupted','rolling-back'].includes(receipt.status)||pathKey(receipt.dshHome)!==pathKey(home)||pathKey(receipt.backupRoot)!==pathKey(backup)||pathKey(receiptPath)!==pathKey(join(backup,'receipt.json'))||!Array.isArray(receipt.rows)||receipt.rows.some(r=>![SETTINGS,EDITOR,DEFAULT_CONFIG].includes(r.path))||new Set(receipt.rows.map(r=>r.path)).size!==receipt.rows.length)fail('DEPLOY_LINTER_RECEIPT_INVALID')
 const rows=receipt.rows.filter(r=>!r.restored)
 for(const row of rows){const current=await state(safeRelative(home,row.path));if(same(current,row.before)){row.restored=true;continue}if(!same(current,row.after))fail('DEPLOY_LINTER_ROLLBACK_CONFLICT')}
 receipt.status='rolling-back';await writeJson(receiptPath,seal(receipt))
 for(const row of [...rows].reverse()){if(row.restored)continue;const target=safeRelative(home,row.path);if(!same(await state(target),row.after))fail('DEPLOY_LINTER_ROLLBACK_CONFLICT');if(row.before.type==='missing')await unlink(target);else{const saved=safeRelative(backup,'before/'+row.path);if(!same(await state(saved),row.before))fail('DEPLOY_LINTER_BACKUP_CHANGED');await writeAtomic(target,await readFile(saved),{expected:row.after})}row.restored=true;await writeJson(receiptPath,seal(receipt))}
 receipt.status='rolled-back';await writeJson(receiptPath,seal(receipt));return{status:'rolled-back',projectSettingsPreserved:true}
}
/** Child-process environment only; explicit parent overrides retain priority. */
export async function getLinterEnvironment({bundleRoot,manifest,dshHome,env=process.env}){
 if(manifest.components?.linter?.enabled!==true)return{}
 const settings=await json(join(absolute(dshHome),...SETTINGS.split('/')),{maxBytes:256*1024})??defaults({bundleRoot:absolute(bundleRoot),manifest,dshHome:absolute(dshHome)})
 await validateSettings(settings)
 const delta={ONEC_BSL_LS_BUNDLED:'0'}
 if(!env.JAVA_HOME)delta.JAVA_HOME=settings.java.home
 if(env.ONEC_BSL_LS_COMMAND){await executable(env.ONEC_BSL_LS_COMMAND);if(env.ONEC_BSL_LS_ARGS!==undefined){let args;try{args=JSON.parse(env.ONEC_BSL_LS_ARGS)}catch{fail('DEPLOY_LINTER_ENV_INVALID')}if(!safeArgs(args))fail('DEPLOY_LINTER_ENV_INVALID')}else delta.ONEC_BSL_LS_ARGS='[]'}
 else{if(env.ONEC_BSL_LS_ARGS!==undefined)fail('DEPLOY_LINTER_ENV_COMMAND_REQUIRED');delta.ONEC_BSL_LS_COMMAND=settings.bsl.command;delta.ONEC_BSL_LS_ARGS=JSON.stringify(settings.bsl.args);const packaged=defaults({bundleRoot:absolute(bundleRoot),manifest,dshHome:absolute(dshHome)});if(pathKey(settings.bsl.command)===pathKey(packaged.bsl.command)&&pathKey(settings.bsl.jar)===pathKey(packaged.bsl.jar))delta.ONEC_BSL_LS_BUNDLED='1'}
 return delta
}
