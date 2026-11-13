import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises'
import {existsSync} from 'node:fs'
import {join,resolve,relative,isAbsolute} from 'node:path'
import {tmpdir} from 'node:os'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {createOfficialDeploymentAdapters} from '../src/deployment-bundle/lib/official-adapter.mjs'
import {hashFile} from '../src/deployment-bundle/lib/fs.mjs'

const installer=resolve('var/host-upgrade/rc022/deepseek-harness-0.2.2-rc.1-win-x64.exe')
test('actual stock-installer signature is verified under inherited module pollution before an injected installation', {skip:process.platform!=='win32'||!existsSync(installer)},async t=>{
 const root=await mkdtemp(join(tmpdir(),'dsh-native-signature-'));t.after(async()=>{const rel=relative(resolve(tmpdir()),root);assert.ok(!isAbsolute(rel)&&rel.startsWith('dsh-native-signature-'));await rm(root,{recursive:true,force:true})})
 const poison=join(root,'modules'),fake=join(poison,'Microsoft.PowerShell.Security');await mkdir(fake,{recursive:true});await writeFile(join(fake,'Microsoft.PowerShell.Security.psd1'),"@{ModuleVersion='99.0.0';PowerShellVersion='99.0'}")
 const expected=await hashFile(installer),execute=promisify(execFile),transaction=join(root,'transaction');let probes=0,launches=0
 const adapter=createOfficialDeploymentAdapters({executeImpl:async(file,args,options)=>{
  if(file==='powershell.exe'){probes++;return execute(file,args,{...options,env:{...process.env,PSModulePath:poison+';'+join(process.env.SystemRoot??'C:\\Windows','System32/WindowsPowerShell/v1.0/Modules')}})}
  assert.equal(file,join(transaction,'official-installer-source/setup.exe'));assert.deepEqual(args.slice(0,3),['--updated','/S','/currentuser']);launches++;return{stdout:''}
 }})
 const result=await adapter.installOfficial({installerPath:installer,transaction,installRoot:join(root,'Recipient DSH'),manifest:{paths:{officialInstaller:'payload/official/setup.exe'},files:{'payload/official/setup.exe':expected},signatures:{officialInstaller:{thumbprint:'84032578657219876E273E0D1BD303CFE1B82E6F'}}}})
 assert.equal(result.status,'installed');assert.equal(result.installerSha256,expected.sha256);assert.equal(probes,1);assert.equal(launches,1)
})
