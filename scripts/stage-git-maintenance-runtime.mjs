import {createHash} from 'node:crypto'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {lstat,mkdir,readFile,readdir,writeFile} from 'node:fs/promises'
import {join,relative,resolve,isAbsolute} from 'node:path'
const execute=promisify(execFile),sha=bytes=>createHash('sha256').update(bytes).digest('hex')
const ROOTS=['VERSION','core/rules','core/agents','core/templates','core/skills','overlays/1c/rules','overlays/1c/skills','profiles/public','project-layer/common','project-template','targets/dsh/deepseek','targets/dsh/skills']
export async function stageGitMaintenanceRuntime({packageRoot,canonicalRoot,rulepackManifest,artifactVersion}){
 if(!isAbsolute(canonicalRoot??''))throw Error('MAINTENANCE_CANONICAL_ROOT_REQUIRED')
 const source=resolve(canonicalRoot),revision=(await execute('git',['-C',source,'rev-parse','HEAD'],{windowsHide:true})).stdout.trim(),dirty=(await execute('git',['-C',source,'status','--porcelain'],{windowsHide:true})).stdout.trim()
 if(dirty||revision!==rulepackManifest.source?.revision||rulepackManifest.source?.dirty!==false)throw Error('MAINTENANCE_CANONICAL_SOURCE_MISMATCH')
 const root=join(packageRoot,'runtime/embedded-source'),files={};let size=0
 async function copy(input,output){const info=await lstat(input);if(info.isSymbolicLink())throw Error('MAINTENANCE_SOURCE_LINK_REJECTED');if(info.isDirectory()){await mkdir(output,{recursive:true});for(const name of (await readdir(input)).sort()){if(['node_modules','.git','__pycache__','var','projects.local'].includes(name)||/^\.env(?:\.|$)/u.test(name)||/\.(?:pyc|sqlite|db|pfx|p12|key|pem)$/iu.test(name))continue;await copy(join(input,name),join(output,name))}}else if(info.isFile()){if(info.nlink!==1||info.size>32*1024*1024||(size+=info.size)>96*1024*1024)throw Error('MAINTENANCE_SOURCE_SIZE_LIMIT');const bytes=await readFile(input);await mkdir(resolve(output,'..'),{recursive:true});await writeFile(output,bytes,{flag:'wx'});files[relative(root,output).replaceAll('\\','/')]={bytes:bytes.length,sha256:sha(bytes)}}else throw Error('MAINTENANCE_SOURCE_FILE_REQUIRED')}
 for(const path of ROOTS)try{await copy(join(source,path),join(root,path))}catch(error){if(error.code!=='ENOENT'||path!=='targets/dsh/skills')throw error}
 const version=(await readFile(join(root,'VERSION'),'utf8')).trim(),metadata={schemaVersion:1,commit:revision,version,profile:'public',mcp:'unchanged',files:Object.keys(files).length,inventoryDigest:sha(JSON.stringify(files)),inventory:files}
 await writeFile(join(packageRoot,'runtime/embedded-source.json'),JSON.stringify(metadata,null,2)+'\n',{flag:'wx'})
 await writeFile(join(packageRoot,'runtime/build-info.json'),JSON.stringify({schemaVersion:1,policyVersion:artifactVersion,airulesVersion:version,airulesCommit:revision})+'\n',{flag:'wx'})
 return{package:'airules-dsh-git-maintenance',sources:'github-or-local-or-embedded',projectScope:'registered-project',updates:'certified-release-on-exit',mcp:false}
}
