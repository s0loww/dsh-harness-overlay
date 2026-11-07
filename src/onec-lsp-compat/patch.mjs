import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const ONEC_LSP_HOST_VERSION = '0.2.1-rc.5'
export const ONEC_LSP_PACKAGE_VERSION = '0.4.6'
export const ONEC_LSP_MANIFEST_SHA256 = '1dae01aea122a306e75e66b6da59ca575f6391047383cfd77e88ac54ed2cecb3'
export const ONEC_LSP_ENTRY_SHA256 = 'fe97ed31ea6e0e7c409330cd811e0f81413a2b8b310d8e23646a0fed781377bf'
export const ONEC_LSP_STAGED_MANIFEST_SHA256 = 'c11a7e46d5866d462e02fcefcaf100574dba6818b93c8e32dcd994855d325ab9'
export const ONEC_LSP_TOOL_NAMES = Object.freeze(['lsp_diagnostics', 'lsp_completion', 'lsp_format', 'lsp_code_action', 'lsp_symbols', 'lsp_signature', 'lsp_inlay_hints', 'lsp_rename'])
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

/** Exact managed compatibility declaration; never grants profile exemptions. */
export function patchOnecLspManifest(manifestBytes, entryBytes, { hostVersion = ONEC_LSP_HOST_VERSION } = {}) {
  if (hostVersion !== ONEC_LSP_HOST_VERSION) throw new Error('ONEC_LSP_COMPAT_HOST_MISMATCH')
  if (!(manifestBytes instanceof Uint8Array) || sha(manifestBytes) !== ONEC_LSP_MANIFEST_SHA256) throw new Error('ONEC_LSP_COMPAT_MANIFEST_DRIFT')
  if (!(entryBytes instanceof Uint8Array) || sha(entryBytes) !== ONEC_LSP_ENTRY_SHA256) throw new Error('ONEC_LSP_COMPAT_ENTRY_DRIFT')
  const pkg = JSON.parse(Buffer.from(manifestBytes).toString('utf8'))
  if (pkg.name !== 'dsh-lsp-actions' || pkg.version !== ONEC_LSP_PACKAGE_VERSION || Object.hasOwn(pkg.engines ?? {}, 'dsh')) throw new Error('ONEC_LSP_COMPAT_IDENTITY_MISMATCH')
  pkg.engines = { ...pkg.engines, dsh: hostVersion }
  const output = Buffer.from(JSON.stringify(pkg, null, 2) + '\n')
  if (sha(output) !== ONEC_LSP_STAGED_MANIFEST_SHA256) throw new Error('ONEC_LSP_COMPAT_OUTPUT_DRIFT')
  return { manifestBytes: output, adaptation: { sourceManifestSha256: ONEC_LSP_MANIFEST_SHA256, stagedManifestSha256: sha(output), sourceEntrySha256: ONEC_LSP_ENTRY_SHA256,
    hostVersion, contract: 'exact-rc5-native-agent-lsp-admission-no-server-proof' } }
}

export function verifyOnecLspCompatibility(manifestBytes, entryBytes) {
  if (sha(manifestBytes) !== ONEC_LSP_STAGED_MANIFEST_SHA256 || sha(entryBytes) !== ONEC_LSP_ENTRY_SHA256) throw new Error('ONEC_LSP_COMPAT_STAGED_DRIFT')
  return { sourceManifestSha256: ONEC_LSP_MANIFEST_SHA256, stagedManifestSha256: ONEC_LSP_STAGED_MANIFEST_SHA256, sourceEntrySha256: ONEC_LSP_ENTRY_SHA256,
    hostVersion: ONEC_LSP_HOST_VERSION, contract: 'exact-rc5-native-agent-lsp-admission-no-server-proof' }
}

/** Called only for the builder's owned package copy before artifact sealing. */
export async function adaptOnecLspPackage(directory, options) {
  const manifestPath = join(directory, 'package.json')
  const [manifest, entry] = await Promise.all([readFile(manifestPath), readFile(join(directory, 'lib/index.js'))])
  const result = patchOnecLspManifest(manifest, entry, options)
  await writeFile(manifestPath, result.manifestBytes)
  return result.adaptation
}
