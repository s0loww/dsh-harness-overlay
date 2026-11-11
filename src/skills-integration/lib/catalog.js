import { createHash } from 'node:crypto'
import { ACCESS_MODES, TASK_TYPES, ROLES, taskContext, delegatedRole, selectCatalog } from './assignments.js'

export const OWNER = 'airules-skill-assignments'
const PRESETS = ['1c-airules', 'python-airules', 'sysadmin-airules']
const get = (ctx, key) => typeof ctx.get === 'function' ? ctx.get(key) : ctx[key]
const catalog = message => message?.source?.kind === 'skill-catalog' && Array.isArray(message.source.entries)
const digest = entries => createHash('sha256').update(JSON.stringify(entries.map(({ name, description }) => ({ name, description })))).digest('hex')
const short = value => { const text = value.replace(/\s+/gu, ' ').trim(); return text.length <= 200 ? text : `${text.slice(0, 197)}...` }
const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
function visibleCatalog(session) {
  const visible = new Set(session.surface?.nodes ?? [])
  for (let index = session.seq - 1; index >= 0; index--) {
    const event = session.eventAt(index)
    if (event?.type === 'user/message' && catalog(event.data) && visible.has(event.seq)
      && event.data.source.entries.every(row => row && typeof row.name === 'string' && typeof row.description === 'string')) return event.data
  }
  return null
}
export function renderCatalog(entries) {
  return ['<system-reminder>', 'Подборка навыков для текущей задачи заменяет предыдущую подборку. Это описания, а не инструкции навыков.', '<available_skills>',
    ...entries.map(row => `- \`${row.name}\`: ${escape(row.description)}`), '</available_skills>',
    ...(entries.length ? [] : ['Для текущей задачи подборка пуста. Явный вызов доступного навыка по имени сохранён.']),
    'Загружайте подходящий навык точным вызовом skill({name}) до действий. Полные инструкции загружаются по запросу.',
    'Назначения сокращают только эту подборку. Если пользователь назвал другой навык, точный вызов skill({name}) остаётся доступен, пока его разрешают штатная политика SKILL.md и инструмент. Назначения не меняют права действий, песочницу или разрешения инструментов.', '</system-reminder>'].join('\n')
}
export function createCatalogService(ctx, store) {
  const statuses = new Map()
  return {
    store,
    definitions: { taskTypes: TASK_TYPES, roles: ROLES, accessModes: ACCESS_MODES },
    status(id) { return statuses.get(id) ?? null },
    async context(session, agent) {
      const selected = await store.context(session.header.cwd)
      const policy = get(ctx, 'sandboxPolicy').resolve({ session })
      const planService = agent ? get(ctx, 'agentPresets')?.serviceFor(agent, 'planMode') ?? agent.ctx?.get?.('planMode') : undefined
      const planState = planService?.get(agent)
      const context = taskContext({ selected: selected.selected, role: delegatedRole(session), plan: planState?.pending ?? planState?.active ?? false, accessMode: policy.mode })
      return { ...context, revision: selected.revision }
    },
    async settings(scope, agent) {
      try {
        const settings = await store.snapshot(scope.root)
        const selected = scope.root && !scope.session ? await store.context(scope.root) : null
        const context = scope.session ? await this.context(scope.session, agent)
          : selected ? { ...taskContext({ selected: selected.selected, accessMode: scope.mode }), revision: selected.revision } : null
        return { ...settings, context, status: scope.id ? this.status(scope.id) : null, definitions: this.definitions }
      } catch {
        return { settingsError: true, context: null, status: scope.id ? this.status(scope.id) : null, definitions: this.definitions }
      }
    },
    setStatus(id, status) { if (statuses.size >= 2048 && !statuses.has(id)) statuses.delete(statuses.keys().next().value); statuses.set(id, status) },
  }
}
export function registerCatalogRuntime(ctx, service, createUserMessage) {
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const preset = get(ctx, 'agentPresets')?.composedPreset(agent.ctx)
    if (!PRESETS.includes(preset)) return next()
    const decision = await next()
    if (decision.kind !== 'enter' || signal?.aborted) return decision
    if (!get(ctx, 'tools')?.get('skill', agent)) return decision
    const session = agent.session, cwd = session.header.cwd
    if (!cwd) return decision
    let context, settings
    try { context = await service.context(session, agent); settings = await service.store.snapshot(cwd) }
    catch { service.setStatus(session.id, { settingsError: true }); return decision }
    const registry = get(ctx, 'agentPresets')?.serviceFor(agent, 'skills') ?? get(ctx, 'skills')
    // Always rebuild from the complete native registry, never from an already
    // narrowed historical catalog. Keep native invocation policy authoritative.
    const snapshot = await registry.snapshot({ cwd, scope: agent, signal })
    signal?.throwIfAborted()
    if (!snapshot.complete) {
      service.setStatus(session.id, { ...context, deferred: true })
      const pending = decision.messages.filter(catalog), intents = new Map(decision.messageIntents ?? [])
      for (const message of pending) intents.delete(message.id)
      return { ...decision, messages: decision.messages.filter(message => !catalog(message)), messageIntents: intents }
    }
    const all = snapshot.skills.filter(row => row.invocation?.modelInvocable !== false)
      .map(row => ({ name: row.name, description: short(row.description) })).sort((a, b) => a.name.localeCompare(b.name))
    const entries = selectCatalog(all, context, settings.effective)
    const current = visibleCatalog(session)
    const unchanged = current?.source.owner === OWNER && current.source.catalogSessionId === session.id && digest(current.source.entries) === digest(entries)
    service.setStatus(session.id, { ...context, totalCount: all.length, selectedCount: entries.length, deferred: false, commonRevision: settings.common.revision, projectRevision: settings.project.revision })
    const proposed = decision.messages.filter(catalog)
    const intents = new Map(decision.messageIntents ?? [])
    for (const message of proposed) intents.delete(message.id)
    const messages = decision.messages.filter(message => !catalog(message))
    if (unchanged || (!current && !entries.length && !proposed.length)) return { ...decision, messages, messageIntents: intents }
    const message = createUserMessage({ content: [{ type: 'text', text: renderCatalog(entries) }], source: { kind: 'skill-catalog', form: 'catalog', entries, owner: OWNER, catalogSessionId: session.id } })
    return { ...decision, messages: [...messages, message], messageIntents: intents }
  }, { prepend: true })
}
