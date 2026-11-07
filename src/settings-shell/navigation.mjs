export const GROUPS = ['Основное', 'Проект 1С', 'Модели и агенты', 'Инструменты и MCP', 'Контекст и история', 'Интерфейс', 'Другие расширения']
export const UNIFIED_PROVIDERS = 'airules-providers-settings'
export const PROVIDER_ALIASES = ['account', 'models', 'dsh-subscriptions', 'airules-subscriptions', 'subscriptions', 'kimi', 'kimi-account', 'airules-kimi', 'airules-kimi-provider', 'airules-api-plans', 'airules-provider-drivers']
export const SECTION_META = {
  general: ['Основное', 'Общие параметры приложения.'],
  account: ['Основное', 'Аккаунт DeepSeek и доступ к сервису.'],
  models: ['Модели и агенты', 'Настроенные модели и провайдеры.'],
  'airules-providers-settings': ['Модели и агенты', 'Провайдеры, подписки и доступные модели.', 'Провайдеры и модели'],
  'agent-presets': ['Модели и агенты', 'Встроенные и проектные пресеты агента.'],
  'airules-preset': ['Модели и агенты', 'Встроенные правила и пресет 1С.'],
  'airules-onec-project': ['Проект 1С', 'Параметры выбранного проекта 1С.', 'Настройки проекта 1С'],
  'airules-onec-environment': ['Проект 1С', 'Платформы, базы, исходники и доступные инструменты.', 'Среда 1С'],
  'airules-role-models': ['Модели и агенты', 'Модели и уровни рассуждений для ролей нашей оркестрации.', 'Модели для ролей 1С'],
  'airules-model-rotation': ['Модели и агенты', 'Явно настроенные пулы моделей и переключение при сбоях.', 'Ротация моделей'],
  'onec-project': ['Проект 1С', 'Локальные параметры проекта 1С.'],
  'dsh-bsl-editor': ['Проект 1С', 'Редактор BSL/XML и дерево исходников.'],
  'airules-onec-panels': ['Проект 1С', 'Структура локальных метаданных и форм.'],
  'airules-onec-specialized': ['Проект 1С', 'Хранилище конфигурации, сравнение обновлений и бинарные артефакты.', 'Хранилище и обновления'],
  'airules-onec-background': ['Инструменты и MCP', 'Проверенные методы MCP для фонового выполнения.', 'Долгие операции'],
  'airules-mcp-manager': ['Инструменты и MCP', 'Подключения MCP этой машины. Проектный фасад настраивается отдельно.'],
  'airules-workflows': ['Инструменты и MCP', 'Проектные проверки, планы и результаты; реальный деплой отключён.', 'Проверки и деплой'],
  'mcp': ['Инструменты и MCP', 'Подключённые инструменты MCP.'],
  plugins: ['Инструменты и MCP', 'Параметры установленных расширений.'],
  'plugin-inventory': ['Инструменты и MCP', 'Установленные плагины.'],
  'web-search': ['Инструменты и MCP', 'Провайдер и настройки поиска в интернете.'],
  'airules-mobile-access': ['Инструменты и MCP', 'Подключение мобильного клиента.'],
  'mobile-access': ['Инструменты и MCP', 'Подключение мобильного клиента.'],
  'airules-telegram': ['Инструменты и MCP', 'Связь с Telegram.'],
  telegram: ['Инструменты и MCP', 'Связь с Telegram.'],
  acp: ['Инструменты и MCP', 'Подключение внешних агентов по ACP.'],
  'airules-acp': ['Инструменты и MCP', 'Подключение внешних агентов по ACP.'],
  skills: ['Контекст и история', 'Навыки и подключаемые инструкции.'],
  'airules-skills': ['Контекст и история', 'Поиск, инструкции и доступность общих и проектных навыков.', 'Навыки'],
  'airules-agent-import': ['Контекст и история', 'Выборочный перенос инструкций и навыков из других агентов.', 'Импорт из других агентов'],
  'airules-documents': ['Контекст и история', 'Локальная библиотека документации выбранного проекта.', 'Документы проекта'],
  'airules-general-tools': ['Интерфейс', 'Добровольный краткий стиль ответов; рассуждения и проверки сохраняются.', 'Краткость ответов'],
  'archived-sessions': ['Контекст и история', 'Архивные чаты и восстановление.'],
  'session-log': ['Контекст и история', 'Журнал сеанса.'],
  'dsh-movein': ['Контекст и история', 'Импорт инструкций и настроек других инструментов.'],
  appearance: ['Интерфейс', 'Внешний вид приложения.'],
  'gui-customization': ['Интерфейс', 'Оформление и визуальные параметры.'],
  'better-sidebar': ['Интерфейс', 'Размещение рабочих панелей.'],
}
export function visibleRows(rows) {
  const unified = rows.some(row => row.id === UNIFIED_PROVIDERS)
  const skills = rows.some(row => row.id === 'airules-skills')
  const importer = rows.some(row => row.id === 'airules-agent-import')
  return rows.filter(row => (!unified || !PROVIDER_ALIASES.includes(row.id)) && (!skills || row.id !== 'skills') && (!importer || row.id !== 'dsh-movein')).map(row => ({ ...row, label: SECTION_META[row.id]?.[2] ?? row.label }))
}
export function groupSections(rows) {
  const visible = visibleRows(rows)
  return GROUPS.map(label => ({ label, rows: visible.filter(row => (SECTION_META[row.id]?.[0] ?? 'Другие расширения') === label) })).filter(group => group.rows.length)
}
export function activeSection(rows, requested) {
  const visible = visibleRows(rows)
  const id = rows.some(row => row.id === UNIFIED_PROVIDERS) && PROVIDER_ALIASES.includes(requested) ? UNIFIED_PROVIDERS
    : requested === 'skills' && rows.some(row => row.id === 'airules-skills') ? 'airules-skills'
    : requested === 'dsh-movein' && rows.some(row => row.id === 'airules-agent-import') ? 'airules-agent-import' : requested
  return visible.find(row => row.id === id)?.id ?? groupSections(rows)[0]?.rows[0]?.id
}
