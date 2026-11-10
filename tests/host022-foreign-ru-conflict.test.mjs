import test from'node:test'
import assert from'node:assert/strict'
import{readFile,access}from'node:fs/promises'
import{join,resolve}from'node:path'
import vm from'node:vm'
const native=resolve('var/host-upgrade/rc022/asar/dsh/node_modules/@deepseek-ai')
const foreignRoot=process.env.AIRULES_FOREIGN_RU_ROOT??'C:/Users/S0lo/.dsh/profiles/desktop/node_modules/@ragnoryok1/dsh-client-locale-ru'
const available=await access(join(foreignRoot,'lib/client.js')).then(()=>true,()=>false)
async function fixture(){
 let loaded;const realm=vm.createContext({window:{__ModuleLoader__:{load:row=>loaded=row.factory(()=>({}))}},navigator:{languages:['ru'],language:'ru'},console:{warn(){}}})
 const load=source=>{vm.runInContext(source,realm,{timeout:5000});return loaded}
 const localePlugin=load(await readFile(join(native,'dsh-client-locale/lib/client.js'),'utf8'));let locale;const stop=Error('native dictionaries registered')
 await assert.rejects(localePlugin.apply({emit(){},effect(fn){return fn()},configForms:{get(){}},provide(_name,value){locale=value},slots:{installLocale(){throw stop}}}),error=>error===stop)
 return{load,locale}
}
test('installed old foreign RU bundle preclaims native theme namespace and reproduces 022 boot failure', {skip:!available},async()=>{
 const f=await fixture(),foreign=f.load(await readFile(join(foreignRoot,'lib/client.js'),'utf8'))
 foreign.apply({locale:f.locale,effect(fn){return fn()}},{plurals:false,typography:false,pluginNames:false})
 assert.equal(f.locale.dicts.get('settings.theme').has('ru'),true)
 const theme=f.load(await readFile(join(native,'dsh-client-ui-theme/lib/client.js'),'utf8'))
 assert.throws(()=>theme.apply({locale:f.locale,effect(fn,label){if(label==='ui-theme: settings row dictionaries')fn()}}),error=>error.message==='locale namespace "settings.theme" already has locale "ru"')
})
test('native022 plus managedUI5 RU, without old foreign bundle, keeps native theme admission intact',async()=>{
 const f=await fixture(),managed=f.load(await readFile('dist/airules-ui-overlay-0.13.0-host022-ui5/payload/packages/airules-dsh-russian-localization/lib/client.js','utf8'))
 managed.apply({locale:f.locale,effect(fn){return fn()}})
 assert.equal(f.locale.dicts.get('settings.theme')?.has('ru')??false,false)
 const theme=f.load(await readFile(join(native,'dsh-client-ui-theme/lib/client.js'),'utf8')),stop=Error('native theme dictionaries registered')
 assert.throws(()=>theme.apply({locale:f.locale,effect(fn,label){if(label==='ui-theme: settings row dictionaries'){fn();throw stop}}}),error=>error===stop)
 assert.equal(f.locale.dicts.get('settings.theme').has('ru'),true)
})
