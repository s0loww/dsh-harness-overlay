import test from 'node:test'
import assert from 'node:assert/strict'
import {policyPackageNames,verifyNewFeatureMounts} from '../installer/official-policy/common.mjs'
import {groupSections} from '../src/settings-shell/navigation.mjs'
const integrations={live2dCompanion:{package:'airules-dsh-live2d-companion',defaultEnabled:false,assets:'local-only',modelCalls:false},captainCompanion:{package:'airules-dsh-captain-companion',speech:'local-curated',modelCalls:false,avatar:'existing-native-pet'}}
test('companion installation is optional and pins local assets and no model execution',()=>{
 const packages=policyPackageNames({integrations});assert.ok(packages.includes(integrations.live2dCompanion.package));assert.ok(packages.includes(integrations.captainCompanion.package))
 for(const [key,field,value] of [['live2dCompanion','defaultEnabled',true],['live2dCompanion','assets','remote'],['captainCompanion','modelCalls',true],['captainCompanion','avatar','duplicate']]){const invalid=structuredClone(integrations);invalid[key][field]=value;assert.throws(()=>policyPackageNames({integrations:invalid}),/INTEGRATION_INVALID/)}
})
test('companion pages appear together under Interface without hiding third-party extensions',()=>{
 const groups=groupSections([{id:'airules-live2d-companion'},{id:'airules-captain-companion'},{id:'external'}]);assert.deepEqual(groups.map(x=>x.label),['Интерфейс','Другие расширения']);assert.deepEqual(groups[0].rows.map(x=>x.label),['Live2D-компаньон','Капитан Дизель'])
})
