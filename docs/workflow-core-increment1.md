# Универсальные проверки и deploy: исполняемый инкремент 1

2026-11-04. Canonical source — project_rules. Изменение не устанавливается
в live DSH автоматически и не включает исполнение в установленном пресете.

## Реализовано

- [Workflow core](D:/AI_Projects/project_rules/core/tools/workflow/README.md),
  Node.js/builtins: capabilities, plan, run, result, cancel; типизированный DAG,
  неизменяемые fingerprints, полномочия, idempotency, resource locks и journal.
- Прямой local process adapter и нормализованный JSON report adapter.
- MCP adapter с переданным клиентом caller: прямые серверы и фасад одинаково
  необязательны, credentials/connections не вшиты. Живые MCP не вызывались.
- Операторский CLI с явным JSON registry, без поиска/исполнения кода проекта.
  В нём target mutations отключены; остальные процессы требуют --execute.
- [Пакет 1С](D:/AI_Projects/project_rules/overlays/1c/tools/workflow-onec/README.md):
  offline gate для согласованности профиля, source kind/extension/build/engine,
  явные declared/unsupported/not-configured статусы. Переданные XML/build facts
  пока не обнаруживаются автоматически и не считаются runtime-проверенными.

## Зафиксированные инварианты

Изменение исходников/config/adapter после plan или во время execution исключает
PASS. Каждому plan соответствует одно принятое исполнение даже с новым requestId.
Неопределённая optional mutation тоже исключает PASS и дальнейший запуск.
Перед записью в цель journal уже показывает unknown; поздний not-applied не
стирает предыдущий applied. Потерянный/чужой lock не удаляется cleanup.
Пассивный capability status не запускает probes и не создаёт state directory.

## Интеграция DSH — следующий исполняемый слой

Изучены штатные seams pinned host rc.5:

- native tools/pre-execute и approval.request требуют открытого turn/session;
- sandboxPolicy.resolve → sandbox.confine → subprocess.spawn;
- subprocess scrubs environment и поддерживает owned termination/Windows Job;
- settings connection gate и session/cwd проверяются существующим шаблоном
  project-settings/onec-panels.

Поэтому raw Node spawn не регистрируется model-facing tool. Для DSH нужен
native execution adapter с сохранением sandbox/approvals и отдельный UI/agent
bridge. Настройки HTTP не обходят native approval вне открытого turn. Для
сохранения plan нужен POST/CSRF; чистый preview/status можно оставить read-only.

## Границы инкремента

Готовы core, CLI, adapter seams и offline domain gate. Ещё не выполнены:

1. Native DSH execution adapter и UI/tools, упаковка и candidate smoke.
2. Реальные adapters TestEnv/agent-1c/предметных runners, нормализация их evidence,
   автоматическое чтение source metadata, toolchain/target preflight.
3. Полные JUnit/Designer/ibcmd validators, backup/restore provider и проверка
   восстановления. Откат не обещается существованием поля recoveryState.
4. Проектные bindings и отдельно разрешённые изолированные проверки контуров.

Файлы проектов, базы, службы, sandbox policies и установленная UI/policy версия
не менялись. Работающая конфигурация линтера также сохранена.

## Проверка реализации

- Core suite: **67/67 PASS**; domain suite: **11/11 PASS**, всего **78/78**.
- Использовались только временные fixture-каталоги, injected MCP caller и
  собственные процессы Node; Windows cancellation проверял также дочерний PID.
- Интеграционные случаи: два прямых MCP без фасада; новый проект только данными;
  реальный fixture-process с JSON report; offline domain gate внутри core.
- Негативные случаи: stale source/profile/adapter/validator, input changes during
  run, чужой owner/lock, timeout/cancel, пустые/stale/malformed reports, unknown
  optional mutation, blocked required gate, запрет target mutations в CLI.
- Layer-purity scan новых tool packages и diff whitespace checks пройдены.
