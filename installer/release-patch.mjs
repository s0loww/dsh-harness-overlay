import { readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { fileState, sha256 } from './fs-state.mjs'
import { applyReleasePatchFile, assertPatchMatchesBaseline } from '../src/release-patch.mjs'

const HASH = /^[a-f0-9]{64}$/u

export class ReleasePatchError extends Error {
  constructor(code, detail = '') {
    super(detail ? `${code}: ${detail}` : code)
    this.name = 'ReleasePatchError'
    this.code = code
  }
}

function portable(value, label) {
  if (typeof value !== 'string' || !value || isAbsolute(value) || value.includes('\\')) throw new ReleasePatchError('RELEASE_PATCH_PATH_INVALID', label)
  if (value.split('/').some(part => !part || part === '.' || part === '..')) throw new ReleasePatchError('RELEASE_PATCH_PATH_INVALID', label)
  return value
}

function beneath(root, rel, label) {
  const target = resolve(root, ...portable(rel, label).split('/'))
  const check = relative(resolve(root), target)
  if (!check || check.startsWith('..') || isAbsolute(check)) throw new ReleasePatchError('RELEASE_PATCH_PATH_INVALID', label)
  return target
}

function validateDescriptor(releasePatch, releaseId) {
  if (!releasePatch || releasePatch.required !== true || releasePatch.engine !== 'exact-text-replacements/v1' ||
      typeof releasePatch.id !== 'string' || !releasePatch.id || !Array.isArray(releasePatch.files) || !releasePatch.files.length) {
    throw new ReleasePatchError('RELEASE_PATCH_CONTRACT_INVALID')
  }
  portable(releasePatch.source, 'releasePatch.source')
  const seen = new Set()
  for (const file of releasePatch.files) {
    portable(file.target, 'releasePatch.files.target')
    if (seen.has(file.target) || !HASH.test(file.sourceSha256 ?? '') || !HASH.test(file.resultSha256 ?? '')) {
      throw new ReleasePatchError('RELEASE_PATCH_CONTRACT_INVALID', file.target)
    }
    seen.add(file.target)
  }
  return releaseId
}

function validateDocument(document, descriptor, releaseId) {
  if (!document || document.schemaVersion !== 1 || document.id !== descriptor.id || document.releaseId !== releaseId ||
      JSON.stringify(document.preset) !== JSON.stringify(descriptor.preset) || !Array.isArray(document.files) ||
      document.files.length !== descriptor.files.length) {
    throw new ReleasePatchError('RELEASE_PATCH_DOCUMENT_MISMATCH')
  }
  for (let index = 0; index < document.files.length; index += 1) {
    const file = document.files[index]
    const declared = descriptor.files[index]
    if (file.target !== declared.target || file.sourceSha256 !== declared.sourceSha256 || file.resultSha256 !== declared.resultSha256 ||
        !Array.isArray(file.replacements) || !file.replacements.length) {
      throw new ReleasePatchError('RELEASE_PATCH_DOCUMENT_MISMATCH', file.target ?? String(index))
    }
    for (const replacement of file.replacements) {
      if (typeof replacement.from !== 'string' || !replacement.from || typeof replacement.to !== 'string' ||
          !Number.isSafeInteger(replacement.count) || replacement.count < 1) {
        throw new ReleasePatchError('RELEASE_PATCH_REPLACEMENT_INVALID', file.target)
      }
    }
  }
}

export async function loadReleasePatch({ overlayRoot, manifest, baseline }) {
  if (manifest.schemaVersion === 1) return null
  if (manifest.schemaVersion !== 2) throw new ReleasePatchError('OVERLAY_SCHEMA_UNSUPPORTED', String(manifest.schemaVersion))
  const descriptor = manifest.releasePatch
  validateDescriptor(descriptor, manifest.target.releaseId)
  const sourcePath = beneath(overlayRoot, descriptor.source, 'releasePatch.source')
  let document
  try {
    document = JSON.parse((await readFile(sourcePath, 'utf8')).replace(/^\uFEFF/u, ''))
    assertPatchMatchesBaseline(document, baseline)
  } catch (error) {
    const code = error.message.split(':', 1)[0]
    throw new ReleasePatchError(code.startsWith('RELEASE_PATCH_') ? code : 'RELEASE_PATCH_DOCUMENT_INVALID', error.message.replace(/^RELEASE_PATCH_[A-Z_]+:?\s*/u, ''))
  }
  validateDocument(document, descriptor, manifest.target.releaseId)
  return { descriptor, document, sourcePath }
}

export async function prepareReleasePatch({ installRoot, overlayRoot, manifest, baseline, includeBytes = false }) {
  const loaded = await loadReleasePatch({ overlayRoot, manifest, baseline })
  if (!loaded) return []
  const operations = []
  for (const file of loaded.document.files) {
    const target = beneath(installRoot, file.target, 'releasePatch target')
    const sourceBytes = await readFile(target).catch(error => {
      throw new ReleasePatchError('RELEASE_PATCH_SOURCE_MISSING', file.target)
    })
    if (sha256(sourceBytes) !== file.sourceSha256) throw new ReleasePatchError('RELEASE_PATCH_SOURCE_HASH_MISMATCH', file.target)
    let afterBytes
    try {
      afterBytes = applyReleasePatchFile(sourceBytes, file)
    } catch (error) {
      const code = error.message.split(':', 1)[0]
      throw new ReleasePatchError(code, error.message.replace(/^RELEASE_PATCH_[A-Z_]+:?\s*/u, ''))
    }
    const replacementCount = file.replacements.reduce((sum, replacement) => sum + replacement.count, 0)
    const operation = {
      kind: 'patch-file',
      patchId: loaded.document.id,
      target,
      targetRelative: file.target,
      sourceSha256: file.sourceSha256,
      resultSha256: file.resultSha256,
      replacements: replacementCount,
      before: await fileState(target),
      after: { type: 'file', sha256: file.resultSha256, bytes: afterBytes.byteLength },
    }
    if (includeBytes) operation.afterBytes = afterBytes
    operations.push(operation)
  }
  return operations
}
