import { canonical, sha256 } from './fs-state.mjs'

export function backupDirectoryName(overlay) {
  return `${overlay.id}-${overlay.version}`.replace(/[^a-zA-Z0-9._-]/gu, '_')
}

export function sealReceipt(receipt) {
  const core = { ...receipt }
  delete core.integritySha256
  return { ...core, integritySha256: sha256(Buffer.from(canonical(core))) }
}

export function verifyReceiptIntegrity(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return false
  const expected = receipt.integritySha256
  if (!/^[a-f0-9]{64}$/u.test(expected ?? '')) return false
  return sealReceipt(receipt).integritySha256 === expected
}
