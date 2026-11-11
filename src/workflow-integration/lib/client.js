window.__ModuleLoader__.load({ id: 'airules-dsh-workflows', factory: require => {
  let projectApi
  try { const candidate = require('airules-dsh-project-context'); if (typeof candidate?.useProject === 'function') projectApi = candidate } catch {}
  const scopedFetch = (...args) => projectApi ? projectApi.projectFetch(...args) : fetch(...args)
  function useProjectFetch(project) { const ref = projectApi ? React.useRef(project) : null; if (ref) ref.current = project; return (...args) => projectApi ? projectApi.projectFetch(args[0], args[1], ref.current) : fetch(...args) }

  const React = require('react'), h = React.createElement
  let sessions
  const styles = {
    page: { display: 'flex', flexDirection: 'column', gap: 14, color: 'var(--dsw-alias-label-primary)', fontSize: 13 },
    control: { font: 'inherit', color: 'inherit', background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 7, padding: '8px 10px', maxWidth: '100%' },
    field: { display: "flex", flexDirection: "column", gap: 6, marginTop: 12, marginBottom: 12 },
    card: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 9, padding: 12, overflowWrap: 'anywhere' },
    actions: { display: 'flex', flexWrap: 'wrap', gap: 8 },
  }
  const statusLabels = {
    configured: 'Настроено', 'not-configured': 'Не настроено', unavailable: 'Недоступно', unsupported: 'Не поддерживается',
    'needs-review': 'Требует проверки версии', disabled: 'Выключено',
    pending: 'Ожидает', running: 'Выполняется', passed: 'Пройдено', failed: 'Ошибка', blocked: 'Заблокировано',
    skipped: 'Пропущено', interrupted: 'Прервано', indeterminate: 'Результат не определён',
    RUNNING: 'Выполняется', PASS: 'Пройдено', FAIL: 'Ошибка', BLOCKED: 'Заблокировано', INTERRUPTED: 'Прервано', INDETERMINATE: 'Результат не определён',
    'not-applied': 'Изменения не применены', applied: 'Изменения применены', partial: 'Изменения применены частично', unknown: 'Состояние изменений неизвестно',
    'not-required': 'Не требуется', required: 'Требуется восстановление', completed: 'Восстановление подтверждено',
  }
  const effects = { readsSource: 'чтение исходников', connectsTarget: 'подключение к цели', startsProcess: 'запуск процесса', writesFilesystem: 'запись файлов', writesTargetData: 'изменение данных', changesMetadata: 'изменение метаданных', serviceLifecycle: 'управление службами', externalIO: 'внешние обращения', destructiveRecovery: 'восстановление с заменой состояния' }
  const labelStatus = status => statusLabels[status] || 'Не проверено'
  const list = value => Array.isArray(value) ? value : []
  const effectText = value => list(value).map(item => effects[item] || 'дополнительный эффект').join(', ') || 'не заявлены'
  const errorText = action => action === 'setMode' ? 'Не удалось сохранить режим исполнителя. Обновите сведения и повторите.'
    : action === 'saveSetup' ? 'Не удалось сохранить сценарий. Проверьте права на запись и обновите предварительный просмотр.'
    : action === 'plan' ? 'Не удалось сформировать план. Проверьте привязки, доступ на запись и обновите сведения проекта.'
    : action === 'result' ? 'Не удалось прочитать результат прогона. Обновите список и повторите.'
      : 'Не удалось загрузить сведения. Проверьте доступ к сеансу проекта и повторите.'
  const operationLabels = { doctor: 'Готовность инструментов', analyze: 'Статический анализ', 'deploy-preview': 'План обновления базы',
    unit: 'Модульные тесты', test: 'Сценарные тесты', 'test-hidden': 'Тесты на скрытом рабочем столе',
    serve: 'Запуск тестовой среды', stop: 'Остановка тестовой среды', 'deploy-apply': 'Обновление базы', check: 'Проверка MCP' }
  const operationLabel = operation => operationLabels[operation] || operation
  const scenarioTemplates = [
    { id: 'template:checks', label: 'Проверки проекта', scenario: 'checks' },
    { id: 'template:deploy', label: 'Проверки и обновление базы', scenario: 'deploy' },
    { id: 'template:fixture', label: 'Проверка исполнителя на заглушке', scenario: 'fixture' },
  ]
  const reasonAdvice = reason => ({
    ACTUAL_DEPLOY_DISABLED: 'Реальный деплой выключен настройкой сборки. Сейчас проверяем исполнитель только на встроенной заглушке; права сеанса не включают доступ к базе.',
    DEPLOY_FIXTURE_ONLY: 'Доступна только встроенная заглушка деплоя. Она не запускает 1С и не подключается к базам.',
  })[reason] || ''
  const statusAdvice = (status, reason) => reasonAdvice(reason) || ({
    'not-configured': 'Не хватает настроек проекта или привязки исполнителя. Настройте сценарий и обновите сведения.',
    unavailable: 'Исполнитель недоступен. Проверьте наличие runner, его профиль и путь к PowerShell.',
    unsupported: 'Эта версия исполнителя не поддерживает операцию. Нужен совместимый runner или другой сценарий.',
    'needs-review': 'Эта версия runner ещё не проверена. Нужна проверка его кода и включение версии в доверенный комплект.',
    disabled: 'Выполнение этой операции ещё не подключено в сборке. Разрешения сеанса DSH не снимают это ограничение.',
  })[status] || ''
  const knownErrors = {
    MODE_CHANGE_BUSY: 'Режим нельзя изменить, пока выполняется прогон или восстановление. Дождитесь завершения либо отмените собственный прогон и обновите сведения.',
    MODE_CONFIGURATION_UNAVAILABLE: 'Штатная настройка режима сейчас недоступна. Обновите сведения или перезапустите DSH; режим не был изменён через эту страницу.',
    STALE_BINDING: 'Настройки проекта изменились после предварительного просмотра. Обновите сведения и подготовьте конфигурацию заново; существующий файл не перезаписан.',
    SETUP_PROJECT_ID_CONFLICT: 'У текущих настроек и подготовленного сценария разные projectId. Согласуйте идентификатор проекта в профиле runner перед сохранением.',
    SETUP_SCENARIO_INVALID: 'Выберите сценарий проверок или обновления базы.',
    DEPLOY_CHECKS_REQUIRED: 'Для полного сценария нужны doctor и analyze. Обновите runner до версии с обеими проверками.',
    DEPLOY_PROTOCOL_REQUIRED: 'Установленный runner не поддерживает связанный отчёт деплоя. Обновите проектный agent-1c из проверенного комплекта.',
    DEPLOY_DIRECT_TARGET_PATH_REQUIRED: 'Укажите путь к файловой базе в testTarget.path профиля agent-1c.json.',
    DEPLOY_TARGET_ENVIRONMENT_FORBIDDEN: 'Для этого сценария нужен явно обозначенный тестовый контур или контур разработки в профиле runner.',
    DEPLOY_PROJECT_ID_REQUIRED: 'В профиле agent-1c.json нужен корректный projectId проекта.',
    WORKSPACE_WRITE_REQUIRED: 'Сеанс работает только на чтение. В чате переключите права на запись в рабочую область, затем обновите сведения.',
    PRESET_NOT_SUPPORTED: 'В этом сеансе выбран неподдерживаемый пресет. Используйте пресет 1С, Python или системного администрирования.',
    WORKFLOW_BINDING_INVALID: 'Файл .airules/workflows.json содержит неподдерживаемые настройки. Исправьте конфигурацию проекта и обновите сведения.',
    WORKFLOW_NOT_CONFIGURED: 'Сценарий проекта ещё не настроен. Начните с подключения runner в .airules/workflows.json.',
    SETUP_CANDIDATE_NOT_FOUND: 'Инструмент больше не найден. Повторите поиск в проекте.',
    SETUP_FACTS_REQUIRED: 'Заполните обязательные поля: вид исходников, имя расширения при необходимости, точный build платформы и каталог исходников.',
    SETUP_FACTS_INVALID: 'Проверьте введённые настройки: используйте относительный путь внутри проекта и точный build платформы.',
    SOURCE_KIND_REQUIRED: 'Выберите вид исходников: расширение или основная конфигурация.',
    EXACT_BUILD_REQUIRED: 'Укажите точный build установленной платформы 1С, например 8.3.27.1989.',
    SOURCE_PATH_REQUIRED: 'Укажите существующий каталог исходников относительно корня проекта, например src.',
    EXTENSION_NAME_REQUIRED: 'Укажите имя расширения из конфигурации 1С.',
    WORKFLOW_SESSION_REQUIRED: 'Выберите чат проекта с пресетом 1С, Python или системного администрирования. Для стандартного пресета этот механизм не подключён.',
    PROFILE_REQUIRED: 'Для agent-1c нужен файл agent-1c.json в корне проекта. Сначала настройте профиль runner в чате проекта.',
    PROFILE_JSON_INVALID: 'Файл agent-1c.json не удалось прочитать как JSON. Исправьте профиль runner и повторите поиск.',
    PROFILE_SOURCE_PATH_REQUIRED: 'Укажите sourceDir в профиле agent-1c.json как относительный каталог внутри проекта и повторите поиск.',
    SOURCE_PATH_PROFILE_MISMATCH: 'Каталог исходников должен совпадать с sourceDir в agent-1c.json. Измените профиль или верните указанный в нём каталог.',
    SOURCE_DIRECTORY_REQUIRED: 'Каталог исходников не найден. Укажите существующий каталог внутри проекта.',
    CONFIGURATION_EXTENSION_CONFLICT: 'Для основной конфигурации имя расширения не используется. Очистите его или выберите вид «Расширение».',
    INLINE_CREDENTIALS_NOT_SUPPORTED: 'Профиль содержит встроенные учётные данные. Вынесите секреты во внешнюю настройку runner перед подключением.',
    SYMLINK_INPUT: 'Файл runner, его профиль и исходники должны находиться внутри проекта без символических ссылок.',
    UNSAFE_INPUT_FILE: 'Найден неподходящий файл runner или профиля. Нужны обычные файлы внутри проекта.',
    SETUP_CHECKS_UNSUPPORTED: 'Найденная версия runner не поддерживает безопасные проверки doctor/analyze. Подключите совместимую версию или другой инструмент проекта.',
    RUNNER_REVIEW_REQUIRED: statusAdvice('needs-review'),
    REAL_DEPLOY_AND_DATABASE_TESTS_DISABLED: statusAdvice('disabled'),
    ACTUAL_DEPLOY_DISABLED: reasonAdvice('ACTUAL_DEPLOY_DISABLED'),
    DEPLOY_FIXTURE_ONLY: reasonAdvice('DEPLOY_FIXTURE_ONLY'),
    BINDING_PATH_REJECTED: 'Файл .airules/workflows.json должен быть обычным файлом внутри проекта, без символических ссылок.',
  }

  function PlanView({ plan, fixtureOnly = false, realDeploy = false, deployEnabled = false }) {
    const source = plan.source || plan.inputs?.source
    return h('section', { style: styles.card, 'aria-label': 'План проверки' },
      h('h3', null, 'Сформированный план'),
      source && h('p', null, `Файлов исходников: ${Number.isSafeInteger(source.files) ? source.files : '—'}`),
      h('details', null, h('summary', null, 'Идентификатор и отпечатки плана'), h('p', null, `План: ${plan.id || 'не указан'}`),
        typeof plan.planDigest === 'string' && /^[a-f0-9]{64}$/u.test(plan.planDigest) && h('p', null, `Digest: ${plan.planDigest}`),
        typeof source?.digest === 'string' && /^[a-f0-9]{64}$/u.test(source.digest) && h('p', null, `Исходники SHA-256: ${source.digest}`)),
      h('p', null, 'Сохранение плана не запускает проверки и не меняет базу. Перед исполнением актуальность входов проверяется повторно.'),
      ...list(plan.steps).map(step => h('div', { key: step.id, style: styles.card },
        h('strong', null, step.id), h('p', null, `Операция: ${operationLabel(step.operation) || 'не указана'} · ${step.required === false ? 'необязательная' : 'обязательная'}`),
        h('p', null, `Эффекты: ${effectText(step.effects)}`),
        step.configured === false && h('p', null, 'Исполнитель не настроен.'),
        ...list(step.resources).map((target, index) => h('p', { key: index }, `Цель: ${target.id || 'не задана'} · ${target.environment === 'production' ? 'рабочий контур' : target.environment === 'test' ? 'тестовый контур' : target.environment === 'development' ? 'контур разработки' : 'класс среды не подтверждён'}`)))),
      h('h4', null, fixtureOnly ? 'Как проверить исполнитель на заглушке' : realDeploy && !deployEnabled ? 'План подготовлен; реальное исполнение выключено' : realDeploy ? 'Как выполнить подготовленный деплой' : 'Как выполнить проверки'),
      fixtureOnly && h('p', null, 'Это имитация обновления: 1С и реальные базы не используются. Её результат показывает работу исполнителя, а не готовность реальной базы.'),
      h('p', null, realDeploy && !deployEnabled ? 'Можно передать план агенту для просмотра готовности. Настройка сборки сейчас запрещает реальное исполнение; этот запрос ничего не применяет.'
        : 'Вернитесь в чат этого проекта и отправьте сообщение ниже. Агент вызовет штатный инструмент; разрешения останутся такими, как выбрано в чате.'),
      h('label', { style: styles.field }, 'Сообщение для чата', h('textarea', { style: { ...styles.control, display: 'block', width: '100%', minHeight: 85, boxSizing: 'border-box' },
        readOnly: true, value: `${fixtureOnly ? 'Выполни только встроенную заглушку деплоя' : realDeploy ? deployEnabled ? 'Выполни проверки и разрешённое применение к указанной в плане цели' : 'Проверь готовность к применению, но не запускай реальный деплой' : 'Выполни только разрешённые проверки'} из плана ${plan.id || ''}${plan.planDigest ? ` с planDigest ${plan.planDigest}` : ''}${realDeploy && !deployEnabled ? '. Реальный режим пока выключен; не обходи его и не меняй базу.' : ' через airules_workflow_run.'}${fixtureOnly || !realDeploy ? ' Реальный деплой, изменение базы и запуск тестовой среды не выполнять.' : ' Другие базы, службы и подключения не менять.'}` })))
  }

  function ResultView({ result }) {
    const recoveryOptions = list(result.recoveryOptions).filter(item => item?.available === true
      && ['fixture', 'mcp'].includes(item.kind) && typeof item.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(item.id))
    const fixtureRecovery = recoveryOptions.find(item => item.kind === 'fixture')
    const recoveries = list(result.recoveries).filter(item => ['not-applied', 'restored'].includes(item?.outcome)
      && typeof item.recoveryId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(item.recoveryId)
      && typeof item.targetId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(item.targetId)
      && typeof item.receiptDigest === 'string' && /^[a-f0-9]{64}$/u.test(item.receiptDigest))
    const reasonText = reason => ({
      STALE_PLAN: 'Входы изменились после планирования. Сформируйте новый план.',
      INPUT_CHANGED_DURING_EXECUTION: 'Входы изменились во время исполнения. Нужно проверить фактическое состояние цели.',
      MUTATION_STATE_UNCONFIRMED: 'Состояние изменений не подтверждено связанным отчётом.',
      DEPLOY_REPORT_UNCONFIRMED: 'Отчёт применения отсутствует или не подтверждён.',
      EXECUTOR_STOP_UNCONFIRMED: 'Завершение исполнителя не подтверждено.',
      CANCELLED: 'Запуск отменён; отмена не откатывает уже применённые изменения.',
      STEP_TIMEOUT: 'Истекло время шага. Перед повтором нужно проверить состояние цели.',
      REQUIRED_GATE_FAILED: 'Обязательная проверка не пройдена; последующие шаги не выполнялись.',
      DEPENDENCY_NOT_PASSED: 'Предыдущая обязательная проверка не пройдена.',
    })[reason] || ''
    return h('section', { style: styles.card, 'aria-label': 'Результат прогона' },
      h('h3', null, 'Результат прогона'), h('p', null, `Прогон: ${result.runId || 'не указан'}`),
      h('p', null, `Итог: ${labelStatus(result.verdict)}`),
      h('p', null, labelStatus(result.mutationState)), h('p', null, `Восстановление: ${labelStatus(result.recoveryState)}`),
      !!recoveries.length && h('section', { style: styles.card, 'aria-label': 'Подтверждения восстановления' },
        h('h4', null, 'Подтверждения восстановления'),
        h('p', null, 'Итог исходного прогона сохранён. Сверка или восстановление подтверждены отдельным журналом.'),
        ...recoveries.map(receipt => h('div', { key: receipt.recoveryId },
          h('p', null, `${receipt.targetId}: ${receipt.outcome === 'restored' ? 'восстановлено' : 'подтверждено отсутствие изменений'}`),
          h('details', null, h('summary', null, 'Подтверждающая запись'), h('p', null, `Запись: ${receipt.recoveryId}`), h('p', null, `SHA-256: ${receipt.receiptDigest}`))))),
      result.observation === 'owner-not-attached' && h('p', null, 'Владелец запуска не подключён к этому процессу. Доступность исполнителя не подтверждена; повторный запуск автоматически не выполняется.'),
      reasonText(result.reason) && h('p', null, reasonText(result.reason)),
      h('ul', null, ...list(result.steps).map(step => h('li', { key: step.id },
        h('strong', null, `${step.id}: ${labelStatus(step.status)}${step.required === false ? ' · необязательная проверка' : ''}`),
        reasonText(step.reason) && h('p', null, reasonText(step.reason)),
        Number.isInteger(step.diagnostics?.exitCode) && h('p', null, `Код завершения: ${step.diagnostics.exitCode}`),
        step.diagnostics?.timedOut === true && h('p', null, 'Истекло время исполнения.'),
        step.diagnostics?.terminationConfirmed === false && h('p', null, 'Завершение процесса не подтверждено.'),
        step.evidence && h('p', null, step.evidence.validated === true ? 'Отчёт шага проверен.' : 'Отчёт шага не подтверждён.')))),
      result.verdict === 'RUNNING' && h('label', { style: styles.field }, 'Запрос на отмену прогона', h('textarea', {
        style: { ...styles.control, width: '100%', minHeight: 80, boxSizing: 'border-box' }, readOnly: true,
        value: `Отмени мой активный прогон ${result.runId || ''} через airules_workflow_cancel. Другие процессы не останавливай. Отмена не означает откат; после завершения покажи состояние изменений и блокировок.` })),
      (result.retainedLocks === true || result.recoveryState === 'required') && h('section', { style: styles.card, 'aria-label': 'Восстановление после сбоя' },
        h('h4', null, 'Перед повторным запуском требуется проверка состояния'),
        h('p', null, result.retainedLocks === true ? 'Цель заблокирована для повторного исполнения. Блокировка снимается только после подтверждённой сверки или восстановления.' : 'Изменения применялись, но успешное завершение не подтверждено. Сначала проверьте цель и подготовьте восстановление.'),
        h('p', null, 'Не удаляйте блокировку вручную и не запускайте тот же деплой повторно. Требуется подтверждение остановки исполнителя и связанный результат проверки цели.'),
        recoveryOptions.length ? h('p', null, `Проверенные исполнители восстановления: ${recoveryOptions.map(item => `${item.id} (${item.kind === 'fixture' ? 'заглушка' : 'проектный MCP'})`).join(', ')}.`)
          : h('p', null, 'Для этой цели пока не настроен проверенный исполнитель восстановления. Агент должен проверить доступные recoveryProviders и подготовить подключение подходящего исполнителя.'),
        h('label', { style: styles.field }, 'Запрос на подготовку восстановления', h('textarea', {
          style: { ...styles.control, width: '100%', minHeight: 95, boxSizing: 'border-box' }, readOnly: true,
          value: `Проверь мой прогон ${result.runId || ''} через airules_workflow_result и состояние через airules_workflow_status. Установи, завершён ли исполнитель, какие изменения подтверждены и какое свидетельство нужно для сверки цели. ${fixtureRecovery ? `Для встроенной заглушки используй airules_workflow_recover с runId ${result.runId || ''}, targetId из результата, providerId ${fixtureRecovery.id} и уникальным requestId; обрабатывай только тестовый маркер.` : 'Подготовь план восстановления через airules_workflow_recover: runId этого прогона, targetId из результата, подходящий providerId из recoveryProviders и уникальный requestId. Покажи последствия и согласуй восстановление реальной базы перед выполнением.'} Пока ничего в реальной базе не меняй, блокировки вручную не удаляй и деплой не повторяй.` }))))
  }

  function WorkflowPanel({ sessionId, initialTemplate = '', onTemplateChange, projectContext }) {
    const scopedFetch = useProjectFetch(projectContext)
    const [data, setData] = React.useState(null), [workflowId, setWorkflowId] = React.useState(initialTemplate), [plan, setPlan] = React.useState(null)
    const [runs, setRuns] = React.useState([]), [result, setResult] = React.useState(null), [error, setError] = React.useState(''), [networkBusy, setBusy] = React.useState(false)
    const [setup, setSetup] = React.useState(null), [form, setForm] = React.useState({}), [preview, setPreview] = React.useState(null)
    const [notice, setNotice] = React.useState('')
    const [modeDraft, setModeDraft] = React.useState(''), [modeBusy, setModeBusy] = React.useState(false)
    const busy = networkBusy || modeBusy
    const modes = ['disabled', 'fixture-only', 'enabled']
    const generation = React.useRef(0), pending = React.useRef(false), requestController = React.useRef(null)
    const templateRef = React.useRef(initialTemplate)

    const request = React.useCallback(async (action, parameters = {}, csrfToken, timeoutMs = 25000) => {
      if (!sessionId || pending.current) return null
      const epoch = generation.current, controller = new AbortController()
      pending.current = true; requestController.current = controller; setBusy(true); setError('')
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const post = action === 'plan' || action === 'previewSetup' || action === 'saveSetup' || action === 'setMode'
        const payload = { action, sessionId, ...parameters }
        const query = Object.entries(payload).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&')
        const response = await scopedFetch(`/airules/workflows${post ? '' : `?${query}`}`, {
          method: post ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', signal: controller.signal,
          headers: { accept: 'application/json', ...(post ? { 'content-type': 'application/json', 'x-dsh-csrf': csrfToken } : {}) },
          ...(post ? { body: JSON.stringify(payload) } : {}),
        })
        const body = await response.json()
        if (!response.ok || body?.ok !== true) throw new Error(Object.hasOwn(knownErrors, body?.error) ? body.error : 'REQUEST_REJECTED')
        return epoch === generation.current ? body : null
      } catch (error) { if (epoch === generation.current) setError(knownErrors[error?.message] || errorText(action)); return null }
      finally {
        clearTimeout(timer)
        if (epoch === generation.current) { pending.current = false; requestController.current = null; setBusy(false) }
      }
    }, [sessionId])

    const load = React.useCallback(async (options = {}) => {
      const epoch = generation.current
      const body = await request('status', {}, undefined, options.timeoutMs ?? 25000)
      if (epoch !== generation.current) return
      if (!body) { if (!options.skipSetup && scenarioTemplates.some(item => item.id === templateRef.current)) await discover(templateRef.current); return }
      setData(body); setRuns(list(body.runs)); setPlan(null); setResult(null)
      setModeDraft(modes.includes(body.execution?.deployMode) ? body.execution.deployMode : '')
      setWorkflowId(current => scenarioTemplates.some(item => item.id === current) || list(body.workflows).some(item => item.id === current) ? current : list(body.workflows)[0]?.id || '')
      if (!options.skipSetup && scenarioTemplates.some(item => item.id === templateRef.current)) await discover(templateRef.current)
      return body
    }, [request])

    React.useEffect(() => {
      generation.current++; pending.current = false
      templateRef.current = initialTemplate
      setData(null); setPlan(null); setResult(null); setRuns([]); setWorkflowId(initialTemplate); setError(''); setBusy(false)
      setSetup(null); setForm({}); setPreview(null); setNotice(''); setModeDraft(''); setModeBusy(false)
      if (sessionId) void load()
      return () => { generation.current++; requestController.current?.abort(); pending.current = false }
    }, [load, sessionId])

    async function makePlan() {
      if (!canPlan) return
      setPlan(null); setResult(null)
      const body = await request('plan', { workflowId }, data.csrfToken)
      if (body?.plan) setPlan(body.plan)
    }
    async function saveMode() {
      if (busy || !sessionId || !data?.writable || !data.csrfToken || !modes.includes(modeDraft) || modeDraft === data.execution?.deployMode) return
      const epoch = generation.current
      setModeBusy(true); setNotice('')
      try {
        const body = await request('setMode', { mode: modeDraft }, data.csrfToken)
        if (epoch !== generation.current) return
        if (!body || !modes.includes(body.mode) || typeof body.changed !== 'boolean') return
        setPlan(null); setPreview(null); setSetup(null)
        let confirmed = false
        for (let attempt = 0; attempt < 3; attempt++) {
          if (epoch !== generation.current) return
          const refreshed = await load({ timeoutMs: 3000, skipSetup: true })
          if (epoch !== generation.current) return
          if (refreshed?.execution?.deployMode === body.mode) { confirmed = true; break }
          if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1)))
        }
        setNotice(confirmed ? 'Режим исполнителя сохранён. Процессы, проверки и деплой не запускались.'
          : 'Режим сохранён. DSH ещё обновляет плагин; нажмите «Обновить сведения», чтобы получить текущий режим. Процессы не запускались.')
      } finally { if (epoch === generation.current) setModeBusy(false) }
    }
    async function loadRuns() { const body = await request('runs'); if (body) setRuns(list(body.runs)) }
    async function loadResult(runId) { const body = await request('result', { runId }); if (body?.result) setResult(body.result) }
    function chooseCandidate(candidate, source = setup, selected = workflowId) {
      const row = list(source?.candidates).find(item => item.id === candidate)
      setForm(row?.kind === 'deploy-fixture' ? { candidateId: row.id } : row ? { candidateId: row.id, sourceKind: row.sourceKind || 'extension', extensionName: row.extensionName || '',
        exactBuild: row.exactBuild || '', sourcePath: list(row.sourcePaths)[0] || '', ...(selected === 'template:deploy' ? { scenario: 'deploy' } : {}) } : {})
      setPreview(null); setNotice('')
    }
    async function discover(preferred = workflowId) {
      const body = await request('setup')
      if (!body) return
      const rows = list(body.candidates)
      const selected = preferred === 'template:fixture' ? rows.find(row => row.kind === 'deploy-fixture')
        : rows.find(row => row.kind === 'agent-1c') || rows.find(row => row.kind !== 'deploy-fixture') || rows[0]
      setSetup(body); chooseCandidate(selected?.id, body, preferred)
    }
    async function chooseScenario(value) {
      setWorkflowId(value); setPlan(null); setResult(null); setPreview(null); setNotice('')
      const isTemplate = scenarioTemplates.some(item => item.id === value)
      templateRef.current = isTemplate ? value : ''
      onTemplateChange?.(isTemplate ? value : '')
      if (isTemplate) {
        setSetup(null); setForm({})
        if (sessionId) await discover(value)
      }
    }
    async function previewSetup() {
      const csrf = setup?.csrfToken || data?.csrfToken
      if (busy || !form.candidateId || !csrf) return
      setPreview(null)
      const body = await request('previewSetup', { setup: form }, csrf)
      if (body) setPreview(body)
    }
    async function saveSetup() {
      const csrf = setup?.csrfToken || data?.csrfToken
      if (busy || !data?.writable || !preview?.configuration || !csrf || !validRevision) return
      const epoch = generation.current
      const body = await request('saveSetup', { setup: form, revision: preview.revision }, csrf)
      if (body?.saved !== true || epoch !== generation.current) return
      templateRef.current = ''; onTemplateChange?.('')
      setPreview(null); setSetup(null); setForm({})
      const loaded = await load()
      if (epoch !== generation.current) return
      if (typeof body.workflowId === 'string') setWorkflowId(body.workflowId)
      setNotice(loaded ? 'Сценарий сохранён. Можно сформировать план. Процессы не запускались.'
        : 'Сценарий сохранён. Обновите сведения проекта, чтобы сформировать план. Процессы не запускались.')
    }
    function updateFact(key, value) {
      setForm(current => ({ ...current, [key]: value, ...(key === 'sourceKind' && value === 'configuration' ? { extensionName: '' } : {}) }))
      setPreview(null); setNotice('')
    }
    const candidate = list(setup?.candidates).find(item => item.id === form.candidateId)
    const validRevision = !!preview && Object.hasOwn(preview, 'revision')
      && (preview.revision === null || typeof preview.revision === 'string' && /^[a-f0-9]{64}$/u.test(preview.revision))
    const workflow = list(data?.workflows).find(item => item.id === workflowId)
    const template = scenarioTemplates.find(item => item.id === workflowId)
    const fixtureWorkflow = !!list(workflow?.steps).length && list(workflow.steps).every(step => list(data?.runnerBindings).some(binding => binding.id === step.adapterId && binding.kind === 'deploy-fixture'))
    const planningOnly = step => data?.execution?.deployMode === 'fixture-only' && step.operation === 'deploy-apply' && step.reason === 'ACTUAL_DEPLOY_DISABLED'
    const blockedSteps = list(workflow?.steps).filter(step => step.required !== false && !planningOnly(step) && ['not-configured', 'unavailable', 'unsupported', 'needs-review', 'disabled', 'blocked'].includes(step.status))
    const planBlocker = template ? 'Это шаблон нового сценария. Подготовьте конфигурацию в мастере, сохраните её через агента и обновите сведения. После этого выберите сохранённый сценарий проекта.'
      : !data?.writable ? 'Для сохранения плана нужны права на запись. Выберите «Запись в рабочей области» в чате и обновите сведения.'
      : !data?.configured ? 'Сначала подключите сценарий проекта: настройки хранятся в .airules/workflows.json.'
        : !workflow ? 'В проекте нет выбранного сценария. Добавьте сценарий проверок и обновите сведения.'
          : blockedSteps.length ? `План недоступен: обязательный шаг «${blockedSteps[0].id}» — ${labelStatus(blockedSteps[0].status).toLowerCase()}. ${statusAdvice(blockedSteps[0].status, blockedSteps[0].reason)}`
            : !data?.csrfToken ? 'Сведения устарели. Нажмите «Обновить сведения» и повторите.' : ''
    const canPlan = !busy && !!data?.writable && !!data?.configured && !!data?.csrfToken && !!workflow
      && !blockedSteps.length
    return h('div', { style: styles.page },
      h('p', null, 'Здесь подключаются сценарии проверок проекта, формируется план и показываются результаты. Запуск проверок выполняет агент из чата с текущими разрешениями DSH.'),
      h('p', null, 'Локальные runners работают напрямую. Для MCP можно использовать отдельные серверы или фасад; фасад не обязателен.'),
      h('label', { style: styles.field }, 'Сценарий', h('select', { style: styles.control, value: workflowId,
        onChange: event => { void chooseScenario(event.target.value) } },
        h('option', { value: '' }, 'Выберите сценарий'),
        h('optgroup', { label: 'Готовые сценарии' }, ...scenarioTemplates.map(item => h('option', { key: item.id, value: item.id }, item.label))),
        !!list(data?.workflows).length && h('optgroup', { label: 'Сценарии проекта' }, ...list(data.workflows).map(item => h('option', { key: item.id, value: item.id }, item.label || item.id))))),
      template && h('p', { role: 'status' }, sessionId ? 'Выбран шаблон. Настройте его в мастере ниже; выбор и подготовка сценария ничего не запускают.' : 'Шаблон выбран. Теперь выберите проектный сеанс выше — настройка продолжится для этого проекта.'),
      h('section', { style: styles.card, 'aria-label': 'Готовность деплоя' },
        h('h3', null, !data ? 'Исполнитель деплоя: выберите сеанс для просмотра режима'
          : data.execution?.deployMode === 'enabled' && data.execution?.deployEnabled ? 'Исполнитель деплоя: реальный режим разрешён'
            : data.execution?.fixtureEnabled ? 'Исполнитель деплоя: проверка на заглушке' : 'Исполнитель деплоя: выполнение выключено'),
        data?.execution?.fixtureEnabled && h('p', null, 'Исполнитель реализован. Сейчас его можно проверить на встроенной заглушке: без 1С, баз и проектных runners. Выберите «Заглушка деплоя» в мастере ниже.'),
        data && !data.execution?.deployEnabled && h('p', null, 'Реальный деплой выключен настройкой сборки. Режим можно изменить ниже; сохранение режима разрешает будущий явный запуск, но само ничего не исполняет.'),
        data?.execution?.deployEnabled && h('p', null, 'Разрешение реального режима не запускает обновление автоматически. Для каждой операции нужны настроенный проектный runner, план и явная команда агенту.'),
        h('p', null, 'Открытие страницы, поиск инструментов и создание плана не запускают деплой. Результаты заглушки не подтверждают готовность реальной базы.'),
        data && h(React.Fragment, null,
          h('label', { style: styles.field }, 'Режим исполнителя', h('select', { style: styles.control, value: modeDraft,
            disabled: busy || !data.writable || !modes.includes(data.execution?.deployMode),
            onChange: event => { setModeDraft(event.target.value); setNotice('') } },
            h('option', { value: '' }, 'Выберите режим'), h('option', { value: 'disabled' }, 'Выполнение выключено'),
            h('option', { value: 'fixture-only' }, 'Только заглушки'), h('option', { value: 'enabled' }, 'Реальный деплой разрешён'))),
          h('button', { type: 'button', style: styles.control,
            disabled: busy || !data.writable || !data.csrfToken || !modes.includes(modeDraft) || modeDraft === data.execution?.deployMode,
            onClick: saveMode }, 'Сохранить режим'),
          !data.writable && h('p', null, 'Для изменения режима нужны права на запись в рабочую область. Просмотр текущего режима доступен.'),
          h('p', null, 'Режим сохраняется в штатной конфигурации DSH и действует для исполнителя. Выбор реального режима не заменяет настройку цели, проверку runner и явную команду на запуск.'))),
      !sessionId && h('section', { style: styles.card, 'aria-label': 'Начало работы' }, h('h3', null, '1. Выберите проект'),
        h('p', null, 'Откройте чат в каталоге проекта с пресетом 1С, Python или системного администрирования. Затем выберите этот сеанс в списке выше.')),
      error && h('p', { role: 'alert' }, error), notice && h('p', { role: 'status' }, notice), busy && h('p', { role: 'status' }, 'Загрузка…'),
      h('div', { style: styles.actions }, h('button', { type: 'button', style: styles.control, disabled: busy || !sessionId, onClick: load }, 'Обновить сведения')),
      data && h('p', null, `Проект: ${data.project?.id || 'не определён'}`),
      sessionId && h('section', { style: styles.card, 'aria-label': 'Мастер подключения проверок' }, h('h3', null, data?.configured ? 'Настройка сценариев проекта' : 'Подключите проверки проекта'),
          h('p', null, 'Найдём существующие инструменты в проекте или подготовим встроенную заглушку деплоя. Поиск и предварительный просмотр ничего не запускают и не записывают.'),
          h('button', { type: 'button', style: styles.control, disabled: busy, onClick: () => discover() }, 'Найти инструменты проекта'),
          setup && !list(setup.candidates).length && h('p', { role: 'status' }, 'Совместимые runners не найдены. Нужен agent-1c в tools/agent-1c/agent-1c.ps1 или TestEnv в scripts/RunUnitTests.ps1. Установку и настройку другого инструмента можно поручить агенту в чате.'),
          setup && !!list(setup.candidates).length && h(React.Fragment, null,
            h('label', { style: styles.field }, 'Инструмент проекта', h('select', { style: styles.control, value: form.candidateId || '', disabled: busy,
              onChange: event => chooseCandidate(event.target.value) }, ...list(setup.candidates).map(candidate => h('option', { key: candidate.id, value: candidate.id }, candidate.kind === 'deploy-fixture' ? 'Заглушка деплоя — без 1С и баз' : `${candidate.kind === 'agent-1c' ? 'agent-1c' : 'TestEnv'} — ${candidate.runnerPath}`)))),
            candidate?.error && h('p', { role: 'status' }, knownErrors[candidate.error] || 'Настройки инструмента не удалось проверить. Проверьте runner и его профиль в чате проекта.'),
            candidate?.kind === 'deploy-fixture' && h('p', null, 'Для заглушки не нужны платформа, профиль runner, исходники или база. Будет подготовлен сценарий имитации успешного деплоя; запуск выполняется отдельно из чата.'),
            candidate?.kind !== 'deploy-fixture' && h(React.Fragment, null,
            h('label', { style: styles.field }, 'Тип сценария', h('select', { style: styles.control, value: form.scenario || 'checks', disabled: busy,
              onChange: event => updateFact('scenario', event.target.value) }, h('option', { value: 'checks' }, 'Только проверки'), h('option', { value: 'deploy' }, 'Проверки и обновление базы'))),
            h('p', null, 'Заполните недостающие данные. Точный build платформы берётся из вашей установки 1С; автоматически он здесь не определяется.'),
            h('label', { style: styles.field }, 'Вид исходников', h('select', { style: styles.control, value: form.sourceKind || 'extension', disabled: busy,
              onChange: event => updateFact('sourceKind', event.target.value) }, h('option', { value: 'extension' }, 'Расширение'), h('option', { value: 'configuration' }, 'Основная конфигурация'))),
            form.sourceKind === 'extension' && h('label', { style: styles.field }, 'Имя расширения', h('input', { style: styles.control, value: form.extensionName || '', disabled: busy, maxLength: 128,
              onChange: event => updateFact('extensionName', event.target.value) })),
            h('label', { style: styles.field }, 'Точный build платформы 1С', h('input', { style: styles.control, value: form.exactBuild || '', disabled: busy, placeholder: '8.3.27.1989', maxLength: 64,
              onChange: event => updateFact('exactBuild', event.target.value) })),
            h('label', { style: styles.field }, 'Каталог исходников относительно проекта', h('input', { style: styles.control, value: form.sourcePath || '', disabled: busy, placeholder: 'src', maxLength: 512,
              onChange: event => updateFact('sourcePath', event.target.value) })),
            candidate?.target && h('p', null, `Цель из профиля: ${candidate.target.kind === 'server' ? 'серверная база' : 'файловая база'} · ${candidate.target.environment === 'test' ? 'тестовый контур' : candidate.target.environment === 'development' ? 'контур разработки' : 'рабочий контур'}. Адрес и учётные данные здесь не показываются.`),
            h('p', null, 'Цель берётся из профиля runner. Пароли и строки подключения здесь не вводятся; подготовка сценария не включает реальный режим.')),
            h('button', { type: 'button', style: styles.control, disabled: busy || !form.candidateId || !(setup?.csrfToken || data?.csrfToken), onClick: previewSetup }, 'Подготовить конфигурацию')),
          preview && h(React.Fragment, null,
            ...list(preview.notes).map((note, index) => h('p', { key: index }, note)),
            preview.existingBinding && h('p', { role: 'status' }, 'Файл .airules/workflows.json уже существует. Это проект изменения: перед сохранением нужно сравнить его с действующей конфигурацией и сохранить существующие сценарии.'),
            preview.configuration && h(React.Fragment, null,
              h('button', { type: 'button', style: styles.control,
                disabled: busy || !data?.writable || !validRevision || !(setup?.csrfToken || data?.csrfToken), onClick: saveSetup }, 'Сохранить сценарий в проект'),
              !data?.writable && h('p', null, 'Для сохранения сценария выберите права на запись в рабочую область в чате проекта. Предварительный просмотр доступен без записи.'),
              !validRevision && h('p', null, 'Для безопасного сохранения нужен свежий предварительный просмотр. Подготовьте конфигурацию заново.'),
              h('p', null, 'Сохранение объединит сценарий с текущими настройками проекта. Проверки, процессы и деплой не запускаются.'),
              h('details', null, h('summary', null, 'Посмотреть конфигурацию'), h('label', { style: styles.field }, 'Конфигурация для .airules/workflows.json', h('textarea', { style: { ...styles.control, display: 'block', width: '100%', minHeight: 230, boxSizing: 'border-box' },
                readOnly: true, value: JSON.stringify(preview.configuration, null, 2) }))),
              h('details', null, h('summary', null, 'Сохранить через агента вместо кнопки'),
              h('p', null, 'Скопируйте одно сообщение ниже в чат этого проекта: конфигурация уже включена. Агент сохранит файл с обычными правами DSH. Затем нажмите «Обновить сведения» и выберите сценарий проекта.'),
              h('label', { style: styles.field }, 'Запрос на сохранение конфигурации', h('textarea', { style: { ...styles.control, width: '100%', minHeight: 90, boxSizing: 'border-box' }, readOnly: true,
                value: `Сохрани конфигурацию сценария в .airules/workflows.json текущего проекта.${preview.existingBinding ? ' Сначала сравни с существующим файлом и покажи изменения; сохрани действующие сценарии и не перезаписывай их без согласования.' : ' Если файл уже появился, остановись и сравни настройки перед записью.'} Никакие runners, проверки, тесты и деплой не запускай. Базы и подключения не меняй.\n\n${JSON.stringify(preview.configuration, null, 2)}` })))))),
      data && h(React.Fragment, null,
        !data.configured && !setup && h('details', { style: styles.card }, h('summary', null, 'Как подключить другой runner или MCP'),
          h('p', null, 'Для этого проекта пока нет файла .airules/workflows.json. Установка правил не создаёт сценарии и не выбирает базу автоматически.'),
          h('ol', null, h('li', null, 'Выберите существующий runner проекта: agent-1c, TestEnv или проверочный MCP-инструмент.'),
            h('li', null, 'Укажите его профиль и сценарии в .airules/workflows.json. Пароли и адреса подключений в этот файл не добавляйте.'),
            h('li', null, 'Вернитесь сюда и нажмите «Обновить сведения». Доступные шаги появятся ниже.')),
          h('p', null, 'Можно поручить настройку агенту в чате:'),
          h('textarea', { style: { ...styles.control, width: '100%', minHeight: 95, boxSizing: 'border-box' }, 'aria-label': 'Запрос на подключение проверок', readOnly: true,
            value: 'Найди существующие runners этого проекта и настрой .airules/workflows.json для проверок. Сначала покажи найденные инструменты и необходимые настройки. Ничего не запускай, базы и подключения не меняй. Фасад MCP не обязателен.' })),
        !data.writable && h('p', null, 'Только чтение: сохранение плана требует доступа на запись. Просмотр настроек и результатов доступен.'),
        workflow && h('section', { style: styles.card, 'aria-label': 'Проверки сценария' }, h('h3', null, 'Проверки сценария'),
          ...list(workflow.steps).map(step => h('div', { key: step.id }, h('p', null, `${step.id}: ${labelStatus(step.status)} · ${step.required === false ? 'необязательная' : 'обязательная'}`),
            statusAdvice(step.status, step.reason) && h('p', null, statusAdvice(step.status, step.reason))))),
        list(workflow?.steps).some(planningOnly) && h('p', null, 'Этот сценарий готов к планированию. Можно сформировать план без запуска; реальное исполнение остаётся выключенным.'),
        planBlocker && h('p', { role: 'status' }, planBlocker),
        h('button', { type: 'button', style: styles.control, disabled: !canPlan, onClick: makePlan }, 'Сформировать план'),
        plan && h(PlanView, { plan, fixtureOnly: fixtureWorkflow,
          realDeploy: !fixtureWorkflow && list(workflow?.steps).some(step => step.operation === 'deploy-apply'), deployEnabled: data.execution?.deployEnabled === true }),
        h('section', { style: styles.card, 'aria-label': 'Проектные исполнители' }, h('h3', null, 'Проектные исполнители'),
          !list(data.runnerBindings).length && h('p', null, 'Исполнители пока не привязаны.'),
          ...list(data.runnerBindings).map(binding => h('div', { key: binding.id, style: styles.card },
            h('strong', null, binding.id), h('p', null, `${binding.kind === 'deploy-fixture' ? 'Встроенная заглушка деплоя' : binding.kind === 'mcp' ? 'MCP-инструмент' : binding.kind === 'local' ? 'Локальный исполнитель' : 'Проектный исполнитель'} · ${labelStatus(binding.status)}`),
            binding.kind === 'deploy-fixture' ? h('p', null, 'Имитация исполнения без 1С и реальных баз.') : binding.kind !== 'mcp' && h('p', null, 'Проверена согласованность настроек. Реальная платформа и база этим просмотром не проверяются.'),
            statusAdvice(binding.status) && h('p', null, statusAdvice(binding.status)),
            ...list(binding.operations).filter(operation => operation.enabled).map(operation => h('p', { key: operation.id }, `${operationLabel(operation.id)}: доступно агенту с разрешениями DSH · эффекты: ${effectText(operation.effects)}`)),
            list(binding.operations).some(operation => !operation.enabled) && h('details', null,
              h('summary', null, `Отключённые операции (${list(binding.operations).filter(operation => !operation.enabled).length})`),
              ...list(binding.operations).filter(operation => !operation.enabled).map(operation => h('div', { key: operation.id },
                h('p', null, `${operationLabel(operation.id)}: ${labelStatus(operation.status || 'disabled')} · эффекты: ${effectText(operation.effects)}`),
                h('p', null, statusAdvice(operation.status || 'disabled', operation.reason)))))))),
        h('section', { style: styles.card, 'aria-label': 'Прогоны' }, h('h3', null, 'Прогоны'),
          h('button', { type: 'button', style: styles.control, disabled: busy, onClick: loadRuns }, 'Обновить прогоны'),
          !runs.length && h('p', null, 'Сохранённых прогонов нет.'),
          ...runs.map(run => h('div', { key: run.runId, style: styles.actions }, h('span', null, `${run.runId} · ${labelStatus(run.verdict)}`),
            h('button', { type: 'button', style: styles.control, disabled: busy, onClick: () => loadResult(run.runId) }, 'Показать результат')))),
        result && h(ResultView, { result })))
  }

  function WorkflowsSettings() {
    const snapshot = React.useSyncExternalStore(listener => sessions.list.subscribe(listener), () => sessions.list.getSnapshot())
    const rows = Object.values(snapshot?.byId || {})
    const active = rows.find(row => (row.retainedBy?.mainView || 0) > 0)?.id || snapshot?.current || null
    const project = projectApi ? projectApi.useProject({ presets: ['1c-airules', 'python-airules', 'sysadmin-airules'] }) : null
    const [manual, setManual] = React.useState(null), [template, setTemplate] = React.useState(''), id = projectApi ? project.projectId : manual || active
    const templateOwner = React.useRef(id)
    const ownedTemplate = templateOwner.current === id ? template : ''
    const changeTemplate = value => { templateOwner.current = id; setTemplate(value) }
    React.useEffect(() => setManual(null), [active])
    React.useEffect(() => setTemplate(''), [id])
    return h('section', { style: styles.page }, h('h2', null, 'Проверки и деплой'),
      (projectApi ? h(projectApi.ProjectPicker, { project, disabled: false }) : h('label', { style: styles.field }, 'Проектный сеанс', h('select', { style: styles.control, value: id || '', onChange: event => setManual(event.target.value || null) },
        h('option', { value: '' }, 'Выберите сеанс проекта'), ...rows.map(row => h('option', { key: row.id, value: row.id }, row.title || row.label || row.id))))),
      h(WorkflowPanel, { key: id, sessionId: id, projectContext: project, initialTemplate: ownedTemplate, onTemplateChange: changeTemplate }))
  }

  return { inject: ['slots', 'sessions'], WorkflowsSettings, WorkflowPanel, PlanView, ResultView,
    apply(ctx) {
      sessions = ctx.get('sessions')
      ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'airules-workflows', order: 28, label: () => 'Проверки и деплой' }, WorkflowsSettings))
    } }
} })
