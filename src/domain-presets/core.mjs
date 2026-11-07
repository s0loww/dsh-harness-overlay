import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const catalog = Object.freeze({
  python: { environment: 'Интерпретатор, зависимости, uv/venv и воспроизводимость.', delivery: 'Код, тесты, типизация и проверка безопасности.', orchestration: 'Планирование, делегирование и приёмка по доказательствам.' },
  sysadmin: { diagnosis: 'Диагностика без нарушения канала и утечки секретов.', change: 'Резервная копия, проверка конфигурации, изменение и откат.', orchestration: 'Инциденты, делегирование, независимая проверка и передача контекста.' },
})
function domainCheck(domain) { if (!Object.hasOwn(catalog, domain)) throw new Error('DOMAIN_UNSUPPORTED') }
export function listRules(domain) {
  domainCheck(domain)
  return Object.entries(catalog[domain]).map(([id, description]) => `${id}: ${description}`).join('\n')
}
export function readRule(domain, id) {
  domainCheck(domain)
  if (!Object.hasOwn(catalog[domain], id)) throw new Error('DOMAIN_RULE_UNKNOWN')
  return readFileSync(new URL(`./rules/${domain}/${id}.md`, import.meta.url), 'utf8')
}
export function skillsRoot(domain) { domainCheck(domain); return fileURLToPath(new URL(`./skills/${domain}/`, import.meta.url)) }
export function sharedSkillsRoot() { return fileURLToPath(new URL('./skills/common/', import.meta.url)) }
export function contract(domain) {
  domainCheck(domain)
  return `Предметный пресет: ${domain}. Это дополнение к штатным ограничениям DSH, пользовательским указаниям и проектным AGENTS.md/AGENTS.local.md, а не разрешение обходить их. Не считай инструменты, модели, доступы и внешние сервисы установленными без проверки. Настройки подключений остаются вне комплекта правил.\nПеред предметным изменением загрузи соответствующее правило read-only инструментом domain_rule(id). Для многоэтапной работы сначала orchestration. Не загружай все правила и навыки заранее. Доступны:\n${listRules(domain)}`
}
