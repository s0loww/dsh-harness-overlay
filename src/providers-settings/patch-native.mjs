import { createHash } from 'node:crypto'

export const NATIVE_MODELS_SHA256 = '08b5564cf240a6f0a5c77a0dabd80c6d88e4fd64afe3a470a92451b38ff35621'
export const NATIVE_ACCOUNT_SHA256 = 'f9326a7bd67b1c09dfb4a19291bbe7a2845bf4c9cadf3967e36d91625c77b0aa'
const bridgeState = 'let airulesProvidersFace; const airulesProvidersListeners = new Set(); const airulesProvidersBridge = { getSnapshot: () => airulesProvidersFace, subscribe: fn => { airulesProvidersListeners.add(fn); return () => airulesProvidersListeners.delete(fn); } };'
const capture = expression => `const airulesCurrentFace = ${expression}; airulesProvidersFace = airulesCurrentFace; for (const fn of airulesProvidersListeners) fn(); ctx.effect(() => () => { if (airulesProvidersFace === airulesCurrentFace) { airulesProvidersFace = undefined; for (const fn of airulesProvidersListeners) fn(); } });\n`
const replaceOnce = (source, anchor, replacement) => {
  if (source.split(anchor).length !== 2) throw new Error('NATIVE_PROVIDERS_ANCHOR_MISMATCH')
  return source.replace(anchor, replacement)
}
export function patchNativeModelsClient(source) {
  if (createHash('sha256').update(source).digest('hex') !== NATIVE_MODELS_SHA256) throw new Error('NATIVE_MODELS_HASH_MISMATCH')
  const anchor = '\t\texports.refreshIfLoaded = refreshIfLoaded;'
  if (source.split(anchor).length !== 2) throw new Error('NATIVE_MODELS_EXPORT_ANCHOR_MISMATCH')
  source = replaceOnce(source, '\t\tfunction apply(ctx) {', '\t\t' + bridgeState + '\n\t\tfunction apply(ctx) {')
  source = replaceOnce(source, '\t\t\tconst deepSeekOnboardingInjected = () => ({', '\t\t\t' + capture('injected()') + '\t\t\tconst deepSeekOnboardingInjected = () => ({')
  return source.replace(anchor, anchor + '\n\t\texports.airulesProviders = { ...airulesProvidersBridge, renderProviderEditor, targetOf, CustomProviderCard, protocolChoices, reasoningLevelChoices, removeProviderProfile, providerUsable };')
}

export function patchNativeAccountClient(source) {
  if (createHash('sha256').update(source).digest('hex') !== NATIVE_ACCOUNT_SHA256) throw new Error('NATIVE_ACCOUNT_HASH_MISMATCH')
  source = replaceOnce(source, '\t\tfunction apply(ctx) {', '\t\t' + bridgeState + '\n\t\tfunction apply(ctx) {')
  source = replaceOnce(source, '\t\t\tctx.slots.inject("settings.models.sign-in",', '\t\t\t' + capture('operations') + '\t\t\tctx.slots.inject("settings.models.sign-in",')
  return replaceOnce(source, '\t\texports.apply = apply;', '\t\texports.airulesProvidersAccount = { ...airulesProvidersBridge, AccountSection };\n\t\texports.apply = apply;')
}
