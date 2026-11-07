import assert from 'node:assert/strict'
import test from 'node:test'
import { policyPackageNames } from '../installer/official-policy/common.mjs'

test('new capabilities have a fixed package allowlist and no bootstrap or mutation switches', () => {
  const additionalProviders = { package: 'airules-dsh-additional-providers', authentication: 'explicit-user-action', bootstrap: false }
  const onecPanels = { package: 'airules-dsh-onec-panels', readOnly: true, root: 'selected-session' }
  const projectSettings = { package: 'airules-dsh-project-settings', bindings: 'project-local', deploy: false, mcp: false }
  assert.equal(policyPackageNames({ integrations: { projectSettings } }).at(-1), projectSettings.package)
  const modelOrchestration = { package: 'airules-dsh-model-orchestration', enabledByUser: true, bindings: 'role-and-pool', globalInterception: false }
  const domainPresets = { package: 'airules-dsh-domain-presets', presets: ['python-airules', 'sysadmin-airules'], mcp: false, policyOwner: 'project_rules' }
  assert.deepEqual(policyPackageNames({ integrations: { modelOrchestration, domainPresets } }).slice(-2), [modelOrchestration.package, domainPresets.package])
  assert.deepEqual(policyPackageNames({ integrations: { additionalProviders, onecPanels } }).slice(-2), [additionalProviders.package, onecPanels.package])
  for (const integrations of [
    { additionalProviders: { ...additionalProviders, bootstrap: true } },
    { additionalProviders: { ...additionalProviders, token: 'fixture' } },
    { onecPanels: { ...onecPanels, readOnly: false } },
    { onecPanels: { ...onecPanels, root: 'arbitrary' } },
    { projectSettings: { ...projectSettings, mcp: true } },
    { projectSettings: { ...projectSettings, deploy: true } },
    { modelOrchestration: { ...modelOrchestration, globalInterception: true } },
    { domainPresets: { ...domainPresets, mcp: true } },
    { domainPresets: { ...domainPresets, policyOwner: 'foreign' } },
  ]) assert.throws(() => policyPackageNames({ integrations }), /POLICY_INTEGRATION_INVALID/)
})
