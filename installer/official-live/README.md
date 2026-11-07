# Official Desktop live promotion

Этот установщик — отдельный promotion-слой после проверки изолированного
candidate. Candidate-инсталляторы остаются fail-closed для live-путей.

Promotion изменяет только явно перечисленные package-каталоги в
`<profile>\node_modules` и один `<profile>\cordis.patch.yml`. Установочный
каталог DSH только читается для проверки точного baseline `0.2.1-rc.5`.
MCP bindings, endpoints, credentials, история и runtime state не входят в
artifact и не читаются установщиком.

## Release gates

- оба immutable artifact полностью проверены по SHA-256;
- candidate имеет подходящие `ui-ready.json`/`policy-ready.json` и целые
  receipts с теми же manifest hashes;
- `smoke/launch-report.json` candidate имеет статус
  `passed-visible-startup` и `visible: true`;
- live install точно совпадает с official release lock;
- package targets отсутствуют, а выделенные UI/policy Cordis-блоки не
  конфликтуют с текущим файлом; исключение — проверенные shared dependencies
  той же версии, для которых artifact является точным подмножеством live и все
  лишние live-файлы являются только `d.ts`/source maps: они остаются на месте
  как `verified-noop`;
- top-level `zod` не заменяется: live `4.6.7` сохраняется для core, а требуемый
  `dsh-storage-domain` exact `zod@4.4.3` вкладывается в
  `@deepseek-ai/dsh-storage-domain/node_modules/zod` и проверяется как часть
  одного composite package-state;
- backup — новый непосредственный дочерний каталог
  `var/live-promotion-backups`, не пересекающийся с install/profile.

Plan всегда read-only:

```powershell
npm run official:live:plan -- `
  --install-root "C:\Users\S0lo\AppData\Local\Programs\DeepSeek Harness" `
  --profile-root "C:\Users\S0lo\.dsh\profiles\desktop" `
  --backup-root "D:\AI_Projects\dsh_harness_overlay\var\live-promotion-backups\release-001" `
  --candidate-root "D:\AI_Projects\dsh_harness_overlay\var\candidate\official-desktop-rc5-04"
```

Перед apply DSH Desktop должен быть закрыт. Мутация требует точной фразы
подтверждения, поэтому случайный запуск команды без неё прекращается до чтения
target-файлов:

Проверка процессов также учитывает tray/background-процессы точного EXE
целевой установки: наличие такого процесса блокирует apply/rollback до
изменения профиля. Закрытого окна недостаточно, если DSH остался в трее.

Для установленного integration-релиза используйте явно
`--policy-artifact dist/airules-official-policy-0.12.0-dev11` и его receipt
`var/live-promotion-backups/release-20261104-integrations-dev11/receipt.json`.
Ниже сохранён пример базового workflow; CLI defaults относятся к раннему dev7,
поэтому с новым receipt всегда передавайте matching artifact явно.

```powershell
npm run official:live:apply -- `
  --install-root "C:\Users\S0lo\AppData\Local\Programs\DeepSeek Harness" `
  --profile-root "C:\Users\S0lo\.dsh\profiles\desktop" `
  --backup-root "D:\AI_Projects\dsh_harness_overlay\var\live-promotion-backups\release-001" `
  --candidate-root "D:\AI_Projects\dsh_harness_overlay\var\candidate\official-desktop-rc5-04" `
  --acknowledge I_UNDERSTAND_DSH_IS_CLOSED_AND_THIS_MODIFIES_ITS_PROFILE
```

Apply сначала staging/backup всех операций, повторно проверяет target state,
затем делает quarantine/swap-транзакцию. Backup и receipt остаются во внешнем
каталоге (например, на `D:`), а временный staging создаётся как уникальный
скрытый каталог непосредственно в `profileRoot`. Поэтому финальный
`rename(stage, target)` всегда выполняется в пределах одного volume и не
зависит от cross-volume `EXDEV`. Временный каталог удаляется как после успеха,
так и при recovery; его имя фиксируется в receipt как transaction evidence.
Receipt хранится только во внешнем
backup-каталоге и отдельно фиксирует полный artifact allowlist, реально
изменённые packages, verified no-ops и nested dependency resolution. Rollback
проверяет receipt integrity, allowlist, exact dependency resolution, точные
after/before hashes и восстанавливает профиль транзакционно. Rollback также
копирует backup во временный same-volume stage под `profileRoot`, а не пытается
переименовать путь с внешнего диска:

```powershell
npm run official:live:rollback -- `
  --install-root "C:\Users\S0lo\AppData\Local\Programs\DeepSeek Harness" `
  --profile-root "C:\Users\S0lo\.dsh\profiles\desktop" `
  --receipt "D:\AI_Projects\dsh_harness_overlay\var\live-promotion-backups\release-001\receipt.json" `
  --acknowledge I_UNDERSTAND_DSH_IS_CLOSED_AND_THIS_MODIFIES_ITS_PROFILE
```

Не используйте один backup-каталог повторно: каждая promotion получает новый
receipt. Обновление поверх ранее установленной версии намеренно не разрешено;
сначала выполняется проверяемый rollback.
