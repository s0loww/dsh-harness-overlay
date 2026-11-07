import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'

const HEX256 = /^[a-f0-9]{64}$/u
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

function portableTarget(value, label) {
  if (typeof value !== 'string' || !value || isAbsolute(value) || value.includes('\\')) {
    throw new Error(`RELEASE_PATCH_UNSAFE_PATH: ${label}`)
  }
  const parts = value.split('/')
  if (parts.some(part => !part || part === '.' || part === '..')) {
    throw new Error(`RELEASE_PATCH_UNSAFE_PATH: ${label}`)
  }
  if (parts.includes('.desktop-local') || parts.includes('.dsh-1c')) {
    throw new Error(`RELEASE_PATCH_RUNTIME_STATE_FORBIDDEN: ${label}`)
  }
  return value
}

export function validateReleasePatch(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec) || spec.schemaVersion !== 1) {
    throw new Error('RELEASE_PATCH_INVALID_SCHEMA')
  }
  if (typeof spec.id !== 'string' || !spec.id || typeof spec.releaseId !== 'string' || !spec.releaseId) {
    throw new Error('RELEASE_PATCH_INVALID_IDENTITY')
  }
  if (!spec.preset || spec.preset.id !== '1c-airules' || spec.preset.label !== '1С') {
    throw new Error('RELEASE_PATCH_INVALID_PRESET')
  }
  if (!Array.isArray(spec.files) || spec.files.length === 0) throw new Error('RELEASE_PATCH_FILES_REQUIRED')
  const seen = new Set()
  for (const [fileIndex, file] of spec.files.entries()) {
    const label = `files[${fileIndex}]`
    portableTarget(file?.target, `${label}.target`)
    if (seen.has(file.target)) throw new Error(`RELEASE_PATCH_DUPLICATE_TARGET: ${file.target}`)
    seen.add(file.target)
    if (!HEX256.test(file.sourceSha256 ?? '') || !HEX256.test(file.resultSha256 ?? '')) {
      throw new Error(`RELEASE_PATCH_INVALID_HASH: ${file.target}`)
    }
    if (!Array.isArray(file.replacements) || file.replacements.length === 0) {
      throw new Error(`RELEASE_PATCH_REPLACEMENTS_REQUIRED: ${file.target}`)
    }
    for (const [operationIndex, operation] of file.replacements.entries()) {
      if (typeof operation?.from !== 'string' || !operation.from || typeof operation.to !== 'string' || operation.from === operation.to) {
        throw new Error(`RELEASE_PATCH_INVALID_REPLACEMENT: ${file.target}#${operationIndex + 1}`)
      }
      if (!Number.isSafeInteger(operation.count) || operation.count < 1) {
        throw new Error(`RELEASE_PATCH_INVALID_COUNT: ${file.target}#${operationIndex + 1}`)
      }
    }
  }
  return spec
}

function occurrences(text, needle) {
  let count = 0
  for (let offset = 0; ; offset += needle.length) {
    offset = text.indexOf(needle, offset)
    if (offset < 0) return count
    count += 1
  }
}

export function applyReleasePatchFile(input, file, { verifySource = true, verifyResult = true } = {}) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input)
  if (verifySource && sha256(bytes) !== file.sourceSha256) {
    throw new Error(`RELEASE_PATCH_SOURCE_HASH_MISMATCH: ${file.target}`)
  }
  let text = bytes.toString('utf8')
  for (const [index, operation] of file.replacements.entries()) {
    const found = occurrences(text, operation.from)
    if (found !== operation.count) {
      throw new Error(`RELEASE_PATCH_MATCH_COUNT_MISMATCH: ${file.target}#${index + 1} expected ${operation.count}, found ${found}`)
    }
    text = text.split(operation.from).join(operation.to)
  }
  const result = Buffer.from(text, 'utf8')
  if (verifyResult && sha256(result) !== file.resultSha256) {
    throw new Error(`RELEASE_PATCH_RESULT_HASH_MISMATCH: ${file.target}`)
  }
  return result
}

export function assertPatchMatchesBaseline(spec, baseline) {
  validateReleasePatch(spec)
  if (spec.releaseId !== baseline?.releaseId) throw new Error('RELEASE_PATCH_RELEASE_MISMATCH')
  for (const file of spec.files) {
    if (baseline.sourceFiles?.[file.target] !== file.sourceSha256) {
      throw new Error(`RELEASE_PATCH_BASELINE_HASH_MISMATCH: ${file.target}`)
    }
  }
  return spec
}
