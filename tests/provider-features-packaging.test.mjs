import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { stageOfficialPolicy } from '../scripts/stage-official-policy.mjs'
import { policyPackageNames,verifyNewFeatureMounts } from '../installer/official-policy/common.mjs'
import { analyzePolicyCordis,validatePolicyFragment } from '../installer/official-policy/policy-cordis.mjs'
import { migrateCordisFragments } from '../installer/official-live/cordis-migration.mjs'
import YAML from '../installer/vendor/yaml/dist/index.js'

const hash='a'.repeat(64),canonical=value=>Array.isArray(value)?`[${value.map(canonical).join(',')}]`:value&&typeof value==='object'?`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`:JSON.stringify(value)
const digest=value=>createHash('sha256').update(canonical(value)).digest('hex')
const roots=['core/tools/workflow','overlays/1c/tools/workflow-onec','overlays/1c/tools/workflow-runners']
const inventory={'index.mjs':{bytes:1,sha256:hash}}
const base={
  acp:{package:'airules-dsh-acp',defaultEnabled:false,inbound:'local-named-pipe',outbound:'native-external-agent',adapterVersion:'0.2.1-rc.3.1',sdkVersion:'1.5.1',dependencyLockSha256:hash,privateRuntimePackages:22,adaptation:{sourceSha256:hash,stagedSha256:hash}},
  additionalProviders:{package:'airules-dsh-additional-providers',authentication:'explicit-user-action',bootstrap:false},
  onecPanels:{package:'airules-dsh-onec-panels',metadataReadOnly:true,root:'selected-session',background:'native-jobs-reviewed-mcp',defaultBackgroundTools:0},
  workflows:{package:'airules-dsh-workflows',nativeSandbox:true,deployEnabled:false,policyOwner:'project_rules',provenance:{source:'project_rules',layout:'canonical-relative',roots:roots.map(source=>({source,target:`runtime/${source}`,files:1,inventoryDigest:digest(inventory),inventory}))},reviewedRunners:{kind:'agent-1c',files:3,digest:hash,operations:['doctor','analyze']}},
}
const features={
  providerExtensions:{package:'airules-dsh-provider-extensions',providers:['google','muse'],transport:'native-acp',runtime:'explicit-installed-executable',authentication:'explicit-user-action',defaultEnabled:false,bootstrap:false,dependencyLockSha256:hash,privateRuntimePackages:117,nativePiAiVersion:'1.1.0'},
  cursorProvider:{package:'airules-dsh-cursor-provider',provider:'airules-cursor',authentication:'explicit-user-action',sdkVersion:'1.0.38',sdkBundled:false,bootstrap:false,nativeAccess:'build-and-native'},
  onecSpecialized:{package:'airules-dsh-onec-specialized',scope:'1c-airules',execution:'native-sandbox',runners:'explicit-project-bindings',externalDefaultTrustedRunners:0,bundledRunner:'exact-managed-sha256',domains:['repository','ai-merge','v8unpack'],policyOwner:'project_rules'},
}
const clone=value=>JSON.parse(JSON.stringify(value))
const hosts=[['providerExtensions','airules-provider-extensions','airules-dsh-provider-extensions'],['cursorProvider','airules-cursor-provider','airules-dsh-cursor-provider'],['onecSpecialized','airules-onec-specialized','airules-dsh-onec-specialized']]
function fragment(integrations,{nativeFs=false}={}){
  const tools=[integrations.onecPanels?.metadataReadOnly?'          - id: airules-onec-workbench-tools\n            name: airules-dsh-onec-panels/tools\n':'',integrations.onecSpecialized?'          - id: airules-onec-specialized-tools\n            name: airules-dsh-onec-specialized/tools\n':''].join('')
  return "- insert:\n    - id: preset-1c-airules\n      name: '@deepseek-ai/dsh-agent-preset'\n      config:\n        id: 1c-airules\n"+(tools?'        plugins:\n'+tools:'        plugins: []\n')+
    "- insert:\n    - id: airules-acp-adapter\n      name: '@zaimokuza/dsh-acp-adapter'\n      config:\n        agents: {}\n        toolApprovalDefault: ask\n"+
    hosts.filter(([key])=>integrations[key]).map(([,id,name])=>`    - id: ${id}\n      name: ${name}\n`).join('')+
    (nativeFs?'    - id: airules-native-fs\n      name: airules-dsh-native-fs\n':'')+
    '    - id: airules-onec-bsl-editor\n      name: dsh-bsl-editor\n- id: agent-preset-registry\n  config:\n    default: 1c-airules\n'+(nativeFs?"- id: fs-sandbox\n  name: '@deepseek-ai/dsh-fs-sandbox'\n  disabled: true\n":'')
}

test('new optional features preserve old package lists and append their exact packages in stage order',()=>{
  assert.equal(policyPackageNames({}).length,7)
  const old=policyPackageNames({integrations:base}),next=policyPackageNames({integrations:{...base,...features}})
  assert.deepEqual(next,[...old,'airules-dsh-provider-extensions','airules-dsh-cursor-provider','airules-dsh-onec-specialized'])
  assert.equal(policyPackageNames({integrations:{onecPanels:{package:'airules-dsh-onec-panels',readOnly:true,root:'selected-session'}}}).at(-1),'airules-dsh-onec-panels')
})

test('new manifest schemas reject unknown keys, bundled Cursor SDK, eager activation and missing prerequisites',()=>{
  for(const [key,patch]of [['providerExtensions',{bootstrap:true}],['providerExtensions',{privateRuntimePackages:118}],['providerExtensions',{runtime:'auto-download'}],['cursorProvider',{sdkBundled:true}],['cursorProvider',{nativeAccess:'automatic'}],['onecSpecialized',{externalDefaultTrustedRunners:1}],['onecSpecialized',{bundledRunner:'any-script'}],['onecPanels',{defaultBackgroundTools:1}]]){
    const integrations=clone({...base,...features});integrations[key]={...integrations[key],...patch}
    assert.throws(()=>policyPackageNames({integrations}),/POLICY_INTEGRATION_INVALID/)
  }
  for(const key of ['providerExtensions','cursorProvider','onecSpecialized']){
    const integrations=clone({...base,...features});integrations[key].secret='fixture';assert.throws(()=>policyPackageNames({integrations}),/POLICY_INTEGRATION_INVALID/)
  }
  for(const key of ['acp','additionalProviders','workflows','onecPanels']){const integrations=clone({...base,...features});delete integrations[key];assert.throws(()=>policyPackageNames({integrations}),/POLICY_INTEGRATION_INVALID/)}
})

test('builder validates new booleans and feature dependencies before reading or writing artifacts',async()=>{
  for(const key of ['includeProviderExtensions','includeCursorProvider','includeOnecSpecialized'])await assert.rejects(stageOfficialPolicy({[key]:'true'}),/BOOLEAN_OPTION_REQUIRED/)
  await assert.rejects(stageOfficialPolicy({includeProviderExtensions:true}),/PROVIDER_EXTENSIONS_REQUIRE_ACP_AND_ADDITIONAL_PROVIDERS/)
  await assert.rejects(stageOfficialPolicy({includeProviderExtensions:true,includeAcp:true,includeAdditionalProviders:true}),/PROVIDER_EXTENSIONS_EXPLICIT_NATIVE_MODULES_REQUIRED/)
  await assert.rejects(stageOfficialPolicy({includeOnecSpecialized:true}),/ONEC_SPECIALIZED_REQUIRE_WORKFLOWS_AND_ONEC_PANELS/)
})

test('new hosts remain in one managed insert and tools are restricted to 1c composition with exact mounts',()=>{
  const integrations={...base,...features},source=fragment(integrations)
  assert.equal(validatePolicyFragment(source).length,3);assert.doesNotThrow(()=>verifyNewFeatureMounts(source,integrations))
  const escaped=source.replace('          - id: airules-onec-specialized-tools\n            name: airules-dsh-onec-specialized/tools\n','').replace('    - id: airules-onec-bsl-editor','    - id: airules-onec-specialized-tools\n      name: airules-dsh-onec-specialized/tools\n    - id: airules-onec-bsl-editor')
  assert.throws(()=>verifyNewFeatureMounts(escaped,integrations),/TOOL_SCOPE_INVALID/)
  assert.throws(()=>verifyNewFeatureMounts(source.replace('      name: airules-dsh-cursor-provider\n','      name: airules-dsh-cursor-provider\n      config: { autoLogin: true }\n'),integrations),/MOUNT_INVALID/)
  assert.throws(()=>verifyNewFeatureMounts(source.replace('airules-dsh-cursor-provider','wrong-package'),integrations),/MOUNT_INVALID/)
})

test('migration adds only reviewed host ids and preserves existing ACP user settings without a cardinality exception',()=>{
  const old=fragment(base),next=fragment({...base,...features}),current=old.replace('agents: {}','agents: { user: { name: User, command: own-executable } }').replace('toolApprovalDefault: ask','toolApprovalDefault: auto')+'- id: user-extra\n  config: { keep: true }\n'
  assert.equal(analyzePolicyCordis(old,next).replaceable,true)
  const migrated=migrateCordisFragments(current,[{oldFragment:old,newFragment:next}]),rows=YAML.parse(migrated)
  assert.equal(rows.length,4);assert.equal(rows[1].insert[0].config.toolApprovalDefault,'auto');assert.equal(rows[1].insert[0].config.agents.user.command,'own-executable')
  for(const [,id]of hosts)assert.equal(rows[1].insert.filter(row=>row.id===id).length,1)
  assert.equal(rows[3].config.keep,true)
  const nativeOld=fragment(base,{nativeFs:true}),nativeNext=fragment({...base,...features},{nativeFs:true})
  assert.equal(validatePolicyFragment(nativeNext).length,4)
  assert.doesNotThrow(()=>migrateCordisFragments(nativeOld,[{oldFragment:nativeOld,newFragment:nativeNext}]))
  const collide=old+'- id: airules-cursor-provider\n  name: user-owned\n'
  assert.throws(()=>migrateCordisFragments(collide,[{oldFragment:old,newFragment:next}]),/CONFLICT/)
})

test('CLI exposes explicit new flags and copy logic filters node_modules instead of copying external Cursor SDK',async()=>{
  const source=await readFile(new URL('../scripts/stage-official-policy.mjs',import.meta.url),'utf8')
  for(const flag of ['--include-provider-extensions','--include-cursor-provider','--include-onec-specialized'])assert.ok(source.includes(flag))
  assert.match(source,/stageProviderExtensionsDependencies\(\{modulesRoot:sourceNodeModules/u)
  assert.match(source,/nativeModulesRoot:nativeModules/u)
})
