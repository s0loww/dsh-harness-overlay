# Python и системное администрирование

Один host-пакет регистрирует штатные пресеты `python-airules` и
`sysadmin-airules` через `@deepseek-ai/dsh-agent-preset`. В профиль добавляется
только запись из `cordis.fragment.yml`. По умолчанию оба пресета включены;
`config.python`/`config.sysadmin` позволяют исключить ненужный. Пресет по умолчанию
и существующие сессии не меняются. Повторный mount с теми же id является ошибкой
штатного реестра; установщик должен merge существующую запись по id.

Каждый пресет содержит полный набор из pinned Standard 0.2.1-rc.5: persona,
AGENTS, время, платформенный shell, файловые инструменты и поиск, jobs/schedule,
проектные и пользовательские skills, tool skill, goal, штатные planning,
compaction и delegation, вопрос пользователю, todo, web и present. Отключённые в
Standard инструменты управления плагинами остаются отключёнными. Сохранены
вложенные группы и их `isolate`. Платформенные shell-флаги вычисляются при
регистрации. Настройка выбранной модели, permission policy и sandbox остаётся
штатной; пакет не назначает модель, не расширяет доступ и не включает MCP.

`standard.plugins.json` — буквальная компиляция plugin-list официального
`@deepseek-ai/dsh-web-app/presets/standard.patch.yml`. Две `!!js` проверки платформы
сохранены как маркеры и заменяются boolean в `createPresets`. Источник и SHA-256
зафиксированы в manifest, тест сравнивает весь состав с исходным Standard.
Изменения относительно него: предметная persona, явные AGENTS.md/AGENTS.local.md
и один `domain-policy` непосредственно после tool-skill. Модельные инструменты и
сервисы не заменяются. У каждого пресета отдельная композиция и область policy.

В system prompt входит только короткий bootstrap и индекс трёх правил. Полные
тексты читаются read-only `domain_rule(id)` по необходимости. Индексы и чтение
строго ограничены текущим доменом, пользовательские пути не принимаются.
Два встроенных навыка на домен содержат только маршрутизацию к нужным правилам;
их обнаружение и загрузка используют штатный FileSystemSkillProvider с отдельным
фиксированным bundledSkillDir. Чтение этих проверенных ресурсов установки не
требует расширения доступа к проекту. Сервис fs явно объявлен в Cordis-зависимостях
policy, так как native provider проверяет его даже для bundled roots. Стандартный
провайдер skills остаётся включённым для проектных и пользовательских навыков.

Python охватывает проверку фактического окружения, существующий uv/venv/другой
workflow, воспроизводимые зависимости, публичные тестовые границы, типизацию,
безопасность и review. Наличие pytest/Ruff/mypy/uv не предполагается.
Sysadmin охватывает доказательную диагностику, сохранение канала управления,
резервные копии, валидатор конфигурации, контролируемое изменение, откат и
пользовательскую проверку. Ограничения проекта остаются источником конкретных
хостов, путей, wrapper-команд и расположения резервных копий. Сохранены
предупреждение перед рестартом Xray, безопасная stop-команда для xray-tproxy и
запрет изменения Browbox/sing-tun без прямой команды.

Аудит: complete composition взят из official Standard, а подход к декомпозиции,
независимой проверке и проверкам публичных границ сопоставлен с project_rules
`orchestrator-economy`, `test-discipline`, `intent-testing` и ролями review/tester.
В пакет не копируются модельные карты, проектные состояния, специфичные команды,
длинный реестр 1С-агентов и 1С-навыки. Авторизация делегирования определяется
пользователем и проектом. Секретов, подключений, машинных абсолютных путей,
инсталляторов инструментов и автоматического live-изменения в пакете нет.
# Canonical policy source

Domain rules and skills are maintained in `project_rules/overlays/python` and
`project_rules/overlays/sysadmin`. Staging requires `--domain-rules-root` and
copies those canonical assets into the package with verified hashes. The files
under this source directory are seed snapshots for integration tests.

`--include-shared-skills true` additionally stages the five generic skills
handoff, skill-maintainer, security-baseline, architecture-evolution and
technical-debt from the verified embedded rulepack into `skills/common`.
Each resource is checked against that package's manifest, including notices;
there is no separate editable copy of the shared policy here. The generated
host config enables `sharedSkills: true`, which adds a composition-scoped native
bundled provider to Python and Sysadmin. The mixed 1C skill directory is never
mounted in these presets. Standard remains separate. Shared skill instructions
load only on demand, and native project/user overrides retain their priority.

