# Installer plan, apply and rollback

`plan.mjs` строит план установки overlay и принципиально ничего не записывает.
`apply.mjs` и `rollback.mjs` используют тот же hash-gated контракт.

```powershell
node installer/plan.mjs --install-root "E:\path\to\DSH" --overlay "dist\airules-overlay-0.12.0-dev"
node installer/plan.mjs --install-root "E:\path\to\DSH" --overlay "dist\airules-overlay-0.12.0-dev" --json
node installer/apply.mjs --install-root "E:\path\to\DSH" --overlay "dist\airules-overlay-0.12.0-dev"
node installer/rollback.mjs --install-root "E:\path\to\DSH" --receipt "E:\path\to\DSH\.airules-backups\airules-dsh-overlay-0.12.0-dev\receipt.json"
```

Перед формированием операций CLI проверяет:

- release guard по `upstream/release.lock.json`;
- хэши allowlist исходных файлов установленного DSH;
- привязку overlay к точному release lock;
- полный набор файлов и SHA-256/размер каждого payload-файла;
- фиксированный контракт путей provider, rulepack и Cordis fragment.

Для artifact schema v2 дополнительно обязателен `releasePatch` с engine
`exact-text-replacements/v1`. Его payload сверяется с release baseline и summary
в overlay manifest. Все source hashes, последовательная cardinality каждого
replacement и вычисленные result hashes проверяются до появления операций
`patch-file` в плане. Schema v1 по-прежнему поддерживается без source patch.

План содержит две операции копирования в
`.dsh-1c/home/profiles/node_modules` и merge fragment в
`dsh-1c-bundle/cordis.patch.yml`. Существующий каталог пакета или уже
зарегистрированный, но отличающийся `airules-policy` считается collision: статус
плана становится `blocked`, а CLI завершается с кодом `2`. Точное совпадение
Cordis-блока — идемпотентный `noop`. Ошибки целостности завершаются кодом `1`.
Для всех существующих изменяемых целей план сообщает детерминированный
`backupTarget`.

## Apply

Apply повторяет все проверки plan, готовит полные before/after-хэши, создаёт
детерминированный backup и pending receipt, затем ещё раз проверяет входы. Только
после этого пакеты атомарно устанавливаются, а в Cordis структурно добавляется
ровно один top-level блок `airules-policy`. Существующий обычный
`cordis.patch.yml` — это ожидаемая merge-цель, а не collision.

В schema v2 полные after-файлы source patch, packages и Cordis сначала
готовятся в отдельном staging-каталоге. Затем все originals сохраняются в один
backup и pending receipt. После полного re-plan и target-state guards единая
транзакция переносит все originals в quarantine и ставит staged `patch-file` в
объявленном порядке, затем packages и Cordis. Ошибка или failpoint до final
receipt возвращает все quarantined originals; удаление quarantine начинается
только после зафиксированного receipt.

Каталоги пакетов и отличающийся выделенный блок `airules-policy` не заменяются
без явного `--replace-collisions`. Неоднозначный Cordis-блок (несколько записей
или общий блок с другими provider id) не заменяется даже с этим флагом.

## Rollback

Receipt находится внутри `.airules-backups/<overlay-id>-<version>/receipt.json`.
Rollback до записи проверяет целостность receipt, release/baseline, after-хэши
всех owned targets и before-хэши полных backup-копий. Затем он байт-в-байт
восстанавливает существовавшие цели и удаляет только те package targets, которые
были созданы apply. При чужом изменении owned target rollback отказывается
работать.

Receipt v2 содержит before/after SHA-256 для каждого patch target и точный
releasePatch allowlist. Rollback допускает patched hashes только для этих
targets, проверяет полные backups и восстанавливает original bytes общей
stage/quarantine транзакцией.

Инструменты читают только release allowlist, overlay, фиксированные package и
Cordis targets, а также patch targets, строго привязанные к baseline и receipt.
Они не перечисляют профиль пользователя и не читают/выводят credentials,
токены или содержимое конфигурации подключений.

