import {createHash, randomUUID} from 'node:crypto'
import {lstat, realpath, readFile, readdir, mkdir, writeFile, rename, unlink} from 'node:fs/promises'
import {resolve, relative, isAbsolute, dirname, join, sep} from 'node:path'
import {fileURLToPath} from 'node:url'

const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
const fail=code=>{throw Error(code)}
const key=path=>process.platform==='win32'?resolve(path).toLowerCase():resolve(path)
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value)
const MANIFEST='.airules-manifest.json'
function pathIn(root,name){
 if(typeof name!=='string'||name.length>1024||name.includes('\\')||name.includes(':')||/[\x00-\x1f\x7f]/u.test(name)||name.split('/').some(part=>!part||part==='.'||part==='..'))fail('MIGRATION_PATH_INVALID')
 const path=resolve(root,...name.split('/')),rel=relative(root,path)
 if(isAbsolute(rel)||rel==='..'||rel.startsWith('..'+sep))fail('MIGRATION_PATH_INVALID')
 return path
}
async function guard(root,path=root){
 const rel=relative(root,path);if(isAbsolute(rel)||rel==='..'||rel.startsWith('..'+sep))fail('MIGRATION_PATH_INVALID')
 let at=root
 for(const part of ['',...rel.split(sep).filter(Boolean)]){
  if(part)at=join(at,part)
  try{const info=await lstat(at);if(info.isSymbolicLink()||key(await realpath(at))!==key(at)||info.isFile()&&info.nlink!==1)fail('MIGRATION_LINK_REJECTED')}
  catch(error){if(error.code==='ENOENT')return;throw error}
 }
}
async function read(root,name){const path=pathIn(root,name);await guard(root,path);try{const info=await lstat(path);if(!info.isFile()||info.size>16*1024*1024)fail('MIGRATION_FILE_INVALID');return await readFile(path)}catch(error){if(error.code==='ENOENT')return null;throw error}}
function parse(bytes){try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes).replace(/^\uFEFF/u,''))}catch{fail('MIGRATION_JSON_INVALID')}}
async function inventory(project,legacy){
 const names=new Set(Object.keys(legacy.files))
 for(const name of ['AGENTS.md','USER-RULES.md','LLM-RULES.md','AGENTS.local.md','memory.md','.mcp.json','mcp.json','openspec/project.md'])names.add(name)
 for(const name of await readdir(project))if(/^\.env(?:\.|$)/u.test(name))names.add(name)
 async function visit(name){const path=pathIn(project,name);await guard(project,path);let info;try{info=await lstat(path)}catch(error){if(error.code==='ENOENT')return;throw error}if(info.isDirectory()){for(const child of await readdir(path)){if(['.git','node_modules','__pycache__','worktrees','state','cache','logs'].includes(child))continue;await visit(name+'/'+child)}}else if(info.isFile())names.add(name);else fail('MIGRATION_FILE_INVALID')}
 for(const name of ['.dsh','.codex','.claude','.cursor','.vscode'])await visit(name)
 if(names.size>10000)fail('MIGRATION_FILE_LIMIT')
 const rows=[];let total=0
 for(const name of [...names].sort()){const bytes=await read(project,name);if(bytes){total+=bytes.length;if(total>256*1024*1024)fail('MIGRATION_BYTE_LIMIT')}rows.push({path:name,sha256:bytes?sha(bytes):null,bytes:bytes?.length??0})}
 return rows
}
async function assertInventory(project,rows){for(const row of rows){const bytes=await read(project,row.path);if((bytes?sha(bytes):null)!==row.sha256)fail('MIGRATION_PROJECT_CHANGED')}}
export async function migrateLegacyManifest({projectRoot,apply=false,expectedManifestSha256}={}){
 if(!isAbsolute(projectRoot??''))fail('MIGRATION_PROJECT_REQUIRED')
 const project=resolve(projectRoot);await guard(project)
 const original=await read(project,MANIFEST);if(!original)fail('MIGRATION_MANIFEST_REQUIRED')
 const beforeHash=sha(original),legacy=parse(original)
 if(expectedManifestSha256&&expectedManifestSha256!==beforeHash)fail('MIGRATION_MANIFEST_CHANGED')
 if(!plain(legacy)||legacy.schema_version!==undefined||typeof legacy.version!=='string'||!plain(legacy.files)||!Object.keys(legacy.files).length||Object.keys(legacy.files).length>5000||!plain(legacy.placeholders))fail('MIGRATION_LEGACY_SCHEMA_REQUIRED')
 for(const [name,digest]of Object.entries(legacy.files)){pathIn(project,name);if(!/^[a-f0-9]{64}$/u.test(digest))fail('MIGRATION_LEGACY_HASH_INVALID')}
 const rows=await inventory(project,legacy),current=new Map(rows.map(row=>[row.path,row])),drift=Object.entries(legacy.files).filter(([name,digest])=>current.get(name)?.sha256!==digest).map(([path])=>path)
 const summary={status:'ready',projectRoot:project,manifestSha256:beforeHash,legacyVersion:legacy.version,legacyFiles:Object.keys(legacy.files).length,protectedFiles:rows.filter(row=>row.sha256).length,drift,managedDshFiles:0,requiresExplicitInstructionAdoption:true,realDeployment:false}
 if(!apply)return summary
 const backupRelative='.rules-backups/manifest-migration-'+new Date().toISOString().replace(/[:.]/gu,'-')+'-'+randomUUID(),backup=pathIn(project,backupRelative),lockPath=join(project,'.airules-rollout.lock'),lock=JSON.stringify({kind:'manifest-migration',id:randomUUID(),pid:process.pid})
 await guard(project,lockPath);await writeFile(lockPath,lock,{flag:'wx',mode:0o600})
 let receipt,temp
 try{
  await assertInventory(project,rows);if(sha(await read(project,MANIFEST))!==beforeHash)fail('MIGRATION_MANIFEST_CHANGED')
  await guard(project,backup);await mkdir(backup,{recursive:true});await guard(project,backup)
  await writeFile(join(backup,'previous-airules-manifest.json'),original,{flag:'wx',mode:0o600})
  for(const row of rows){if(!row.sha256)continue;const bytes=await read(project,row.path);if(!bytes||sha(bytes)!==row.sha256)fail('MIGRATION_PROJECT_CHANGED');const destination=pathIn(backup,'files/'+row.path);await mkdir(dirname(destination),{recursive:true});await guard(project,destination);await writeFile(destination,bytes,{flag:'wx',mode:0o600});if(sha(await readFile(destination))!==row.sha256)fail('MIGRATION_BACKUP_INVALID')}
  const migrated={schema_version:1,source_version:legacy.version,source_revision:null,source_dirty:null,composition:{profile:'public',target:'dsh-deepseek'},files:{},placeholders:legacy.placeholders,legacy_installation:legacy,migration:{kind:'legacy-inventory-only',created_at:new Date().toISOString(),backup:backupRelative,original_manifest_sha256:beforeHash,legacy_files:Object.keys(legacy.files).length,drift,managed_dsh_files:0,requires_explicit_instruction_adoption:true}}
  const after=Buffer.from(JSON.stringify(migrated,null,2)+'\n'),afterHash=sha(after)
  receipt={schemaVersion:1,kind:'legacy-airules-manifest-migration',status:'prepared',projectRoot:project,backupRoot:backup,beforeManifestSha256:beforeHash,afterManifestSha256:afterHash,protected:rows,...summary}
  receipt.status='prepared';await writeFile(join(backup,'receipt.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600})
  await assertInventory(project,rows);if(sha(await read(project,MANIFEST))!==beforeHash)fail('MIGRATION_MANIFEST_CHANGED')
  temp=join(project,'.airules-manifest.'+randomUUID()+'.tmp');await writeFile(temp,after,{flag:'wx',mode:0o600});await guard(project,join(project,MANIFEST));if(sha(await read(project,MANIFEST))!==beforeHash)fail('MIGRATION_MANIFEST_CHANGED');await rename(temp,join(project,MANIFEST));temp=null
  if(sha(await read(project,MANIFEST))!==afterHash)fail('MIGRATION_VERIFY_FAILED');await assertInventory(project,rows)
  receipt.status='applied';await writeFile(join(backup,'receipt.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600})
  return{...summary,status:'applied',backupRoot:backup,receiptPath:join(backup,'receipt.json'),afterManifestSha256:afterHash,preservedFiles:summary.protectedFiles}
 }catch(error){if(receipt){receipt.status='interrupted';await writeFile(join(backup,'receipt.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600}).catch(()=>{});error.receiptPath=join(backup,'receipt.json')}throw error}
 finally{if(temp)await unlink(temp).catch(()=>{});try{if((await readFile(lockPath,'utf8'))===lock)await unlink(lockPath)}catch{}}
}
export async function rollbackLegacyManifest({receiptPath}={}){
 if(!isAbsolute(receiptPath??''))fail('MIGRATION_RECEIPT_REQUIRED')
 const receipt=parse(await readFile(receiptPath)),project=resolve(receipt.projectRoot),backup=resolve(receipt.backupRoot)
 if(receipt.kind!=='legacy-airules-manifest-migration'||key(dirname(receiptPath))!==key(backup)||!relative(project,backup).startsWith('.rules-backups'+sep))fail('MIGRATION_RECEIPT_INVALID')
 await guard(project,receiptPath);const current=await read(project,MANIFEST),original=await readFile(join(backup,'previous-airules-manifest.json'))
 if(sha(original)!==receipt.beforeManifestSha256||!current||sha(current)!==receipt.afterManifestSha256)fail('MIGRATION_ROLLBACK_CONFLICT')
 await assertInventory(project,receipt.protected)
 const temp=join(project,'.airules-manifest.'+randomUUID()+'.tmp');await writeFile(temp,original,{flag:'wx',mode:0o600});try{await guard(project,join(project,MANIFEST));if(sha(await read(project,MANIFEST))!==receipt.afterManifestSha256)fail('MIGRATION_ROLLBACK_CONFLICT');await rename(temp,join(project,MANIFEST))}finally{await unlink(temp).catch(()=>{})}
 receipt.status='rolled-back';await writeFile(receiptPath,JSON.stringify(receipt,null,2)+'\n',{mode:0o600});return{status:'rolled-back',manifestSha256:sha(await read(project,MANIFEST))}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const args=process.argv.slice(2),take=name=>{const index=args.indexOf(name);return index<0?undefined:args[index+1]};if(args.some((arg,index)=>index===0?!['--project','--rollback'].includes(arg):arg.startsWith('--')&&!['--apply','--expected-manifest'].includes(arg)))fail('MIGRATION_ARGUMENT_INVALID');const result=args[0]==='--rollback'?await rollbackLegacyManifest({receiptPath:args[1]}):await migrateLegacyManifest({projectRoot:take('--project'),apply:args.includes('--apply'),expectedManifestSha256:take('--expected-manifest')});console.log(JSON.stringify(result,null,2))}catch(error){console.error(JSON.stringify({status:'FAIL',code:error.message,receiptPath:error.receiptPath??null}));process.exitCode=1}
}
