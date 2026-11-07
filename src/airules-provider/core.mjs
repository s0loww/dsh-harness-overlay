import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export const RULEPACK_ID = 'airules-dsh-rulepack'
export const RULE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
export const ROLE_CAPABILITY = Object.freeze({
  status: 'prompt-adapter',
  nativeRoleRegistry: false,
  nativeExtensionPoint: null,
  reason: 'DSH exposes subagent execution providers and complete agent presets, but no named-role registry.',
})

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/u, '')) }
  catch (error) { throw new Error(`AIRULES_RULEPACK_INVALID_JSON: ${path}: ${error.message}`, { cause: error }) }
}

function inside(root, relativePath) {
  if (typeof relativePath !== 'string' || relativePath === '' || isAbsolute(relativePath)) {
    throw new Error('AIRULES_RULEPACK_UNSAFE_PATH')
  }
  const path = resolve(root, relativePath)
  const rel = relative(root, path)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('AIRULES_RULEPACK_UNSAFE_PATH')
  }
  return path
}

function verifiedBytes(root, manifest, relativePath) {
  const record = manifest.files?.[relativePath]
  if (!record || typeof record.sha256 !== 'string') {
    throw new Error(`AIRULES_RULEPACK_UNDECLARED_FILE: ${relativePath}`)
  }
  const path = inside(root, relativePath)
  const bytes = readFileSync(path)
  if (sha256(bytes) !== record.sha256) throw new Error(`AIRULES_RULEPACK_HASH_MISMATCH: ${relativePath}`)
  if (Number.isInteger(record.bytes) && record.bytes !== bytes.byteLength) {
    throw new Error(`AIRULES_RULEPACK_SIZE_MISMATCH: ${relativePath}`)
  }
  return bytes
}

function assertLogicalMcp(manifest) {
  const mcp = manifest.mcp
  if (!mcp || mcp.mode !== 'logical-only' || Object.keys(mcp).some(key => !['mode', 'logical_roles'].includes(key))) {
    throw new Error('AIRULES_RULEPACK_MCP_NOT_LOGICAL_ONLY')
  }
}

function exactKeys(value, keys, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code)
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(code)
}

function loadVerification(root, manifest) {
  const path = 'testing/default.json'
  const record = manifest.files?.[path]
  if (record?.id !== 'default' || record?.kind !== 'testing') {
    throw new Error('AIRULES_VERIFICATION_MANIFEST_INVALID')
  }
  const invalid = 'AIRULES_VERIFICATION_SCHEMA_INVALID'
  let value
  try { value = JSON.parse(verifiedBytes(root, manifest, path).toString('utf8').replace(/^\uFEFF/u, '')) }
  catch (error) {
    if (String(error?.message).includes('AIRULES_RULEPACK_')) throw error
    throw new Error(invalid, { cause: error })
  }
  exactKeys(value, ['checks', 'id', 'mutations', 'policy', 'schema_version'], invalid)
  if (value.schema_version !== 1 || value.id !== 'default' || value.policy !== 'project-overridable') throw new Error(invalid)
  if (!Array.isArray(value.checks) || value.checks.length !== 4) throw new Error(invalid)
  const expectedIds = ['doctor', 'analyze', 'deploy', 'test']
  for (let index = 0; index < expectedIds.length; index += 1) {
    const check = value.checks[index]
    exactKeys(check, ['binding', 'id', 'required'], invalid)
    if (check.id !== expectedIds[index] || check.binding !== 'project-defined' || typeof check.required !== 'boolean') {
      throw new Error(invalid)
    }
  }
  exactKeys(value.mutations, ['production_requires_explicit_approval', 'test_contour_required'], invalid)
  if (value.mutations.production_requires_explicit_approval !== true || value.mutations.test_contour_required !== true) {
    throw new Error(invalid)
  }
  return Object.freeze({
    ...value,
    checks: Object.freeze(value.checks.map(check => Object.freeze({ ...check }))),
    mutations: Object.freeze({ ...value.mutations }),
    path,
  })
}

export function loadRulepack(rulepackRoot) {
  const root = resolve(String(rulepackRoot ?? ''))
  if (!rulepackRoot || !statSync(root).isDirectory()) throw new Error('AIRULES_RULEPACK_ROOT_REQUIRED')
  const manifest = readJson(inside(root, 'manifest.json'))
  if (manifest.package?.id !== RULEPACK_ID || typeof manifest.package?.version !== 'string' || manifest.package.version === '') {
    throw new Error('AIRULES_RULEPACK_ID_OR_VERSION_INVALID')
  }
  assertLogicalMcp(manifest)
  const verification = loadVerification(root, manifest)

  const contractPath = 'contract/AGENTS.bundle.md'
  const contract = verifiedBytes(root, manifest, contractPath).toString('utf8').replace(/^\uFEFF/u, '')
  const rows = manifest.inventories?.rules
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('AIRULES_RULEPACK_RULES_MISSING')
  const rules = new Map()
  for (const row of rows) {
    if (!RULE_ID.test(row?.id ?? '') || typeof row?.path !== 'string' || rules.has(row.id)) {
      throw new Error('AIRULES_RULEPACK_RULE_INVENTORY_INVALID')
    }
    if (row.path !== `rules/${row.id}.md`) throw new Error(`AIRULES_RULEPACK_RULE_PATH_INVALID: ${row.id}`)
    if (row.sha256 !== manifest.files?.[row.path]?.sha256) {
      throw new Error(`AIRULES_RULEPACK_RULE_INVENTORY_HASH_INVALID: ${row.id}`)
    }
    const content = verifiedBytes(root, manifest, row.path).toString('utf8').replace(/^\uFEFF/u, '')
    rules.set(row.id, Object.freeze({
      id: row.id,
      path: row.path,
      kind: typeof row.kind === 'string' ? row.kind : 'rule',
      description: typeof row.description === 'string' ? row.description : '',
      content,
    }))
  }

  const roleRows = manifest.inventories?.roles
  if (!Array.isArray(roleRows) || roleRows.length === 0) throw new Error('AIRULES_RULEPACK_ROLES_MISSING')
  const roles = new Map()
  for (const row of roleRows) {
    if (!RULE_ID.test(row?.id ?? '') || typeof row?.path !== 'string' || roles.has(row.id)) {
      throw new Error('AIRULES_RULEPACK_ROLE_INVENTORY_INVALID')
    }
    if (row.path !== `roles/${row.id}.md`) throw new Error(`AIRULES_RULEPACK_ROLE_PATH_INVALID: ${row.id}`)
    if (row.sha256 !== manifest.files?.[row.path]?.sha256) {
      throw new Error(`AIRULES_RULEPACK_ROLE_INVENTORY_HASH_INVALID: ${row.id}`)
    }
    const content = verifiedBytes(root, manifest, row.path).toString('utf8').replace(/^\uFEFF/u, '')
    roles.set(row.id, Object.freeze({
      id: row.id,
      path: row.path,
      purpose: typeof row.purpose === 'string' ? row.purpose : '',
      tier: typeof row.tier === 'string' ? row.tier : '',
      effort: typeof row.effort === 'string' ? row.effort : '',
      content,
    }))
  }

  const skillsRoot = inside(root, 'skills')
  if (!statSync(skillsRoot).isDirectory()) throw new Error('AIRULES_RULEPACK_SKILLS_MISSING')
  return Object.freeze({
    root,
    version: manifest.package.version,
    manifest,
    contract,
    rules,
    roles,
    verification,
    skillsRoot,
  })
}

export function listRules(rulepack) {
  return [...rulepack.rules.values()]
    .sort((a, b) => a.id.localeCompare(b.id, 'en'))
    .map(row => `${row.id}: ${(row.description || row.kind).replace(/\s+/gu, ' ').slice(0, 240)}`)
    .join('\n')
}

export function readRule(rulepack, id) {
  if (!RULE_ID.test(String(id ?? ''))) throw new Error('AIRULES_RULE_ID_INVALID')
  const rule = rulepack.rules.get(id)
  if (!rule) throw new Error(`AIRULES_RULE_NOT_FOUND: ${id}`)
  return `Источник: embedded airules ${rulepack.version}/${rule.path}\n\n${rule.content}`
}

export function roleCapabilityStatus(rulepack) {
  return Object.freeze({ ...ROLE_CAPABILITY, roleCount: rulepack.roles.size })
}

export function listRoles(rulepack) {
  const status = roleCapabilityStatus(rulepack)
  const header = `capability: ${status.status}; native-role-registry: unavailable; roles: ${status.roleCount}`
  const rows = [...rulepack.roles.values()]
    .sort((a, b) => a.id.localeCompare(b.id, 'en'))
    .map(role => {
      const details = [role.purpose, role.tier && `tier=${role.tier}`, role.effort && `effort=${role.effort}`]
        .filter(Boolean).join('; ').replace(/\s+/gu, ' ').slice(0, 320)
      return `${role.id}: ${details}`
    })
  return [header, ...rows].join('\n')
}

export function readRole(rulepack, id) {
  if (!RULE_ID.test(String(id ?? ''))) throw new Error('AIRULES_ROLE_ID_INVALID')
  const role = rulepack.roles.get(id)
  if (!role) throw new Error(`AIRULES_ROLE_NOT_FOUND: ${id}`)
  return [
    `Источник: embedded airules ${rulepack.version}/${role.path}`,
    'Capability: prompt-adapter (DSH native named-role registry is unavailable).',
    'Оркестратор должен передать этот текст в prompt обычного subagent; это не отдельный execution provider.',
    '',
    role.content,
  ].join('\n')
}

