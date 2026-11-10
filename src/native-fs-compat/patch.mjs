import { createHash } from 'node:crypto'

export const NATIVE_FS_PACKAGE = '@deepseek-ai/dsh-fs-local'
export const NATIVE_FS_VERSION = '0.2.1-rc.5'
export const NATIVE_FS_INPUT_SHA256 = '63fbb41d2c33e07111884b798be507e68c2752acab8249c821c20ade436e894f'
export const NATIVE_FS_OUTPUT_SHA256 = 'e8e6be094b6358ba76037f7bea19dce133b460ade9993cbbe28436d460820bc8'
export const NATIVE_FS_SANDBOX_INPUT_SHA256 = 'cac65e21a0f0895b073cb9a447196ac265f2a171cc7f67c7434a6b3b7782caf5'
export const NATIVE_FS_SANDBOX_OUTPUT_SHA256 = '61c08dd59494f543ea78fc01386599bfd2e50d33a4842ce8ba74ac8a3dfb03aa'
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

export const NATIVE_FS_PROFILES = Object.freeze({
  [NATIVE_FS_VERSION]: { version:NATIVE_FS_VERSION, localInput:NATIVE_FS_INPUT_SHA256, localOutput:NATIVE_FS_OUTPUT_SHA256, sandboxInput:NATIVE_FS_SANDBOX_INPUT_SHA256, sandboxOutput:NATIVE_FS_SANDBOX_OUTPUT_SHA256, patch:'utf8-bom-edit-v1', cordis:'~4.0.5', lock:'native-fs-closure.lock.json' },
  '0.2.2-rc.1': { version:'0.2.2-rc.1', localInput:'d6d3115d4584a236746929d654ede98a0bc365fa4247567ba110971657fd7f90', localOutput:'acb678d9a54214dba5fa5741e67f20526b3e78c22d7f4ab7a27cb6bfaf394406', sandboxInput:'f4edd14bf48f8d5bfdea10a61c6651ccde99f2d08a79855746ad2a8d89c6fb73', sandboxOutput:'073725af208eeaae80a835db13f948d40e456d6c62ed0318724b46f9ddf4cca1', patch:'utf8-bom-edit-patch-move-v2', cordis:'~4.1.0', lock:'native-fs-closure-0.2.2-rc.1.lock.json' },
})
export function nativeFsProfile(version=NATIVE_FS_VERSION) { const profile=NATIVE_FS_PROFILES[version]; if(!profile)throw new Error('NATIVE_FS_COMPAT_VERSION_MISMATCH');return profile }

/** Patch only the pinned native edit read/write critical section; no runtime wrapper. */
export function applyNativeFsBomPatch(inputBytes, { packageVersion = NATIVE_FS_VERSION } = {}) {
  const profile=nativeFsProfile(packageVersion)
  if (!(inputBytes instanceof Uint8Array) || sha256(inputBytes) !== profile.localInput) throw new Error('NATIVE_FS_COMPAT_INPUT_HASH_MISMATCH')
  let source = Buffer.from(inputBytes).toString('utf8')
  const once = (before, after) => {
    if (source.split(before).length !== 2) throw new Error('NATIVE_FS_COMPAT_ANCHOR_MISMATCH')
    source = source.replace(before, after)
  }
  // TextDecoder consumes exactly the first UTF-8 BOM. Keep that byte-format
  // fact beside lineEndings, rather than exposing it in model-facing text.
  once('\t\tlineEndings: detectLineEndings(raw)\n',
    '\t\tlineEndings: detectLineEndings(raw),\n\t\tutf8Bom: buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf\n')
  once('\t\t\tconst content = restoreLineEndings(edited.content, original.lineEndings);',
    '\t\t\tconst content = (original.utf8Bom ? "\\uFEFF" : "") + restoreLineEndings(edited.content, original.lineEndings);')
  if(packageVersion==='0.2.2-rc.1') {
    once('writeFileAtomic(target.targetKey, restoreLineEndings(after, original.lineEndings),','writeFileAtomic(target.targetKey, (original.utf8Bom ? "\\uFEFF" : "") + restoreLineEndings(after, original.lineEndings),')
    once('const content = restoreLineEndings(after, original.lineEndings);','const content = (original.utf8Bom ? "\\uFEFF" : "") + restoreLineEndings(after, original.lineEndings);')
  }
  if(sha256(Buffer.from(source,'utf8'))!==profile.localOutput)throw new Error('NATIVE_FS_COMPAT_OUTPUT_HASH_MISMATCH')
  return Buffer.from(source, 'utf8')
}

/** Retain the native sandbox class, fences and exports; bind its patched superclass. */
export function applyNativeFsSandboxImportPatch(inputBytes, { packageVersion = NATIVE_FS_VERSION } = {}) {
  if(!NATIVE_FS_PROFILES[packageVersion])throw new Error('NATIVE_FS_SANDBOX_COMPAT_VERSION_MISMATCH')
  const profile=nativeFsProfile(packageVersion)
  if (!(inputBytes instanceof Uint8Array) || sha256(inputBytes) !== profile.sandboxInput) throw new Error('NATIVE_FS_SANDBOX_COMPAT_INPUT_HASH_MISMATCH')
  const source = Buffer.from(inputBytes).toString('utf8')
  const anchor = 'from "@deepseek-ai/dsh-fs-local"'
  if (source.split(anchor).length !== 2) throw new Error('NATIVE_FS_SANDBOX_COMPAT_ANCHOR_MISMATCH')
  return Buffer.from(source.replace(anchor, 'from "./local.js"'), 'utf8')
}
