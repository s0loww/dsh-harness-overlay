import { createHash } from 'node:crypto'

export const NATIVE_MODELS_SHA256 = '08b5564cf240a6f0a5c77a0dabd80c6d88e4fd64afe3a470a92451b38ff35621'
export const NATIVE_ACCOUNT_SHA256 = 'f9326a7bd67b1c09dfb4a19291bbe7a2845bf4c9cadf3967e36d91625c77b0aa'
export const NATIVE_MODELS_022_SHA256 = '1f6842390a011ba2c9ac3e5862e40c80b37866756e3a777d90d57b1bd476e0cd'
export const NATIVE_ACCOUNT_022_SHA256 = '45fe700e38deef67063f677c446f2d59908278bee572a376d09ce9eb6bab7ec5'
const HASHES = Object.freeze({ '0.2.1-rc.5': { models: NATIVE_MODELS_SHA256, account: NATIVE_ACCOUNT_SHA256 }, '0.2.2-rc.1': { models: NATIVE_MODELS_022_SHA256, account: NATIVE_ACCOUNT_022_SHA256 } })
function expectedHash(hostVersion, kind) { const result = HASHES[hostVersion]?.[kind]; if (!result) throw new Error('NATIVE_PROVIDERS_HOST_MISMATCH'); return result }
const bridgeState = 'let airulesProvidersFace; const airulesProvidersListeners = new Set(); const airulesProvidersBridge = { getSnapshot: () => airulesProvidersFace, subscribe: fn => { airulesProvidersListeners.add(fn); return () => airulesProvidersListeners.delete(fn); } };'
const capture = expression => `const airulesCurrentFace = ${expression}; airulesProvidersFace = airulesCurrentFace; for (const fn of airulesProvidersListeners) fn(); ctx.effect(() => () => { if (airulesProvidersFace === airulesCurrentFace) { airulesProvidersFace = undefined; for (const fn of airulesProvidersListeners) fn(); } });\n`
const replaceOnce = (source, anchor, replacement) => {
  if (source.split(anchor).length !== 2) throw new Error('NATIVE_PROVIDERS_ANCHOR_MISMATCH')
  return source.replace(anchor, replacement)
}
export function patchNativeModelsClient(source, { hostVersion = '0.2.1-rc.5' } = {}) {
  if (createHash('sha256').update(source).digest('hex') !== expectedHash(hostVersion, 'models')) throw new Error('NATIVE_MODELS_HASH_MISMATCH')
  const anchor = '\t\texports.refreshIfLoaded = refreshIfLoaded;'
  if (source.split(anchor).length !== 2) throw new Error('NATIVE_MODELS_EXPORT_ANCHOR_MISMATCH')
  source = replaceOnce(source, '\t\tfunction apply(ctx) {', '\t\t' + bridgeState + '\n\t\tfunction apply(ctx) {')
  source = replaceOnce(source, '\t\t\tconst deepSeekOnboardingInjected = () => ({', '\t\t\t' + capture('injected()') + '\t\t\tconst deepSeekOnboardingInjected = () => ({')
  return source.replace(anchor, anchor + '\n\t\texports.airulesProviders = { ...airulesProvidersBridge, renderProviderEditor, targetOf, CustomProviderCard, protocolChoices, reasoningLevelChoices, removeProviderProfile, providerUsable };')
}

export function patchNativeAccountClient(source, { hostVersion = '0.2.1-rc.5' } = {}) {
  if (createHash('sha256').update(source).digest('hex') !== expectedHash(hostVersion, 'account')) throw new Error('NATIVE_ACCOUNT_HASH_MISMATCH')
  source = replaceOnce(source, '\t\tfunction apply(ctx) {', '\t\t' + bridgeState + '\n\t\tfunction apply(ctx) {')
  if (hostVersion === '0.2.2-rc.1') {
    const anchor = '\t\t\tctx.remoteAccess.whenAccess("account/watch", () => ctx.slots.inject("settings.models.sign-in",'
    // Publish the account face only during the real native access grant. Revocation
    // clears it; the original gated slot and all native login behavior remain intact.
    source = replaceOnce(source, anchor, `\t\t\tctx.remoteAccess.whenAccess("account/watch", () => {
                const airulesCurrentFace = operations;
                airulesProvidersFace = airulesCurrentFace;
                for (const fn of airulesProvidersListeners) fn();
                return () => { if (airulesProvidersFace === airulesCurrentFace) { airulesProvidersFace = undefined; for (const fn of airulesProvidersListeners) fn(); } };
            });\n${anchor}`)
  } else source = replaceOnce(source, '\t\t\tctx.slots.inject("settings.models.sign-in",', '\t\t\t' + capture('operations') + '\t\t\tctx.slots.inject("settings.models.sign-in",')
  return replaceOnce(source, '\t\texports.apply = apply;', '\t\texports.airulesProvidersAccount = { ...airulesProvidersBridge, AccountSection };\n\t\texports.apply = apply;')
}
