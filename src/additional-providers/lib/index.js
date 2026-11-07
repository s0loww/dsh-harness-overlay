import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { builtinModels, builtinProviders } from '@earendil-works/pi-ai/providers/all'
import { LlmError, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { createController, noEnvironment, PROVIDER } from './controller.js'
import { createHandler, CONTROL_PATH } from './control.js'
import { aliasProvider } from './provider.js'

export const name = 'airules-additional-providers'
export const inject = ['llm', 'credentials']
export function apply(ctx) {
  const provider = aliasProvider(builtinProviders().find(row => row.id === 'kimi-coding'))
  const controller = createController({ credentials: ctx.credentials, key: credentialKey(name, 'kimi'), modelsFactory: builtinModels, provider })
  const profiles = new Map([[PROVIDER, {
    provider: PROVIDER, displayName: provider.name, piProvider: provider,
    streamIdleTimeoutMs: 300000, maxRequestImageBytes: 20971520, requestImagePixelBudget: 4194304, requestImageMaxBytes: 1048576,
    retryPolicy: resolveRetryPolicy(undefined), modelErrors: new Map(), configuredMaxTokens: new Map(),
  }]])
  const adapter = new PiAiAdapter({ profiles: () => profiles,
    async resolveApiKey() {
      if (!(await controller.store.read(PROVIDER))) throw new LlmError('Подключите Kimi в настройках дополнительных провайдеров.', 'MISSING_CREDENTIAL')
      return undefined
    }, auth: { credentials: controller.store, authContext: noEnvironment }, resolveAttachments: () => ctx.get('attachments'),
  })
  ctx.effect(() => ctx.llm.registerAdapter([PROVIDER], adapter))
  ctx.effect(() => () => controller.close())
  ctx.inject(['webServer', 'connection'], ready => ready.effect(() => ready.webServer.register({ kind: 'exact', path: CONTROL_PATH, handler: createHandler(controller, { connection: ready.connection }) })))
}
