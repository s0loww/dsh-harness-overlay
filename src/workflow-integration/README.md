# Проверки и деплой в DSH

Интеграция универсального workflow core с native DSH rc.5. Исходники core и
доменного пакета берутся из project_rules при staging; отдельный сервис и
MCP-фасад не требуются. Deploy-исполнитель реализован. По умолчанию включён
режим fixture-only: реальные изменения ИБ выключены, встроенная заглушка доступна.
Настройка полного цикла и восстановления описана ниже.

Страница «Проверки и деплой» показывает workflow выбранного сеанса, исполнителей,
эффекты, сохранённый план и результаты прогонов. GET/status не запускает runners.
Мастер на странице обнаруживает поддерживаемые инструменты и готовит конфигурацию.
Сценарий можно сохранить кнопкой в проект при штатном праве записи; сохранение
проверяет revision, объединяет записи без потери существующих сценариев и делает backup.
GET/setup и POST/previewSetup работают без записи файлов,
процессов и выдачи доверия к коду. POST требует native connection gate и CSRF.
POST/saveSetup принимает выбор шаблона и revision, а не произвольный JSON/команду.
Список сценариев доступен и без проектного binding: есть готовые шаблоны.
Машинный deployMode принимает disabled/fixture-only/enabled. Проект не может
менять этот режим. Реальный адаптер требует обновлённого agent-1c с Workflow-протоколом,
проверенной версии кода и явно связанной файловой или серверной цели test/development.
Связанный deploy-preview не применяет изменений и предшествует apply в готовом сценарии.

Типовой runner поставляется в `bundled/agent-1c/` этого пакета вместе с проверенными
PS-зависимостями и toolchain.lock.json. Его можно перенести в `tools/agent-1c/`
нового проекта; существующий проектный runner сначала сравнивают с этой версией.
Он не требует наличия checkout project_rules у получателя сборки.

Восстановление выполняет `airules_workflow_recover` через доверенный provider.
Для заглушки есть встроенный provider. Машинные `recoveryCommands` подключают
проверенный локальный PS-runner; `recoveryTools` — уже зарегистрированный native
MCP-инструмент. Фасад/MCP для локального восстановления не требуется. Контракт
fixed Workflow* arguments и связанного proof описан в `lib/local-recovery.js`.
Provider сам подтверждает остановку, консистентный backup и восстановление своей
цели; ядро сохраняет receipt до освобождения только собственной блокировки.
Исходный verdict не заменяется на PASS. В fixture-only реальное восстановление запрещено.
План сохраняется только POST с native connection gate/CSRF и writable session.
HTTP не выполняет и не отменяет процессы. Запуск — composition-scoped
`airules_workflow_run` в активном turn с native tool permissions.

Вызов сохраняет текущие sandboxPolicy → sandbox.confine → subprocess.spawn,
очищенное окружение, owned cancellation и ожидание завершения. Standing
danger-full-access применяется только как реально выбранный режим; автоматической
эскалации и fallback на raw Node spawn нет. База, процессы и службы не запускаются
при открытии настроек, загрузке пакета, инспекции binding или создании плана.

## Проектный binding

Файл `.airules/workflows.json` — data-only. Он не создаётся автоматически.
Пример для существующего agent-1c (пути/имя расширения/build подставляет проект):

```json
{
  "schemaVersion": 1,
  "projectId": "sample",
  "sourcePaths": ["src"],
  "configPaths": ["agent-1c.json"],
  "providers": {"checks": {"adapterId": "runner-onec"}},
  "runners": {
    "runner-onec": {
      "schemaVersion": 1,
      "kind": "agent-1c",
      "runnerPath": "tools/agent-1c/agent-1c.ps1",
      "profilePath": "agent-1c.json",
      "sourceKind": "extension",
      "extensionName": "ExampleExtension",
      "exactBuild": "8.3.27.1989"
    }
  },
  "workflows": {
    "static-checks": {
      "schemaVersion": 1,
      "id": "static-checks",
      "label": "Инструменты и статический анализ",
      "version": "0.1.0",
      "steps": [
        {"id":"doctor","adapter":"checks","operation":"doctor","timeoutMs":60000},
        {"id":"analyze","adapter":"checks","operation":"analyze","dependsOn":["doctor"],"timeoutMs":300000}
      ]
    }
  }
}
```

Это технический результат runner, не обещание функциональной проверки базы.
Для TestEnv inspection binding имеет kind=test-env и фиксированный путь
scripts/RunUnitTests.ps1; unit импортирует конфигурацию и меняет тестовую базу,
поэтому пока виден как disabled. RunUITests/RunAllTests и legacy deploy wrappers
автоматически не используются. Поля exactBuild/source kind — проверяемые на
согласованность декларации; реальная установленная платформа/XML этим шагом
ещё не исследованы. Credentials и внешние INI/env-файлы при inspection не читаются.

Запуск doctor/analyze разрешён только для code closure проверенной версии
runner. В release lock поставляется digest canonical agent-1c; изменённый
runner показывается как needs-review и не запускается. Дополнительные reviewed
digests задаются отдельно в machine plugin config `trustedRunnerDigests`,
а не в проектном binding. Сам хеш не означает автоматического code review.
Путь к PowerShell можно задать machine config `powerShellPath`, иначе проверяется
наличие executable в PATH без его запуска. Подключения MCP не меняются.

## Прямые MCP и фасад

Необязательный `mcpProviders` в проектном binding связывает provider ID с уже
зарегистрированным полным именем native tool `mcp__...__...`. Передаются
schemaVersion=1, tool, revision, operation=check, inputSchema,
format=assertions-json либо test-summary-json, effects=[readsSource].
Project providers ссылаются на этот ID через adapterId; runners может быть пустым.
Вызов проходит через штатный tools.execute с agent/parent execution token,
поэтому native tool permissions, scope и отмена сохраняются.

В machine plugin config `readOnlyMcpTools` явно перечисляются проверенные
инструменты чтения. По умолчанию список пуст: операция с именем check может
в действительности менять данные. Binding не может сам выдать это разрешение.
Подключения и секреты не создаются и не копируются; фасад и прямые серверы
обрабатываются одинаково. Смена регистрации инструмента инвалидирует план.

Первый bridge принимает только нормализованные complete/assertions либо
test-summary со свежими runId/sourceDigest. Обычные Envelope/BSL diagnostics/
предметный текст требуют отдельного проверенного result mapper; их наличие
не превращается в PASS. Никаких вызовов MCP при открытии страницы/планировании.

## Инструменты

- airules_workflow_status — capabilities/settings, без процессов;
- airules_workflow_plan(workflowId) — сохранить план;
- airules_workflow_run(planId, planDigest, requestId) — разрешённые проверки и deploy-apply с учётом машинного режима;
- airules_workflow_result(runId) — собственный результат;
- airules_workflow_cancel(runId) — отмена собственного активного запуска.
- airules_workflow_recover(runId,targetId,providerId,requestId) — подтверждённое восстановление/сверка и освобождение собственной блокировки.

Планы/прогоны принадлежат сеансу и проекту. Произвольные команды, пути/argv,
новые MCP connections и credentials не принимаются от модели. Одинаковый
запрос/plan не создаёт второе исполнение. Отмена не откатывает изменения.
В установленном fixture-only реальное применение запрещено независимо от режима
sandbox и permissions. Отдельный машинный enabled не отменяет проверки runner,
связанной цели и актуальности сохранённого плана.
