import test from'node:test'
import assert from'node:assert/strict'
import{createHash}from'node:crypto'
import{policyPackageNames}from'../installer/official-policy/common.mjs'
import{nativeFsProfile}from'../src/native-fs-compat/patch.mjs'
const canonical=value=>Array.isArray(value)?`[${value.map(canonical).join(',')}]`:value&&typeof value==='object'?`{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`:JSON.stringify(value)
const hash=value=>createHash('sha256').update(canonical(value)).digest('hex')
const continuity=()=>{const files=Object.fromEntries(['contract.json','checkpoint.schema.json','fixtures.json'].map(name=>[name,{bytes:1,sha256:'a'.repeat(64)}]));return{package:'airules-dsh-context-continuity',policyOwner:'project_rules',mode:'minimal',memoryWrites:false,canonical:{files,digest:hash(files)}}}
test('new continuity metadata requires exact022 host, minimal mode, no memory writes and complete canonical closure',()=>{
 const source={target:{hostVersion:'0.2.2-rc.1'},integrations:{contextContinuity:continuity()}}
 assert.equal(policyPackageNames(source).at(-1),'airules-dsh-context-continuity')
 for(const mutate of [m=>m.target.hostVersion='0.2.1-rc.5',m=>m.integrations.contextContinuity.mode='full',m=>m.integrations.contextContinuity.memoryWrites=true,m=>delete m.integrations.contextContinuity.canonical.files['contract.json'],m=>m.integrations.contextContinuity.canonical.digest='b'.repeat(64),m=>m.integrations.contextContinuity.canonical.extra=true]){const bad=structuredClone(source);mutate(bad);assert.throws(()=>policyPackageNames(bad))}
})
test('native filesystem integration binds target version, exact output pins and reviewed platform package count',()=>{
 for(const version of ['0.2.1-rc.5','0.2.2-rc.1']){const p=nativeFsProfile(version),nativeFsCompat={package:'airules-dsh-native-fs',patch:p.patch,hostVersion:version,localInputSha256:p.localInput,localOutputSha256:p.localOutput,sandboxInputSha256:p.sandboxInput,sandboxOutputSha256:p.sandboxOutput,dependencyLockSha256:'a'.repeat(64),privateRuntimePackages:version==='0.2.2-rc.1'?8:7,target:'win32-x64'},source={target:{hostVersion:version},integrations:{nativeFsCompat}}
 assert.equal(policyPackageNames(source).at(-1),'airules-dsh-native-fs')
 for(const mutate of [m=>m.target.hostVersion='0.2.2-rc.2',m=>m.integrations.nativeFsCompat.privateRuntimePackages++,m=>m.integrations.nativeFsCompat.localOutputSha256='b'.repeat(64)]){const bad=structuredClone(source);mutate(bad);assert.throws(()=>policyPackageNames(bad),/NATIVE_FS/)}
 }
})
