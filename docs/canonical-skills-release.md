# Общие навыки и проверки 1С из canonical airules

Дата: 2026-11-05. Установлены UI dev15 / policy dev31, DSH Desktop 0.2.1-rc.5.

Принятый комплект адаптирован сначала в project_rules, затем упакован в DSH.
Отдельной редактируемой DSH-копии методологии не создаётся.

| Слой | Навыки | Доступность в DSH |
|---|---|---|
| core | handoff, skill-maintainer, security-baseline, architecture-evolution, technical-debt | 1С, Python, Sysadmin |
| overlays/1c | 1c-business-tests, 1c-ui-regression, 1c-verify-project | Только 1С |

Handoff — компактный вход в session-handoff, а не второй процесс передачи.
Maintainer различает процедуру, решение, кейс и изменение политики; правит
авторитетный источник вместо generated copy. Review-навыки вызываются адресно
и сохраняют проектные критерии; наличие в каталоге не требует проводить ревью
каждой правки. Для трёх review-навыков сохранены подтверждённые MIT NOTICE upstream.

Проверки 1С используют реальные проектные runners и их контракты. Наличие навыка
не регистрирует команду, framework, MCP или backend. Фасад необязателен;
metadata-only наблюдение, отсутствие required cases и exit0 без assertions
не становятся успешным тестом. Написание verification recipe отделено от запуска.
Hidden desktop следует существующей политике testing-1c и поддержке цели.

## Единство с airules

Claude и DSH renderers динамически включают восемь новых навыков, ресурсы и NOTICE.
Сборщик проверяет native YAML name и соответствие имени каталога. Свежий пакет
project_rules/var/rulepack/airules-0.12.0-skills2 содержит 22 навыка, 55 правил,
13 ролей, 321 файл. Это development snapshot с source.dirty:true, без git-тега.

Независимый offline проход дал 8 предметных артефактов и ещё 2 regression-прохода
получения handoff. Найденное противоречие устранено у владельца session-handoff:
подтверждённые указания пользователя сохраняются, одна заметка не предоставляет
новых разрешений, расхождения рабочего дерева не откатываются.

Canonical matrices:

- project_rules/docs/GENERAL-SKILLS-ADAPTATION.md;
- project_rules/docs/ONEC-TEST-SKILLS-ADAPTATION.md;
- project_rules/docs/AIRULES-SKILLS-INTEGRATION.md.

## DSH bridge

1С получает 22 навыка из embedded rulepack. В Python/Sysadmin добавляется отдельный
composition-scoped bundled filesystem provider с пятью общими навыками.
В staging они берутся только из проверенного rulepack; каждый файл сверяется с
его manifest. Полный каталог 1С в эти пресеты не монтируется. Standard не меняется.

Для first-party embedded навыков используется штатный bundled rank вместо custom:
проектные/пользовательские определения сохраняют приоритет, переключатели
менеджера могут отключать навык без правки установленного пакета. Инструкции
загружаются по запросу. Добавлены назначения для новых восьми навыков; всего
26 встроенных назначений, общие и проектные overrides сохраняются.

Импорт переносит точные текстовые ресурсы NOTICE/LICENSE/COPYING, сохраняя лицензию.
Произвольные extensionless файлы и бинарные программы этим не разрешаются.

## Проверка

- 456 тестов private overlay прошли.
- Canonical: 13 тестов, composition PASS, layer purity 0, layer selftest PASS,
  симуляция установки 19/19; build/verify свежего rulepack PASS.
- Offline forward evaluation: 8 исходных сценариев + 2 regression, без live-вызовов.

- Нативный DSH: 148 проверок комплекта, 45 регрессионных проверок импорта и
  107 проверок назначений — все прошли. Проверялись реальные registries,
  skill.execute (загрузка текста), native manager, приоритет проектного навыка,
  изоляция пресетов, хеши ресурсов/NOTICE и импорт лицензированного комплекта.
- Браузер: новые навыки и их инструкции видны на странице менеджера; screenshot
  ниже сделан в изолированном стенде, без доступа к рабочим проектам.
- Цикл установки/отката/повторной установки и visible startup smoke прошли.
- Live: целостность receipt подтверждена, 43 операции совпали с ожидаемыми хешами,
  дрейфа нет, cleanupPending пуст. Официальный baseline сохранён (5/5).
  Приложение перезапущено, открытый чат восстановлен.

Проверки не запускали модели из DSH, рабочие 1С-базы, COM, MCP, реальные проектные
runners или deploy. Offline-применение процедур не доказывает работоспособность
конкретного ещё не подключённого framework или UI target. Рабочие проекты и
подключения не менялись; режим исполнителя и пользовательские настройки сохранены.

Evidence:

- `var/canonical-skills-final-tests.log`;
- `var/skills-forward-eval-20261105/report.md` и 10 артефактов cases;
- `var/candidate/official-desktop-rc5-19/smoke/canonical-skills-native-summary.json`;
- `var/candidate/official-desktop-rc5-19/smoke/import-skills-native-summary.json`;
- `var/candidate/official-desktop-rc5-19/smoke/skill-assignments-native-summary.json`;
- `var/live-promotion-backups/release-20261105-canonical-skills-policy31/receipt.json`.

![Новые навыки в DSH](assets/canonical-skills-installed-list.png)
