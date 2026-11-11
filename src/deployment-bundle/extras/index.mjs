import {readFile,readdir,mkdir,cp,writeFile,unlink,rm,rmdir} from 'node:fs/promises'
import {join,dirname,resolve} from 'node:path'
import {absolute,safeRelative,guard,kind,same,json,writeAtomic,writeJson,seal,validSeal,sha,fail} from '../lib/fs.mjs'
import {targetState} from '../../../installer/fs-state.mjs'

export async function extrasState(path){await guard(path);const result=await targetState(path);if(result.type==='directory')for(const name of Object.keys(result.files))await guard(safeRelative(path,name));await guard(path);return result}
const state=extrasState

export const EXTRA_PLUGINS=Object.freeze({'@michengai/dsh-btw':'1.3.2','@michengai/dsh-codex-pet':'1.0.12','dsh-rewind-plugin':'0.19.2','dsh-usage-panel':'0.2.3','dshmarket':'1.73.9'})
const HOME_DEFAULTS={
 'codex-pet/config.json':{selected:'custom:captain-diesel',visible:true,size:168,position:null},
 'captain-companion/config.json':{schemaVersion:1,enabled:true,automatic:true,intervalSeconds:180,bubbleSeconds:12,phrases:{}},
 'live2d-companion/settings.json':{enabled:false,model:'Miara',height:220,corner:'br',notifications:true,lookAtCursor:true,phrases:{}},
}
const bytes=value=>Buffer.from(JSON.stringify(value,null,2)+'\n')
async function inspectAssets(assetsRoot){
 const root=absolute(assetsRoot),manifest=await json(join(root,'extras.json'))
 if(manifest?.schemaVersion!==1||manifest.dependencyLayout!=='private-per-plugin'||JSON.stringify(manifest.roots)!==JSON.stringify(EXTRA_PLUGINS)||!Array.isArray(manifest.packages)||manifest.packages.length!==Object.keys(EXTRA_PLUGINS).length)fail('EXTRAS_MANIFEST_INVALID')
 const seen=new Set()
 for(const row of manifest.packages){if(!Object.hasOwn(EXTRA_PLUGINS,row.path)||row.name!==row.path||row.version!==EXTRA_PLUGINS[row.path]||seen.has(row.path))fail('EXTRAS_PACKAGE_INVALID');seen.add(row.path);const path=safeRelative(root,'modules/'+row.path),actual=await state(path);if(actual.type!=='directory'||!same(actual,row.state))fail('EXTRAS_ASSET_CHANGED')}
 for(const name of Object.keys(EXTRA_PLUGINS))if(!seen.has(name))fail('EXTRAS_PACKAGE_MISSING')
 for(const name of ['pet.json','spritesheet.png']){const actual=await state(safeRelative(root,'captain-diesel/'+name));if(!same(actual,manifest.captain?.[name]))fail('EXTRAS_CAPTAIN_CHANGED')}
 return{root,manifest}
}
export async function configureExtras({assetsRoot,profileRoot,dshHome,backupRoot,verify=async()=>{}}){
 const {root,manifest}=await inspectAssets(assetsRoot),profile=absolute(profileRoot),home=absolute(dshHome),backup=absolute(backupRoot)
 await verify();await guard(profile);await guard(home);await guard(backup)
 const rows=[]
 for(const row of manifest.packages){const target=safeRelative(profile,'node_modules/'+row.path),before=await state(target);if(before.type!=='missing'&&!same(before,row.state))fail('EXTRAS_PACKAGE_CONFLICT',{package:row.path});if(before.type==='missing')rows.push({kind:'package',root:'profile',path:'node_modules/'+row.path,source:'modules/'+row.path,before,after:row.state,written:false})}
 const pkgPath=join(profile,'package.json'),beforePackage=await state(pkgPath),pkg=await json(pkgPath)
 if(!pkg?.dsh?.profile||!Array.isArray(pkg.dsh.profile.bundles)||!pkg.dependencies||typeof pkg.dependencies!=='object')fail('EXTRAS_PROFILE_INVALID')
 const next=structuredClone(pkg)
 for(const[name,version]of Object.entries(EXTRA_PLUGINS)){if(next.dependencies[name]&&next.dependencies[name]!==version)fail('EXTRAS_PLUGIN_VERSION_CONFLICT',{package:name});next.dependencies[name]=version;if(!next.dsh.profile.bundles.includes(name))next.dsh.profile.bundles.push(name)}
 const afterPackage=bytes(next)
 if(beforePackage.sha256!==sha(afterPackage))rows.push({kind:'file',root:'profile',path:'package.json',before:beforePackage,after:{type:'file',bytes:afterPackage.length,sha256:sha(afterPackage)},written:false,data:afterPackage})
 for(const[name,value]of Object.entries(HOME_DEFAULTS)){const before=await state(safeRelative(home,name));if(before.type==='missing'){const data=bytes(value);rows.push({kind:'file',root:'home',path:name,before,after:{type:'file',bytes:data.length,sha256:sha(data)},written:false,data})}else if(before.type!=='file')fail('EXTRAS_DEFAULT_CONFLICT')}
 for(const name of ['pet.json','spritesheet.png']){const path='codex-pet/pets/captain-diesel/'+name,before=await state(safeRelative(home,path));if(before.type==='missing')rows.push({kind:'file',root:'home',path,before,after:manifest.captain[name],source:'captain-diesel/'+name,written:false});else if(before.type!=='file')fail('EXTRAS_DEFAULT_CONFLICT')}
 const createdParents=[];const parentKeys=new Set()
 for(const row of rows){const parts=row.path.split('/');parts.pop();while(parts.length){const path=parts.join('/'),id=row.root+':'+path;if(!parentKeys.has(id)){parentKeys.add(id);if(await kind(safeRelative(row.root==='profile'?profile:home,path))==='missing')createdParents.push({root:row.root,path})}parts.pop()}}
 await mkdir(backup,{recursive:true});const receiptPath=join(backup,'receipt.json'),receipt={schemaVersion:1,kind:'recipient-extras',status:'prepared',profileRoot:profile,dshHome:home,backupRoot:backup,createdParents,rows:rows.map(({data,...row})=>row)}
 const save=()=>writeJson(receiptPath,seal(receipt))
 try{
  // Complete original-byte backups before changing any profile file.
  for(const row of rows){if(row.before.type==='file'){const target=safeRelative(row.root==='profile'?profile:home,row.path),saved=safeRelative(backup,'before/'+row.root+'/'+row.path);await verify();if(!same(await state(target),row.before))fail('EXTRAS_TARGET_CHANGED');await mkdir(dirname(saved),{recursive:true});await writeFile(saved,await readFile(target),{flag:'wx',mode:0o600});if(!same(await state(saved),row.before))fail('EXTRAS_BACKUP_INVALID')}}
  await save()
  for(const[i,row]of rows.entries()){
   const target=safeRelative(row.root==='profile'?profile:home,row.path);await verify();await guard(target);if(!same(await state(target),row.before))fail('EXTRAS_TARGET_CHANGED')
   await mkdir(dirname(target),{recursive:true});await guard(target);await verify()
   receipt.rows[i].started=true;await save();await verify();if(!same(await state(target),row.before))fail('EXTRAS_TARGET_CHANGED')
   if(row.kind==='package')await cp(safeRelative(root,row.source),target,{recursive:true,force:false,errorOnExist:true})
   else await writeAtomic(target,row.data??await readFile(safeRelative(root,row.source)))
   if(!same(await state(target),row.after))fail('EXTRAS_INSTALL_VERIFY_FAILED')
   receipt.rows[i].written=true;await save()
  }
  receipt.status='applied';await save();return{status:'applied',receiptPath,plugins:Object.keys(EXTRA_PLUGINS).length,files:rows.length,personalStateImported:false}
 }catch(error){receipt.status='interrupted';await save().catch(()=>{});error.receiptPath=receiptPath;throw error}
}
export async function rollbackExtras({receiptPath,verify=async()=>{}}){
 const receipt=await json(absolute(receiptPath));if(!validSeal(receipt)||receipt.kind!=='recipient-extras'||!['applied','interrupted','rolling-back'].includes(receipt.status)||!Array.isArray(receipt.rows))fail('EXTRAS_RECEIPT_INVALID')
 const profile=absolute(receipt.profileRoot),home=absolute(receipt.dshHome),backup=absolute(receipt.backupRoot)
 if(resolve(receiptPath)!==join(backup,'receipt.json'))fail('EXTRAS_RECEIPT_INVALID')
 const candidates=[]
 // Infer a crash between filesystem commit and receipt update. Only exact
 // after-bytes, or a started copy containing an exact subset, are ours.
 for(const row of receipt.rows){
  if(!row||!['profile','home'].includes(row.root)||!['package','file'].includes(row.kind)||typeof row.path!=='string'||!row.before||!row.after)fail('EXTRAS_RECEIPT_INVALID')
  if(row.kind==='package'&&(row.root!=='profile'||!/^node_modules\/(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/iu.test(row.path)))fail('EXTRAS_RECEIPT_INVALID')
  const target=safeRelative(row.root==='profile'?profile:home,row.path);await verify();await guard(target);const actual=await state(target)
  if(same(actual,row.before)){row.restored=true;continue}
  if(row.restored)fail('EXTRAS_ROLLBACK_CONFLICT')
  const exact=same(actual,row.after)
  const partial=row.started===true&&row.kind==='package'&&row.before.type==='missing'&&actual.type==='directory'&&row.after.type==='directory'&&Object.entries(actual.files).every(([name,value])=>same(value,row.after.files?.[name]))
  if(!exact&&!partial)fail('EXTRAS_ROLLBACK_CONFLICT')
  row.written=true;candidates.push({row,observed:actual})
 }
 receipt.status='rolling-back';await writeJson(receiptPath,seal(receipt))
 for(const {row,observed}of [...candidates].reverse()){
  const target=safeRelative(row.root==='profile'?profile:home,row.path);await verify();await guard(target);if(!same(await state(target),observed))fail('EXTRAS_ROLLBACK_CONFLICT')
  if(row.before.type==='missing'){if(row.kind==='package')await rm(target,{recursive:true,force:false});else await unlink(target)}
  else if(row.before.type==='file'){const saved=safeRelative(backup,'before/'+row.root+'/'+row.path);if(!same(await state(saved),row.before))fail('EXTRAS_BACKUP_INVALID');await writeAtomic(target,await readFile(saved),{expected:observed})}
  else fail('EXTRAS_RECEIPT_INVALID')
  if(!same(await state(target),row.before))fail('EXTRAS_ROLLBACK_VERIFY_FAILED')
  row.restored=true;await writeJson(receiptPath,seal(receipt))
 }
 for(const entry of [...(receipt.createdParents??[])].sort((a,b)=>b.path.split('/').length-a.path.split('/').length)){
  if(!['profile','home'].includes(entry.root)||!receipt.rows.some(row=>row.root===entry.root&&row.path.startsWith(entry.path+'/')))fail('EXTRAS_RECEIPT_INVALID')
  const path=safeRelative(entry.root==='profile'?profile:home,entry.path);await verify();await guard(path)
  if(await kind(path)==='directory')try{await rmdir(path)}catch(error){if(!['ENOTEMPTY','ENOENT','EEXIST'].includes(error.code))throw error}
 }
 receipt.status='rolled-back';await writeJson(receiptPath,seal(receipt));return{status:'rolled-back',receiptPath}
}
