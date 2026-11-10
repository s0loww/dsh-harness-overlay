# Обновление официального DSH: оценка перед миграцией

Проверено 2026-11-10. Это read-only исследование metadata и исходников текущего
overlay. Установщик новой версии не скачивался и не запускался, рабочая оболочка
и профили не изменялись этой проверкой.

## Подтверждённая новая версия

Установленная оболочка — `0.2.1-rc.5`; её updater читает официальный generic feed:

`https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml`

На момент проверки feed объявляет **0.2.2-rc.1**, rollout 100%, releaseDate
`2026-11-04T09:31:49.677Z`. Это также pre-release в официальном GitHub, tag
`dsh-v0.2.2-rc.1`, commit `66491b0`.

Официальный Windows installer из feed:

```text
https://download.deepseek.com/dsh-desk/bin/win-x64/deepseek-harness-0.2.2-rc.1-win-x64.exe
bytes: 293425336
sha512(base64): swcK0J6ofGkaAWLRpOes2ca7CWO8vuM5Vp0FRnQ/DG3q+Z+OhvsgLz3hIiSYpRUETY+fEz+Ww86fNa0jiVIifw==
```

Этот digest получен из TLS feed, а не из проверки скачанного файла. Проверку
Authenticode/издателя ещё предстоит выполнить. Локальный updater cache содержит
старый `installer.exe` от 2026-11-03 размером 289408544 байта: это не новый пакет.

NPM metadata для официального `@deepseek-ai/dsh@0.2.2-rc.1` подтверждает Node
`>=24.9.0`. Наличие NPM package не доказывает идентичность Desktop bundle.

Источники:

- [Официальный feed](https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml).
- [Официальный release/changelog](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.1).
- [Официальная страница Desktop](https://www.deepseek.com/en/download/).
- [NPM metadata DSH](https://registry.npmjs.org/@deepseek-ai%2Fdsh/0.2.2-rc.1).

## Почему миграция полезна

В release notes перечислены native русская локализация, обновление сторонних
плагинов с попыткой восстановления, улучшения мобильного интерфейса, вывода
истории и статистики. Для нашей сборки также важны исправления переключения на
модель с меньшим контекстом, делегирования после смены пресета, восстановления
скиллов при отказе одного каталога и Windows sandbox. Перед изменением наших
локальных обходов нужно проверить новый runtime, а не считать каждое похожее
описание полным исправлением нашего случая.

## Основные точки совместимости

| Участок | Факт и требуемая проверка |
|---|---|
| Target/artifact locks | `upstream/official-desktop/release.lock.json` связывает rc.5 с пятью exact hashes. UI/policy manifests проверяют hostVersion и ASAR. Нужен отдельный новый lock; существующий не заменять и guards не отключать. |
| Settings shell | `src/settings-shell/patch.mjs:5` принимает exact rc.5 client hash и якоря. Нужна адаптация нового клиента и native ru locale; текущую страницу нельзя объявить совместимой только по внешнему сходству. |
| Tool/fs compatibility | `src/native-fs-compat/patch.mjs:4` привязан к rc.5 и exact local/sandbox bytes. Release notes не подтверждают исправление нашего BOM edit. Сначала повторить UTF-8 BOM/CRLF/versioned-edit fixtures, затем убрать обход либо сделать отдельный exact patch. |
| Editor/LSP/composer | `src/onec-lsp-compat/patch.mjs:5` и `src/composer-history-compat/patch.mjs:4` прямо ограничены rc.5. Нужна проверка manifest/API/клиента и новая точная совместимость, без расширения peer ranges вслепую. |
| Tools/PTC | Changelog меняет step-specific admission/prompt interfaces, разделяет native/PTC execution plugins и overlay-конфигурацию. Наши registry get/execute, parent-token forwarding, background calls, recovery и document bridges требуют новой native приёмки. |
| Model routing | Новый runtime фиксирует модель перед pre-step и больше не разрешает route rewrite в agent/request. Наши ACP/Cursor guards (`src/acp/lib/outbound.js:43`, `src/cursor-provider/lib/access.js:14`) используют это событие для допуска и корреляции. Они не переписывают route, но порядок и signal/model binding нужно перепроверить. |
| Cordis/projections | Changelog объявляет Cordis 4.1.0, Loader 1.1.0, Include 1.1.0 и async projection registration. Нужно проверить наши mounts, optional injection, config-editor и state restoration; старые 671/109 результаты относятся к rc.5. |
| Official bundles/boot | Экспорт официальных bundles вынесен в `@deepseek-ai/dsh-official-bundles`; boot probes и composition inventory должны использовать новый публичный контракт. |
| Sessions/storage | Changelog меняет Session snapshot/subscription/projection API и поддержку storage versions. До первого запуска нового host на реальном HOME нужен отдельный защищённый backup данных; package rollback receipt не гарантирует downgrade сессий после их записи новым runtime. |
| Cognee memory | HTTP core независим от DSH SDK, но controller/tool access завязан на agents, native origin, sandbox, approval, followup и UI slots. Повторить их настоящий native probe на новой оболочке, включая отказ субагенту в записи и отсутствие операций до approval. |

Из changelog известны изменения интерфейсов. Таблица не утверждает, что каждый
наш модуль уже воспроизведённо сломан: новый SDK/ASAR ещё не извлекался.

## Порядок обновления

1. Зафиксировать работающий rc.5 memory release UI23/policy43 и его backup/receipt.
   Не смешивать выпуск памяти с незавершённой миграцией host.
2. Скачать указанный официальный installer в ignored staging, проверить bytes,
   SHA-512 и Authenticode/ожидаемого издателя. Не запускать обновление поверх live.
3. Извлечь/подготовить новую отдельную candidate-установку с пустым HOME и своим
   Electron userData. Снять новый native SDK/package inventory и target lock.
   Не копировать аккаунты, чаты и project credentials в синтетический стенд.
4. Сделать явный version-dispatch адаптаций и сборки. Сохранить возможность
   проверенного отката rc.5, не переписывать неизменяемые старые артефакты.
5. Прогнать source/closure tests и настоящие native cases: boot, меню/локаль,
   настройки моделей/reasoning, все три пресета, lazy skills/delegation,
   sandbox/approval/PTC/jobs, BOM/edit, OpenSpec и memory CRUD pipeline на
   синтетических заметках. Реальный deploy 1С остаётся запрещён.
6. Выполнить visible smoke, UI acceptance и apply/rollback/reapply новой candidate.
   Сравнить native ru с нашей локализацией, устранив только доказанные дубли.
7. Перед live upgrade полностью закрыть DSH и сохранить старые binaries плюс
   защищённую копию пользовательских state/session/config stores. Backup с
   credentials не входит в дистрибутив или git. Учитывать возможную одностороннюю
   запись форматов; отрабатывать rollback на копии, не на живых чатах.
8. Обновить live host и соответствующий overlay одной согласованной процедурой,
   проверить перезапуск/доступность/receipt, затем отдельно планировать новую
   реализацию continuity по актуальному native lifecycle.

Рекомендация: обновляться на 0.2.2-rc.1 после candidate migration; не нажимать
немедленный in-place update с текущими exact rc.5 adapters. Ошибок feed или
отсутствия официального релиза не обнаружено; объём работы — совместимость
нашей сборки, а не поиск версии.
