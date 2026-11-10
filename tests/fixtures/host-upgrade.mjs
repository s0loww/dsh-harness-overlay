import {mkdir,writeFile,readFile,rm} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {randomUUID} from 'node:crypto'
import {HOST_UPGRADE_ROOT} from '../../scripts/upgrade-official-host.mjs'
import {PROMOTION_BACKUPS_ROOT} from '../../installer/official-live/common.mjs'
import {POLICY_PACKAGES} from '../../installer/official-policy/common.mjs'
import {targetState,sha256} from '../../installer/fs-state.mjs'
import {sealReceipt} from '../../installer/receipt.mjs'
async function put(path,text){await mkdir(join(path,'..'),{recursive:true});await writeFile(path,text)}
export async function hostFixture(t,{nativeDeps=false}={}){
 const id=randomUUID(),root=resolve('var/host-upgrade-fixtures',id),backup=join(PROMOTION_BACKUPS_ROOT,'host-fixture-'+id),transaction=join(HOST_UPGRADE_ROOT,'fixture-'+id)
 await mkdir(root,{recursive:true});await mkdir(backup,{recursive:true})
 t.after(async()=>{for(const path of [root,backup,transaction])await rm(path,{recursive:true,force:true})})
 const options={oldInstallRoot:join(root,'old-install'),newInstallRoot:join(root,'new-install'),homeRoot:join(root,'home'),electronUserDataRoot:join(root,'electron'),transactionRoot:transaction,previousReceiptPath:join(backup,'receipt.json')}
 const uiNames=nativeDeps?['owned-ui','@deepseek-ai/dsh-storage-domain','zod']:['owned-ui'],names=[...uiNames.filter(name=>name!=='zod'),...POLICY_PACKAGES],artifactNames=[...uiNames,...POLICY_PACKAGES],locks={}
 for(const side of ['old','new']){
  const install=side==='old'?options.oldInstallRoot:options.newInstallRoot,version=side==='old'?'test-old':'test-new'
  await put(join(install,'resources/app.asar'),side+' official bytes');await put(join(install,'DeepSeek Harness.exe'),side+' exe')
  const files=Object.fromEntries(await Promise.all(['resources/app.asar','DeepSeek Harness.exe'].map(async name=>{const row=await targetState(join(install,name));return [name,{sha256:row.sha256,bytes:row.bytes}]})))
  locks[side]={schemaVersion:1,target:'official-desktop',product:'DeepSeek Harness',hostVersion:version,buildCommit:side,platform:'win32-x64',profileLayout:'.dsh/profiles/desktop',files}
  options[side+'ReleaseLockPath']=join(root,side+'.lock.json');await put(options[side+'ReleaseLockPath'],JSON.stringify(locks[side]))
  const target={kind:'official-desktop',hostVersion:version,appAsarSha256:files['resources/app.asar'].sha256}
  for(const layer of ['Ui','Policy']){
   const artifactRoot=join(root,side+'-'+layer);options[side+layer+'ArtifactRoot']=artifactRoot
   const packageNames=layer==='Ui'?uiNames:[...POLICY_PACKAGES]
   for(const name of packageNames){const dir=join(artifactRoot,'payload/packages',name);if(name==='airules-dsh-rulepack')await put(join(dir,'manifest.json'),JSON.stringify({package:{id:name,version:side}}));else await put(join(dir,'package.json'),JSON.stringify({name,version:name==='zod'?'4.4.3':side==='old'?'1.0.0':'2.0.0',...(name==='@deepseek-ai/dsh-storage-domain'?{dependencies:{zod:'4.4.3'}}:{})}));await put(join(dir,'index.js'),side+' '+name)}
   const fragment=layer==='Ui'?'cordis.ui.fragment.yml':'cordis.policy.fragment.yml'
   await put(join(artifactRoot,fragment),`- id: ${layer.toLowerCase()}-managed\n  name: ${layer.toLowerCase()}-plugin\n  config:\n    value: ${side}\n`)
   if(layer==='Ui')await put(join(artifactRoot,'official-ui-manifest.json'),JSON.stringify({artifact:{id:'airules-dsh-ui-overlay',version:side+'-fixture'},target,packages:packageNames.map(name=>({name,source:`payload/packages/${name}`})),cordisFragment:fragment}))
   const state=await targetState(artifactRoot)
   const manifest={schemaVersion:1,artifact:{id:layer==='Ui'?'airules-dsh-ui-overlay':'airules-official-policy-overlay',version:side+'-fixture'},target,separation:{},files:state.files,...layer==='Ui'?{operations:packageNames.map(name=>({type:'package-copy',target:`node_modules/${name}`}))}:{preset:{id:'1c-airules',extensionPoint:'@deepseek-ai/dsh-agent-preset'},operations:[...packageNames.map(name=>({kind:'package-copy',source:`payload/packages/${name}`,target:`node_modules/${name}`})),{kind:'cordis-merge',source:'cordis.policy.fragment.yml',target:'cordis.patch.yml'}]}}
   await put(join(artifactRoot,layer==='Ui'?'ui-overlay-manifest.json':'official-policy-manifest.json'),JSON.stringify(manifest))
  }
 }
 const profile=join(options.homeRoot,'profiles/desktop')
 for(const name of names){if(name==='airules-dsh-rulepack')await put(join(profile,'node_modules',name,'manifest.json'),JSON.stringify({package:{id:name,version:'old'}}));else await put(join(profile,'node_modules',name,'package.json'),JSON.stringify({name,version:'1.0.0',...(name==='@deepseek-ai/dsh-storage-domain'?{dependencies:{zod:'4.4.3'}}:{})}));await put(join(profile,'node_modules',name,'index.js'),'old '+name)}
 if(nativeDeps){await put(join(profile,'node_modules/@deepseek-ai/dsh-storage-domain/node_modules/zod/package.json'),JSON.stringify({name:'zod',version:'4.4.3'}));await put(join(profile,'node_modules/@deepseek-ai/dsh-storage-domain/node_modules/zod/index.js'),'old zod');await put(join(profile,'node_modules/zod/package.json'),JSON.stringify({name:'zod',version:'4.6.7'}))}
 await put(join(profile,'node_modules/unowned-user-plugin/index.js'),'USER_PLUGIN')
 const current=await readFile(join(options.oldUiArtifactRoot,'cordis.ui.fragment.yml'),'utf8')+await readFile(join(options.oldPolicyArtifactRoot,'cordis.policy.fragment.yml'),'utf8')+'# preserved custom settings\n- id: user-setting\n  config:\n    enabled: true\n'
 await put(join(profile,'cordis.patch.yml'),current)
 await put(join(options.homeRoot,'sessions/native-chat.json'),'NATIVE_CHAT_SENTINEL');await put(join(options.homeRoot,'credentials/account.json'),'PRIVATE_AUTH_SENTINEL');await put(join(options.homeRoot,'mcp.json'),'PROJECT_MCP_SENTINEL');await put(join(options.electronUserDataRoot,'Cookies'),'COOKIE_SENTINEL')
 const artifacts={};for(const [key,path]of [['ui',join(options.oldUiArtifactRoot,'ui-overlay-manifest.json')],['policy',join(options.oldPolicyArtifactRoot,'official-policy-manifest.json')]]){const value=JSON.parse(await readFile(path,'utf8'));artifacts[key]={...value.artifact,manifestSha256:sha256(await readFile(path))}}
 const operations=await Promise.all(names.map(async name=>({type:name==='@deepseek-ai/dsh-storage-domain'?'copy-directory-with-nested-dependency':'copy-directory',package:name,target:'node_modules/'+name,before:{type:'missing'},after:await targetState(join(profile,'node_modules',name))})))
 operations.push({type:'merge-cordis',target:'cordis.patch.yml',before:{type:'missing'},after:await targetState(join(profile,'cordis.patch.yml'))})
 const receipt=sealReceipt({schemaVersion:1,status:'applied',target:{kind:'official-desktop',hostVersion:'test-old',appAsarSha256:locks.old.files['resources/app.asar'].sha256},installRoot:options.oldInstallRoot,profileRoot:profile,backupRoot:backup,artifactPackageNames:artifactNames,packageNames:names,operations,artifacts,cleanupPending:[]})
 await put(options.previousReceiptPath,JSON.stringify(receipt))
 return {root,options,profile,receipt}
}
