window.__ModuleLoader__.load({ id: 'airules-dsh-providers-settings', factory: require => {
  const React = require('react'), h = React.createElement
  const native = require('@deepseek-ai/dsh-client-ui-settings-models').airulesProviders
  const accountNative = require('@deepseek-ai/dsh-client-ui-settings-account').airulesProvidersAccount
  const { SubscriptionProviderPanel } = require('airules-dsh-subscriptions')
  const { KimiSettings } = require('airules-dsh-additional-providers')
  const ID = 'airules-providers-settings'
  const EMPTY_BRIDGE = { getSnapshot: () => undefined, subscribe: () => () => {} }
  const SUBSCRIPTIONS = [{ id: 'codex', name: 'OpenAI Codex' }, { id: 'grok', name: 'Grok' }, { id: 'copilot', name: 'GitHub Copilot' }, { id: 'kimi', name: 'Kimi Code' }]
  function matches(row, query) { return !query.trim() || `${row.name} ${row.id} ${(row.models || []).map(model => `${model.id || ''} ${model.name || model.displayName || ''}`).join(' ')}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) }
  function useSource(source) {
    return React.useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
  }
  function hookFor(source) { return selector => selector(useSource(source)) }
  function AccountDetails({ face, t }) {
    const props = face
    const hooks = Object.fromEntries(Object.entries(props.hooks || {}).map(([name, source]) => [`use${name[0].toUpperCase()}${name.slice(1)}`, hookFor(source)]))
    return h(accountNative.AccountSection, { ...props, ...hooks, t })
  }
  function Card({ title, tag, children, count }) {
    const [open, setOpen] = React.useState(false)
    const [visited, setVisited] = React.useState(false)
    return h('details', { className: 'airulesProviderCard', onToggle: event => { setOpen(event.currentTarget.open); if (event.currentTarget.open) setVisited(true) } },
      h('summary', null, h('span', { className: 'airulesProviderMark', 'aria-hidden': true }, title.slice(0, 1)), h('strong', null, title), h('span', { className: 'airulesProviderTag' }, tag), count === undefined ? null : h('span', { className: 'airulesProviderCount' }, `${count} моделей`)),
      visited || open ? h('div', { className: 'airulesProviderBody', hidden: !open }, children) : null)
  }
  function ApiProvider({ row, api, state, models }) {
    const [error, setError] = React.useState(''), [removed, setRemoved] = React.useState(false), [busy, setBusy] = React.useState(false)
    const target = native.targetOf(row), namespace = state.namespaces.get(target.settingsNs)
    const remove = async () => {
      if (!window.confirm(`Удалить API-провайдера «${target.displayName}» и его управляемый ключ?`)) return
      setBusy(true)
      try { const failure = await native.removeProviderProfile(api.operations, api.controller, target); if (failure) setError(failure); else setRemoved(true) }
      catch { setError('Не удалось удалить провайдера. Обновите состояние и повторите.') } finally { setBusy(false) }
    }
    if (removed) return null
    return h(Card, { title: row.entry.displayName, tag: native.providerUsable(row) ? 'Подключён · API' : 'API · настройка', count: models.length },
      h('h4', null, 'Подключение и модели'),
      native.renderProviderEditor({ target, row, namespace, schema: api.schema, operations: api.operations, t: api.t, readOnly: !state.writable, onClose: changed => { if (changed) void api.controller.load() } }),
      models.length ? h('p', { className: 'airulesProviderModelList' }, models.map(model => model.name || model.displayName || model.id).join(' · ')) : null,
      error ? h('p', { role: 'alert' }, error) : null,
      row.removable ? h('button', { type: 'button', disabled: busy || !state.writable, onClick: remove }, 'Удалить API-провайдера') : null)
  }
  function NativeApiList({ api, query, groups }) {
    const state = useSource(api.controller.store)
    React.useEffect(() => { if (api.controller.store.getSnapshot().status === 'idle') void api.controller.load() }, [api.controller])
    if (state.status === 'error') return h('p', { role: 'alert' }, 'Не удалось загрузить провайдеров. ', h('button', { type: 'button', onClick: () => api.controller.load() }, 'Повторить'))
    if (state.status === 'idle' || state.status === 'loading' && !state.rows.length) return h('p', { role: 'status' }, 'Загрузка API-провайдеров…')
    const rows = state.rows.filter(row => row.entry.provider !== 'deepseek-account' && state.namespaces.has(row.entry.settingsNs))
    const piAi = state.namespaces.get('llm-pi-ai'), protocols = native.protocolChoices(piAi, api.schema)
    return h(React.Fragment, null,
      rows.map(row => {
        const models = groups.find(group => group.id === row.entry.provider)?.models || []
        return matches({ id: row.entry.provider, name: row.entry.displayName, models }, query) ? h(ApiProvider, { key: row.entry.provider, row, api, state, models }) : null
      }),
      !query && piAi && protocols.length ? h(Card, { title: 'Добавить свой API', tag: 'OpenAI и другие протоколы' }, h(native.CustomProviderCard, { taken: state.rows.map(row => row.entry.provider), protocols, reasoningLevels: native.reasoningLevelChoices(piAi, api.schema), revision: piAi.revision, operations: api.operations, t: api.t, readOnly: !state.writable, onClose: changed => { if (changed) void api.controller.load() } })) : null)
  }
  function ProvidersPage({ ctx, renderSlot }) {
    const [query, setQuery] = React.useState(''), [group, setGroup] = React.useState('all'), [groups, setGroups] = React.useState([]), [refreshNonce, setRefreshNonce] = React.useState(0), [notReady, setNotReady] = React.useState(false)
    const api = useSource(native || EMPTY_BRIDGE) || {}, accountFace = useSource(accountNative || EMPTY_BRIDGE)
    React.useEffect(() => {
      setNotReady(false)
      if (api.controller) return
      const timer = setTimeout(() => setNotReady(true), 8000)
      return () => clearTimeout(timer)
    }, [api.controller, refreshNonce])
    const providerModels = id => groups.find(row => row.id === id || id === 'kimi' && row.id === 'airules-kimi-coding')?.models || []
    const modelList = id => providerModels(id).length ? h('div', null, h('h4', null, 'Доступные модели'), h('p', { className: 'airulesProviderModelList' }, providerModels(id).map(model => model.name || model.displayName || model.id).join(' · '))) : null
    React.useEffect(() => {
      let current = true
      const refresh = async () => { try { const answer = await ctx.remote.session.modelCatalog(); if (current && answer.ok) setGroups(answer.value.groups) } catch {} }
      void refresh()
      const dispose = ctx.remote.$on('llm/adapters-updated', refresh)
      return () => { current = false; dispose() }
    }, [ctx, refreshNonce])
    return h('section', { className: 'airulesProviders', 'aria-label': 'Провайдеры и модели' },
      h('h2', null, 'Провайдеры и модели'), h('p', null, 'Подписки, аккаунты и API. Раскройте провайдера для подключения и настройки моделей.'),
      h('div', { className: 'airulesProvidersToolbar' }, h('input', { type: 'search', value: query, placeholder: 'Поиск провайдера или модели', 'aria-label': 'Поиск провайдера или модели', onChange: event => setQuery(event.target.value) }),
        h('select', { value: group, 'aria-label': 'Группа провайдеров', onChange: event => setGroup(event.target.value) }, h('option', { value: 'all' }, 'Все провайдеры'), h('option', { value: 'subscriptions' }, 'Подписки и аккаунты'), h('option', { value: 'api' }, 'API')),
        h('button', { type: 'button', onClick: () => { setRefreshNonce(value => value + 1); if (api.controller) void api.controller.load() } }, 'Обновить')),
      group !== 'api' ? h('details', { className: 'airulesProvidersGroup', open: true }, h('summary', null, 'Аккаунты и подписки'),
        matches({ id: 'deepseek-account', name: 'DeepSeek', models: providerModels('deepseek-account') }, query) ? h(Card, { title: 'DeepSeek', tag: 'Аккаунт DSH', count: providerModels('deepseek-account').length }, accountFace ? h(AccountDetails, { face: accountFace, t: ctx.locale.bind('settings.account') }) : renderSlot('settings.models.sign-in', {}), modelList('deepseek-account')) : null,
        SUBSCRIPTIONS.filter(row => matches({ ...row, models: providerModels(row.id) }, query)).map(row => h(Card, { key: row.id, title: row.name, tag: 'Подписка', count: providerModels(row.id).length }, row.id === 'kimi' ? h(KimiSettings) : h(SubscriptionProviderPanel, { providerId: row.id, rpc: ctx.connection.rpc, embedded: true }), modelList(row.id)))) : null,
      group !== 'subscriptions' ? h('details', { className: 'airulesProvidersGroup', open: true }, h('summary', null, 'API-провайдеры'), api.controller ? h(NativeApiList, { api, query, groups }) : !native?.getSnapshot || notReady ? h('p', { role: 'alert' }, 'Каталог API не готов. Нажмите «Обновить». Если ошибка повторится, проверьте загрузку штатного модуля настроек моделей.') : h('p', { role: 'status' }, 'Загрузка каталога API…')) : null)
  }
  const css = '.airulesProviders{max-width:920px;padding:24px;display:grid;gap:16px}.airulesProviders h2,.airulesProviders h3,.airulesProviders p{margin:0}.airulesProviders>p{color:var(--dsw-alias-label-secondary)}.airulesProvidersToolbar{display:flex;gap:10px;flex-wrap:wrap}.airulesProvidersToolbar input{flex:1;min-width:180px}.airulesProvidersToolbar input,.airulesProvidersToolbar select{padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit}.airulesProvidersGroup{display:grid;gap:10px}.airulesProviderCard{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}.airulesProviderCard>summary{padding:14px 16px;display:flex;align-items:center;gap:12px;cursor:pointer;list-style:revert}.airulesProviderMark{display:grid;place-items:center;width:32px;height:32px;border-radius:9px;background:var(--dsw-alias-interactive-bg-hover);font-weight:700}.airulesProviderTag,.airulesProviderCount{font-size:12px;color:var(--dsw-alias-label-tertiary)}.airulesProviderTag{margin-left:auto}.airulesProviderBody{padding:16px;border-top:1px solid var(--dsw-alias-border-l1);display:grid;gap:12px}.airulesProviderModelList{overflow-wrap:anywhere;font-size:12px;color:var(--dsw-alias-label-secondary)}'
  return { name: ID, inject: ['slots', 'connection', 'remote', 'remote.session', 'locale'], ProvidersPage, matches, SUBSCRIPTIONS,
    apply(ctx) {
      if (!SubscriptionProviderPanel || !KimiSettings) throw new Error('PROVIDERS_CLIENT_DEPENDENCY_REQUIRED')
      ctx.effect(() => { const style = document.createElement('style'); style.dataset.plugin = ID; style.textContent = css + '.airulesProviderBody[hidden]{display:none}.airulesProvidersGroup>summary{font-weight:600;cursor:pointer;padding:10px 0}.airulesProvidersGroup[open]>.airulesProviderCard{margin-top:10px}.airulesProviders button{font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:7px;padding:7px 12px;cursor:pointer}.airulesProviders button:disabled{opacity:.45;cursor:default}'; document.head.appendChild(style); return () => style.remove() })
      ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: ID, label: 'Провайдеры и модели', order: 9, inject: () => ({ ctx }), children: { 'settings.models.sign-in': { kind: 'single', scope: 'root' } } }, ProvidersPage))
    } }
} })
