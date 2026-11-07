import { createHash } from 'node:crypto'

export const NATIVE_FS_PACKAGE = '@deepseek-ai/dsh-fs-local'
export const NATIVE_FS_VERSION = '0.2.1-rc.5'
export const NATIVE_FS_INPUT_SHA256 = '63fbb41d2c33e07111884b798be507e68c2752acab8249c821c20ade436e894f'
export const NATIVE_FS_OUTPUT_SHA256 = 'e8e6be094b6358ba76037f7bea19dce133b460ade9993cbbe28436d460820bc8'
export const NATIVE_FS_SANDBOX_INPUT_SHA256 = 'cac65e21a0f0895b073cb9a447196ac265f2a171cc7f67c7434a6b3b7782caf5'
export const NATIVE_FS_SANDBOX_OUTPUT_SHA256 = '61c08dd59494f543ea78fc01386599bfd2e50d33a4842ce8ba74ac8a3dfb03aa'
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

/** Patch only the pinned native edit read/write critical section; no runtime wrapper. */
export function applyNativeFsBomPatch(inputBytes, { packageVersion = NATIVE_FS_VERSION } = {}) {
  if (packageVersion !== NATIVE_FS_VERSION) throw new Error('NATIVE_FS_COMPAT_VERSION_MISMATCH')
  if (!(inputBytes instanceof Uint8Array) || sha256(inputBytes) !== NATIVE_FS_INPUT_SHA256) throw new Error('NATIVE_FS_COMPAT_INPUT_HASH_MISMATCH')
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
  return Buffer.from(source, 'utf8')
}

/** Retain the native sandbox class, fences and exports; bind its patched superclass. */
export function applyNativeFsSandboxImportPatch(inputBytes, { packageVersion = NATIVE_FS_VERSION } = {}) {
  if (packageVersion !== NATIVE_FS_VERSION) throw new Error('NATIVE_FS_SANDBOX_COMPAT_VERSION_MISMATCH')
  if (!(inputBytes instanceof Uint8Array) || sha256(inputBytes) !== NATIVE_FS_SANDBOX_INPUT_SHA256) throw new Error('NATIVE_FS_SANDBOX_COMPAT_INPUT_HASH_MISMATCH')
  const source = Buffer.from(inputBytes).toString('utf8')
  const anchor = 'from "@deepseek-ai/dsh-fs-local"'
  if (source.split(anchor).length !== 2) throw new Error('NATIVE_FS_SANDBOX_COMPAT_ANCHOR_MISMATCH')
  return Buffer.from(source.replace(anchor, 'from "./local.js"'), 'utf8')
}
