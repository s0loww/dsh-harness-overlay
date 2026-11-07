import { readFileSync } from 'node:fs'

const base = JSON.parse(readFileSync(new URL('./standard.plugins.json', import.meta.url), 'utf8'))
export const DOMAINS = Object.freeze({
  python: { id: 'python-airules', name: 'Python', description: 'Python: окружение, реализация, тестирование и проверка кода. Проектные инструкции и разрешения наследуются.', order: 3 },
  sysadmin: { id: 'sysadmin-airules', name: 'Системное администрирование', description: 'Диагностика и эксплуатация: доказательства, безопасное изменение, проверка и откат. Проектные ограничения имеют приоритет.', order: 4 },
})
export function createPresets({ python = true, sysadmin = true, platform = process.platform, workflows = false, sharedSkills = false, generalTools = false, documents = false } = {}) {
  if (typeof workflows !== 'boolean') throw new Error('WORKFLOWS_BOOLEAN_REQUIRED')
  if (typeof sharedSkills !== 'boolean') throw new Error('SHARED_SKILLS_BOOLEAN_REQUIRED')
  if (typeof generalTools !== 'boolean' || typeof documents !== 'boolean') throw new Error('WORKBENCH_BOOLEAN_REQUIRED')
  return Object.entries(DOMAINS).filter(([domain]) => domain === 'python' ? python : sysadmin).map(([domain, meta]) => {
    const plugins = structuredClone(base)
    for (const row of plugins) {
      if (row.id === 'persona') row.config.prefix = `Ты — ${domain === 'python' ? 'разработчик Python' : 'системный администратор'} на модели {{model}}. Отвечай по-русски. Соблюдай проектные AGENTS.md, пользовательские ограничения и штатные разрешения DSH. Загружай предметные инструкции по необходимости через domain_rule и skill.`
      if (row.id === 'agent-instructions') Object.assign(row.config, { instructionFileCandidates: ['AGENTS.md'], localInstructionFileCandidates: ['AGENTS.local.md'] })
      if (row.id === 'tool-bash') row.disabled = platform === 'win32'
      if (row.id === 'tool-pwsh') row.disabled = platform !== 'win32'
    }
    plugins.splice(plugins.findIndex(row => row.id === 'tool-skill') + 1, 0, { id: 'domain-policy', name: 'airules-dsh-domain-presets/policy', config: { domain, ...(sharedSkills ? { sharedSkills: true } : {}) } })
    if (workflows) plugins.splice(plugins.findIndex(row => row.id === 'domain-policy') + 1, 0, { id: 'airules-workflow-tools', name: 'airules-dsh-workflows/tools' })
    if (generalTools) plugins.push({ id: 'airules-general-tools', name: 'airules-dsh-general-tools/tools' })
    if (documents) plugins.push({ id: 'airules-document-tools', name: 'airules-dsh-document-workbench/tools' })
    return { ...meta, plugins }
  })
}
