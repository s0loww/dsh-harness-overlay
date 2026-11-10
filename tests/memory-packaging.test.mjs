import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { policyPackageNames, verifyNewFeatureMounts } from '../installer/official-policy/common.mjs'
import { createPresets } from '../src/domain-presets/composition.mjs'
import { stageOfficialPolicy } from '../scripts/stage-official-policy.mjs'
import { groupSections } from '../src/settings-shell/navigation.mjs'
const feature = { package:'airules-dsh-memory-workspace', defaultEnabled:false, endpoint:'machine-loopback', scope:'native-project-dataset', processing:'explicit-local', migration:false, policyOwner:'project_rules' }
const manifest = { integrations: { memoryWorkspace: feature } }
test('portable memory companions stay opt-in and installer rejects forged authority or missing owner',async()=>{
  const integrations={memoryWorkspace:feature,historyRecall:{package:'airules-dsh-history-recall',scope:'custom-presets-only',automaticWrites:false},skillEvaluation:{package:'airules-dsh-skill-evaluation',scope:'custom-presets-only',automaticWrites:false},reviewedKnowledge:{package:'airules-reviewed-knowledge',scope:'custom-presets-only',automaticWrites:false}}
  const names=policyPackageNames({integrations})
  for(const key of ['historyRecall','skillEvaluation','reviewedKnowledge']) {
    assert.ok(names.includes(integrations[key].package))
    assert.throws(()=>policyPackageNames({integrations:{...integrations,[key]:{...integrations[key],automaticWrites:true}}}),/POLICY_INTEGRATION_INVALID/)
    for(const preset of createPresets({[key]:true})) assert.equal(preset.plugins.filter(row=>row.name===integrations[key].package+'/agent').length,1)
    for(const preset of createPresets()) assert.equal(preset.plugins.filter(row=>row.name===integrations[key].package+'/agent').length,0)
  }
  assert.throws(()=>policyPackageNames({integrations:{reviewedKnowledge:integrations.reviewedKnowledge}}),/POLICY_INTEGRATION_INVALID/)
  await assert.rejects(stageOfficialPolicy({includeReviewedKnowledge:true}),/REQUIRES_MEMORY_WORKSPACE/)
  for(const option of ['includeHistoryRecall','includeSkillEvaluation','includeReviewedKnowledge']) await assert.rejects(stageOfficialPolicy({[option]:'true'}),/BOOLEAN_OPTION_REQUIRED/)
})
test('memory artifact declares disabled machine-local connection with no data or embedded endpoint', () => {
  assert.ok(policyPackageNames(manifest).includes(feature.package))
  const ordered=policyPackageNames({integrations:{onecPanels:{package:'airules-dsh-onec-panels',metadataReadOnly:true,root:'selected-session',background:'native-jobs-reviewed-mcp',defaultBackgroundTools:0},memoryWorkspace:feature}})
  assert.equal(ordered[ordered.indexOf('airules-dsh-onec-panels')+1],feature.package)
  for (const field of [{defaultEnabled:true},{endpoint:'http://127.0.0.1:18080'},{migration:true},{apiKey:'SECRET'}]) assert.throws(() => policyPackageNames({integrations:{memoryWorkspace:{...feature,...field}}}), /POLICY_INTEGRATION_INVALID/)
})
test('only custom domain compositions receive memory tools, only when selected', () => {
  for (const enabled of [false,true]) for (const preset of createPresets({memory:enabled})) assert.equal(preset.plugins.filter(row=>row.name==='airules-dsh-memory-workspace/tools').length, enabled?1:0)
  assert.throws(()=>createPresets({memory:'true'}),/MEMORY_BOOLEAN_REQUIRED/)
})
test('memory host and scoped tool mounts have exact cardinality and no extra host config', () => {
  const fragment = `- insert:\n    - id: preset-1c-airules\n      name: '@deepseek-ai/dsh-agent-preset'\n      config:\n        id: 1c-airules\n        plugins:\n          - id: airules-memory-tools\n            name: airules-dsh-memory-workspace/tools\n- insert:\n    - id: airules-memory\n      name: airules-dsh-memory-workspace\n    - id: airules-onec-bsl-editor\n      name: dsh-bsl-editor\n- id: agent-preset-registry\n  config:\n    default: 1c-airules\n`
  verifyNewFeatureMounts(fragment,manifest.integrations)
  assert.throws(()=>verifyNewFeatureMounts(fragment.replace('      name: airules-dsh-memory-workspace\n','      name: airules-dsh-memory-workspace\n      config: { enabled: true }\n'),manifest.integrations),/POLICY_NEW_FEATURE_MOUNT_INVALID/)
  assert.throws(()=>verifyNewFeatureMounts(fragment.replace('          - id: airules-memory-tools','          - id: unowned-memory-tools'),manifest.integrations),/POLICY_NEW_FEATURE_TOOL_SCOPE_INVALID/)
})
test('memory boolean validated before artifact IO and settings groups it beside skills',async()=>{
  await assert.rejects(stageOfficialPolicy({includeMemoryWorkspace:'true'}),/BOOLEAN_OPTION_REQUIRED/)
  assert.equal(groupSections([{id:'airules-memory',label:'Memory'}])[0].label,'Контекст и история')
  const source=await readFile(new URL('../scripts/stage-official-policy.mjs',import.meta.url),'utf8')
  assert.ok(source.includes("'--include-memory-workspace'"))
  assert.ok(source.includes("...(includeMemoryWorkspace ? ['memory-workspace'] : [])"))
})
