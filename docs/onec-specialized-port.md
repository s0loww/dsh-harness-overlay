# Специализированные операции 1С

## Что изучено в доноре

Донор: `dsh-1c-bundle/skills/1c-repository-manage/{SKILL.md,docs/repo-ops.md,docs/repo-sdlc.md,tools/1c-repo-ops/scripts/repo-ops.ps1}`. Хранилище — отдельная система от Git. Скрипт выполняет status/history/diff/lock/update/commit/unlock/dump, формирует точный XML объектов, распознаёт кодировки и сообщения об ошибке даже при exit 0. Изменения требуют списка объектов, force — проектного разрешения и подтверждения; commit — комментария. Bind/unbind, создание хранилища и управление пользователями не входят в переносимый контракт.

`lib/ai-merge-core.js`, `skills/1c-ai-merge/SKILL.md`, `prompts/merge1c.md`: beta-планирование по текущей/поставщиковой/базовой выгрузке, хешам, ConfigDumpInfo и данным поддержки; конфликты направляются в CFE borrow/patch. Донорский apply возвращает строки команд, не исполняет merge. В новом backend нет shell-строк и MergeCfg. Полные правила 1c Full не копируются.

`skills/v8unpack-cf/SKILL.md`, `skills/1c-metadata-manage/docs/v8unpack-cf.md`: CLI для целых CF/CFE/EPF и отдельная MCP-ветка обычных Form.bin. Документы донора требуют v8unpack `>=1.2.6,<2`, на Windows обычно `--processes 1`; отдельно предупреждают, что сборка текущей CF не удостоверяет пригодность для загрузки в платформу. Backend не устанавливает Python/v8unpack и не объявляет их доступными без настройки runner. MCP-ветка обычных форм не реализована этим executor.

Существующие project_rules `overlays/1c/tools/workflow-runners` предоставляют agent-1c/test-env. Их doctor/analyze/deploy-контракт нельзя выдавать за контракт хранилища. Новый пакет использует **существующий** `airules-dsh-workflows/lib/native-process.js` для native subprocess/sandbox/таймаутов; специальный driver остаётся проектным.

## Фактический API

Пакет `airules-dsh-onec-specialized`, глобальный сервис `airulesOnecSpecialized.act(args, exec)`, scoped tool `airules_onec_specialized` в пресете `1c-airules`.

| action | Аргументы | Результат |
|---|---|---|
| status | — | Настроенные домены, операции runner, статус доверия, активные прогоны |
| history | domain=repository, limit 1..50 | Сохранённый JSON-отчёт; `freshness:not-live` |
| diff | domain=repository/ai-merge | Сохранённый отчёт хранилища либо реальное локальное сравнение файлов |
| plan | domain, operation; objects/comment/force по операции | План, эффекты, хеши исходников/binding/runner, planDigest |
| validatePlan | planDigest | Проверка актуальности, включая добавленные source-файлы |
| run | planDigest, requestId | Исполнение сохранённого плана, связанный результат |
| result | runId | Только прогон этого экземпляра сессии/проекта |
| cancel | runId | Запрос отмены; подтверждение остановки появляется в result |

Операции repository: status/history/diff/lock/update/commit/unlock/dump. Для lock/update/commit/unlock обязателен непустой `objects` без wildcard; `Конфигурация` допустима одна. Для commit нужен непустой однострочный comment. Force требует `allowForce:true`, `confirmForce:true`, для unlock ещё `confirmDiscardChanges:true`. Эти подтверждения не заменяют native approval.

AI-merge: compare/cfe-plan; локальный bounded diff группирует файлы по верхнему виду/имени объекта, сравнивает три хеша и учитывает удаление. Без baseline различающиеся объекты считаются конфликтом. **Это не полный нейтральный metadata-tree донора:** не разбираются ConfigDumpInfo, UUID, support-state, родительские конфигурации, CFE borrow/patch. Поэтому `support:not-inspected`, запись основной конфигурации запрещена, CFE-результат — рекомендация с обязательным preflight. Автоматического apply нет.

v8unpack: unpack/rebuild. Требуются связанный input и новый output вне input. Для unpack вход — CF/CFE/EPF/ERF, для rebuild — каталог. Пакет проверяет фактическое наличие/хеши выходного артефакта после успешного отчёта. Пригодность артефакта для загрузки в ИБ не удостоверяется.

## Настройка проекта

Файл `.dsh/onec-specialized.json`, без паролей и адресов подключения:

```json
{
  "schemaVersion": 1,
  "repository": {
    "allowForce": false,
    "reports": { "history": "artifacts/repository-history.json" },
    "runner": {
      "protocolVersion": 1,
      "kind": "node",
      "path": "tools/onec-specialized/runner.mjs",
      "sha256": "<SHA-256 проверенного driver>",
      "operations": ["status", "history", "diff"],
      "writeOperations": [],
      "fixture": true,
      "timeoutMs": 60000
    }
  },
  "aiMerge": { "current": "src", "vendor": "vendor", "baseline": "baseline" },
  "v8unpack": { "input": "artifacts/vendor.cf", "output": "artifacts/vendor-unpacked" }
}
```

Runner допускается только в `tools/onec-specialized/runner.mjs` или `runner.ps1`. Его хеш должен совпасть с проектным и отдельно входить в **машинный** `trustedRunnerDigests`; исключение — точный SHA текущего bundled bridge, уже доверенного как часть managed package. Изменённая проектная копия это исключение теряет. Простое изменение JSON доверия не создаёт. Машинные nodePath/powerShellPath — абсолютные пути к интерпретаторам; не подставляется произвольная команда или shell-строка. Неизвестные поля отвергаются. `.env`, traversal, симлинки и hardlinks входных файлов запрещены. Runner — доверенный исполняемый код; перед регистрацией его хеша необходимо проверить также все внешние зависимости, которые он загружает. Для bundled bridge внешние script/dependency/interpreter hashes дополнительно входят в CAS и machine trust. Произвольные скрытые зависимости custom runner не считаются автоматически проверенными.

Сохранённый отчёт repository: `{"records":[{"version":42,"timestamp":"2026-11-07T12:00:00Z","objectCount":3,"state":"changed"}]}`. Поля allowlist исключают свободный текст, содержащий секреты. Runner может реализовать отдельный live status, но обычное чтение такого файла не проверяет соединение с хранилищем.

## Runner protocol v1

### Готовый мост к repo-ops и v8unpack

В пакет включён standalone `runners/runner.mjs`. Экспорт `./runner-template` предоставляет `bundledRunnerTemplate()` с source/SHA/fixed path для native CAS-провижининга; само копирование не запускает процессы и не устанавливает зависимости. Полная typed driver-конфигурация и ограничения описаны в [runners/README.md](../src/onec-specialized/runners/README.md).

`runner.driverConfigPath` равен `.dsh/onec-specialized-driver.json`. Config, repo-ops/dependencies и интерпретаторы хешируются в plan/CAS. Реальный repository bridge требует существующего project-root `.dev.env`: только hash/freshness попадают в evidence, содержимое и credentials не выводятся. Это запрещает незаметный переход к родительскому `.dev.env`. Для dump нужен новый `repository.output` с CF/CFE расширением.

Только точный managed bridge исполняет оркестрацию в trusted host; каждый PowerShell/Python subprocess проходит прежний native workflow adapter. Это устраняет обнаруженный `spawn EPERM` при попытке вложенного PowerShell из confined Node в pinned Windows. Песочница не отключается. Опция adapter `workingDirectory` разрешает только существующий realpath внутри исходного session root, сохраняя прежний policy root; default остаётся прежним.

Raw stdout/stderr используются только в ограниченной памяти для известного v1.1 text-verdict. Fresh raw-report лежит в private transient подкаталоге собственного job и удаляется в finally. Durable summary содержит только размер/хеш/format и `not-parsed`; hard crash требует сверки временных файлов. Отсутствие ошибок/точный marker/свежий report — техническое доказательство reviewed script, не выдуманная ревизия или блокировка каждого объекта.

Python допускается вне project, с hash и machine trust. `-I` metadata подтверждает exact version и внешние module origin/sys.path; затем выполняется `-I -m v8unpack -E/-B ... --processes 1` из fresh contained cwd. PYTHONPATH/PYTHONHOME/VIRTUAL_ENV не передаются. Присутствие output не считается доказательством логической эквивалентности, loadability CF или поведения ИБ.

Node запускается через argv `[runner, "--request", requestPath, "--result", resultPath]`; PowerShell — `-NoProfile -NonInteractive -File runner -RequestPath ... -ResultPath ...`. Текст комментария и параметры находятся в JSON, не в командной строке. Хост создаёт `.dsh/onec-specialized-runs/<UUID>/request.json`; result рядом, до старта отсутствует.

Request: schemaVersion, runId, planDigest, requestDigest, domain, operation, fixture, parameters, objects, sourceEvidenceDigest. requestDigest считается по всем остальным полям. parameters содержит только сформированный типизированный запрос (в т.ч. explicitObjectList/force/comment либо input/output); секреты runner получает своим проектным способом и не возвращает в отчёте.

Result (все поля обязательны):

```json
{
  "schemaVersion": 1,
  "runId": "<из request>",
  "planDigest": "<из request>",
  "requestDigest": "<из request>",
  "domain": "repository",
  "operation": "status",
  "fixture": true,
  "complete": true,
  "assertions": [{ "id": "repository.report-created", "passed": true }]
}
```

Exit 0 без совпадающего результата не даёт PASS. Exit ненулевой, неполный отчёт, несовпадающий invocation, timeout/cancel/output-limit не дают PASS. `fixture:true` остаётся видимым; `projectCertified:false` сохраняется даже при техническом PASS. Драйвер реального хранилища обязан проверить платформенный лог, версии/объекты и конфликты блокировок, а не просто завернуть exit-код донора.

## Права, блокировка и границы

План привязан к исходникам, binding и версии driver. Перед запуском и после approval хеши пересчитываются. Повторный requestId идемпотентен; другой план с тем же requestId отвергается. Для одного canonical проекта разрешён один активный специализированный прогон. Cancel означает запрос; пока native handle не подтвердил остановку, блокировка не снимается. При неподтверждённой остановке требуется ручная сверка; кнопка cancel не маскируется под rollback.

Для **не fixture изменяющих операций repository** существует durable guard в приватном host-home `onec-specialized-reconciliation`. Имя записи выводится из canonical realpath проекта (Windows case нормализован), поэтому смена сессии или перезапуск процесса не разрешают слепое повторение. Active-запись создаётся эксклюзивно и синхронизируется на диск до исполнения. Только собственный успешный вызов со связанным отчётом и подтверждённым завершением очищает собственную запись. Ошибка, отмена, timeout, unknown termination, повреждённая/недоступная запись или невозможность корректно завершить guard оставляют запрет повторных изменяющих repository действий.

Status, сохранённые history/diff и локальный анализ доступны; успешное чтение live status само guard не снимает. Изменение binding на `fixture:true` тоже не обходит уже существующий repository guard. Локальные операции v8unpack отдельный repository guard не создают. В status/blocked plan возвращается указание: «Сверьте состояние хранилища: требуется восстановление». **Проверенный recovery provider/действие сверки пока не реализованы:** нет generic confirm/unlock, кнопки автоматического удаления записи или вымышленного доказательства восстановления. До проверенной ручной сверки реальные изменяющие repository действия остаются заблокированными. Подтверждение остановки локального процесса не означает отмену публикации или снятие удалённых object locks.

Native `sandboxPolicy`, scoped `1c-airules`, live agent и cwd обязательны. Запуск требует workspace-write; меняющие операции дополнительно вызывают **реальный** `ctx.approval.request`, который требует открытого native turn и доступного answerer. Настройка страницы или наличие план-файла не являются согласием. UI не должен подделывать grant для вызова вне turn. Стандартные native sandbox/subprocess остаются владельцами confinement, процесса и подтверждения завершения.

Не запускаются Designer, COM, ИБ, publish/deploy, Telegram, MCP или network в этих регрессионных тестах. Реальное специализированное действие возможно только через отдельно проверенный и настроенный проектный driver. Никакой драйвер 1С автоматически не включён.

## Проверки

`node --test tests/onec-specialized-core.test.mjs`: настоящий Node fixture-процесс без 1С; успешный связанный отчёт, nonzero exit, чужой runId, инертный текст с shell-символами, идемпотентность, CAS, явные объекты/force, блокировка, cancel с подтверждённым завершением, timeout, реальное сравнение source и устаревание после добавления файла. Это проверка backend-протокола. Native mounting/approval/UI должны дополнительно проверяться в собранном candidate; unit fixture не выдаётся за native sandbox-приёмку.
