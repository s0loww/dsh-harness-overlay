import { lstatSync, readdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { isUserInvocable, renderSkillContent } from '@deepseek-ai/dsh-skill'
import { agentEffectiveMode, taskModeFor, taskModeLabel, CLI_PATH, CLI_ROOT, openSpecEnabled, projectFeatures } from './runtime.js'
import { ticketOnly, ticketProposeInstructions, parseTicketBatch, parseTicketSource, ticketBatchInstructions, parseTicketDescriptionMode, parseTicketRequest } from './openspec-tickets.js'

const cli = CLI_PATH
export const CANONICAL_SKILLS = Object.freeze({ explore: 'openspec-explore', propose: 'openspec-propose', apply: 'openspec-apply-change', 'apply-all': 'openspec-apply-change', update: 'openspec-update', sync: 'openspec-sync', archive: 'openspec-archive-change' })
export const OPENSPEC_WORKFLOWS = Object.freeze({
  explore: 'Исследовать идею и проект без изменения файлов',
  propose: 'Создать предложение OpenSpec: можно указать только тикет, ключ или ссылку',
  apply: 'Разработать выбранную спецификацию OpenSpec',
  'apply-all': 'Последовательно разработать все активные спецификации в текущем чате',
  update: 'Уточнить выбранный документ OpenSpec без реализации',
  sync: 'Перенести delta specs в основные specs без архивации',
  archive: 'Проверить и архивировать завершённую спецификацию OpenSpec',
})

/** Reuse the native task-mode command: it persists the choice and never raises access. */
export async function selectOpenSpecTaskMode(ctx, agent, taskMode, signal = new AbortController().signal) {
  if (!projectFeatures(ctx, agent).full) return { kind: 'success', text: 'Режим доступа сохранён.' }
  const dispatched = await ctx.commands.execute(agent, '/taskmode ' + taskMode, [], signal)
  if (dispatched?.result?.kind !== 'success' || taskModeFor(ctx, agent) !== taskMode) {
    throw new Error(dispatched?.result?.text || 'Не удалось выбрать тип задачи для текущего чата. Проверьте /taskmode.')
  }
  return dispatched.result
}

function activeChanges(cwd) {
  try {
    for (const path of [join(cwd, 'openspec'), join(cwd, 'openspec', 'changes')]) {
      if (lstatSync(path).isSymbolicLink()) throw new Error('OpenSpec: каталог changes не должен быть ссылкой.')
    }
    const entries = readdirSync(join(cwd, 'openspec', 'changes'), { withFileTypes: true })
    if (entries.length > 100) throw new Error('OpenSpec: в каталоге changes превышен лимит 100 записей.')
    return entries
      .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && entry.name !== 'archive' && /^[a-z0-9][a-z0-9-]{0,127}$/u.test(entry.name))
      .map(entry => entry.name).sort()
  } catch (error) { if (error.code === 'ENOENT') return []; throw error }
}

/** Slash results are outside model history: submit the loaded skill explicitly. */
export function registerOpenSpecCommands(ctx) {
  for (const [workflow, description] of Object.entries(OPENSPEC_WORKFLOWS)) {
    const name = 'opsx-' + workflow
    ctx.commands.register({
      name, description,
      input: { hint: workflow === 'explore' ? '[тема или change]' : workflow === 'apply-all' ? '[дополнительные указания]' : workflow === 'propose' ? '[описание или только тикет ABC-123 / ссылка]' : '[change или описание]' },
      recordInput: false,
      async handler(invocation) {
        const error = text => ({ kind: 'error', text })
        const agent = invocation?.agent
        if (!openSpecEnabled(ctx, agent)) return error('OpenSpec отключён для этого чата. Включите плагин в настройках проекта и создайте новый чат.')
        const cwd = agent?.session?.header?.cwd
        if (!agent?.session?.id || !isAbsolute(cwd ?? '') || typeof agent.followup !== 'function'
          || !['idle', 'running'].includes(agent.status) || agent.ctx?.fiber?.uid === null) {
          return error('OpenSpec: откройте активный чат с выбранной папкой проекта.')
        }
        const mode = agentEffectiveMode(agent, ctx)
        if (workflow !== 'explore' && mode !== 'build') {
          return error('/' + name + ' требует BUILD. В режиме ' + mode.toUpperCase() + ' доступно /opsx-explore; для выполнения выберите /mode build (и завершите режим аналитики, если он включён).')
        }
        const skillName = CANONICAL_SKILLS[workflow]
        invocation.signal?.throwIfAborted()
        const skill = await ctx.skills?.get(skillName, { cwd, scope: agent, signal: invocation.signal })
        if (!skill || !isUserInvocable(skill) || !skill.content?.trim()) return error('OpenSpec: навык ' + skillName + ' недоступен; запрос модели не отправлен. Проверьте /skills.')
        const changes = workflow === 'apply-all' ? activeChanges(cwd) : null
        if (changes && changes.length === 0) return error('OpenSpec: в текущем проекте нет активных спецификаций для разработки.')
        const targetMode = workflow === 'propose' ? 'spec' : ['apply', 'apply-all', 'archive'].includes(workflow) ? 'full' : null
        if (targetMode && projectFeatures(ctx, agent).full) {
          try { await selectOpenSpecTaskMode(ctx, agent, targetMode, invocation.signal) }
          catch (cause) { return error(cause.message) }
        }
        const taskMode = taskModeFor(ctx, agent)
        if (workflow === 'sync' && ['doc', 'spec'].includes(taskMode)) return error('/' + name + ': тип задачи «' + taskModeLabel(taskMode) + '» разрешает только .md. Для переноса specs выберите /taskmode full; доступ не изменён.')
        invocation.signal?.throwIfAborted()
        const args = String(invocation.rawInput ?? '').trim()
        const ticketRequest = ['propose', 'explore'].includes(workflow) ? parseTicketRequest(args) : null
        const ticketBatch = workflow === 'propose' && !ticketRequest ? parseTicketBatch(args) : null
        const ticket = ticketRequest?.ticket || (['propose', 'explore'].includes(workflow) ? ticketOnly(args) || ticketOnly(/^Тикет: (.+)$/mu.exec(args)?.[1]) : null)
        const text = [
          renderSkillContent(skill),
          ticketBatch ? ticketBatchInstructions(ticketBatch, parseTicketSource(args)) : ticket ? ticketProposeInstructions(ticket, ticketRequest?.readDescription ?? parseTicketDescriptionMode(args), ticketRequest ? ticketRequest.source : parseTicketSource(args)) : '',
          'Рабочая папка текущей сессии: ' + cwd,
          'Каталог CLI OpenSpec для относительных ссылок навыка: ' + CLI_ROOT,
          ['apply', 'apply-all'].includes(workflow)
            ? 'Для списка, статуса, инструкций apply и проверки структуры используй onec_openspec_query (action=list|status|instructions|validate, change=<имя> кроме list). Он использует комплектный CLI в проекте этого чата; запускать его через shell, /add-dir, npx или глобальную установку не требуется. При скрытой схеме найди инструмент через capability_search.'
            : 'Локальный CLI OpenSpec 1.12.0: node "' + cli + '". В примерах навыка openspec означает этот CLI с cwd текущей сессии. Не используй npx, глобальную установку или openspec explore.',
          'Режим ' + mode.toUpperCase() + ' сохраняется. Соблюдай ограничения доступа и типа задачи; в ASK/PLAN для исследования читай файлы доступными инструментами, shell выключен. Общение и артефакты — на русском. Все действия продолжай в этом чате; новую сессию создаёт только явный запрос пользователя.',
          ['doc', 'spec'].includes(taskMode) ? 'Тип задачи: ' + taskModeLabel(taskMode) + '. Используй Markdown-ветку навыка: читай поставленные schema/templates и записывай только .md внутри проекта; shell и YAML запрещены. Проверка структуры доступна отдельной кнопкой панели. Не переходи к реализации.' : '',
          changes ? 'Разработай все активные спецификации последовательно в этой сессии, применяя приведённый /opsx-apply к каждой по порядку: ' + changes.join(', ') + '. Перед каждой перечитай её документы и задачи. Заверши и проверь одну, затем переходи к следующей; не запускай разные спецификации параллельно, не создавай новые чаты и не архивируй автоматически. При блокере сообщи его и не выдавай оставшуюся очередь за выполненную.' : '',
          args ? 'Запрос пользователя для /' + name + ':\n' + args : changes ? '' : 'Выполни /' + name + '; если change неоднозначен, предложи выбор.',
        ].filter(Boolean).join('\n\n')
        agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
        return { kind: 'success', text: '/' + name + ': инструкция и запрос переданы агенту текущего чата. ' + (workflow === 'explore' ? 'Исследование без правок; спецификация не требуется. Режим доступа сохранён.' : 'Результат появится в ответе агента; отправка не означает завершение работы.'), data: { workflow, sent: true, taskMode, ...(changes ? { changes } : {}) } }
      },
    })
  }
}
