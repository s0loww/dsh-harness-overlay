import { PROVIDER } from './controller.js'
export function aliasProvider(native) {
  if (!native || typeof native.getModels !== 'function') throw new Error('KIMI_PROVIDER_UNAVAILABLE')
  const alias = model => ({ ...model, provider: PROVIDER })
  return { ...native, id: PROVIDER, name: 'Kimi Code · отдельная подписка',
    getModels: (...args) => native.getModels(...args).map(alias),
    getAllModels: (...args) => (native.getAllModels?.(...args) ?? native.getModels(...args)).map(alias),
  }
}
