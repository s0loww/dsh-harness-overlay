# Модели обработки памяти Cognee

Профиль независимо выбирает эмбеддинги и извлечение связей. Это настройка общего локального сервера Cognee, а не отдельного чата. Сохранение выбора не вызывает модель, не меняет контейнер и не означает, что выбранный профиль уже применяется. Разрешение обработки `allowed` — дополнительный локальный запрет DSH.

## Контракт

`processing.js` экспортирует `DEFAULT_PROCESSING`, `validateProcessing`, `processingFingerprint`, `isProcessingReady`, `discoverProcessingModels`. `processing-runtime.js` экспортирует `createProcessingManager`, `validateProcessingBinding`, `processingCommand`, `validateProcessingCommand` и два фиксированных инспектора Python.

```js
profile = {
  allowed: false,
  embeddings: { provider: 'fastembed', model: 'BAAI/bge-small-en-v1.5', dimensions: 384 },
  extraction: { provider: 'gliner', model: 'fastino/gliner2.5-base-v1' }
}
configuration = {
  profile, revision, bindingAvailable,
  applied: { state: 'unverified', fingerprint: null, matchesDesired: false }
}
```

Варианты `applied.state`: `unverified`, `observed`, `applied`, `unknown`. Дополнительные публичные поля: `observedAt`, `dataCount`, `activeRuns`. Готовность: `profile.allowed && applied.matchesDesired` и состояние `observed` либо `applied`. Fingerprint включает обе модели, размерность и адреса, но исключает `allowed`. Смена адреса или размерности эмбеддингов считается сменой индекса.

Менеджер получает абсолютные `profilePath`, `bindingPath`, `statePath`, `backupRoot`, а также внедрённые `runner(spec, execution)`, `guard(execution)`, `authorize(execution, summary)` и необязательный `getOpenRouterKey(execution)`. Конструктор не запускает subprocess. `authorize` должен вернуть `allowed-once` только после штатного разрешения в DSH; `guard` повторно проверяет реальный сеанс, песочницу и область доступа после асинхронных шагов.

Методы:

- `configuration()` — читает локальные настройки и подтверждённое состояние без обращения к Docker.
- `save({profile, expectedRevision})` — CAS сохранение желаемого профиля без активного чата.
- `catalog({kind, provider, endpoint?}, execution?)` — совместимые доступные модели; `{models:[{id,label,kind,state,dimensions?}], available, note?}`.
- `inspect(execution?)` — только чтение реального состояния; может подтвердить уже работающий профиль.
- `apply({expectedRevision, confirm:true, execution})` — проверяет, запрашивает штатное разрешение и при необходимости меняет сервер; возвращает конфигурацию с `restarted`, при неопределённом результате — `outcomeUnknown:true`.
- `invalidateCredential()` — после записи нового ключа в штатное хранилище снимает подтверждение профиля OpenRouter. Чтение состояния не снимает эту отметку; нужен новый разрешённый apply.

Отсутствие machine binding не мешает сохранять профиль, но запрещает применение. Пример отдельной локальной привязки (конкретный каталог задаёт установщик):

```json
{"schemaVersion":1,"composeDir":"<absolute-local-cognee-directory>","composeFile":"compose.yaml","envFile":".env","container":"dsh_cognee_local","service":"cognee","ownerSid":"<Windows SID>"}
```

`ownerSid` нужен для защиты приватных файлов в Windows. Пакет не содержит машинных путей и пользовательских SID.

## Каталоги и фактическая обработка

| Провайдер | Эмбеддинги | Связи | Каталог |
| --- | --- | --- | --- |
| FastEmbed | Да | — | Только проверенные локальные ONNX snapshots с tokenizer; ничего не скачивается |
| GLiNER | — | Да | Только фактически закэшированный `fastino/gliner2.5-base-v1`; другая модель не поддержана конфигурацией этой версии Cognee |
| Ollama | Да | Да | `/api/tags`, `/api/ps`, `/api/show`; проверяются capabilities и ширина вектора |
| LM Studio | Да | Да | Типизированный `/api/v1/models`, fallback `/api/v0/models`; неизвестный тип не считается совместимым |
| OpenRouter | Да | Да | Публичные GET `/api/v1/embeddings/models` и `/api/v1/models`; без ключа и без инференса |

Каталоги ограничены по размеру ответа и времени, редиректы запрещены. Ollama metadata POST `/api/show` ничего не генерирует. Модель со статусом `installed` не обязательно загружена; `loaded` показывается только при подтверждении сервера. Наличие записи в реестре FastEmbed не означает установку: проверяется кэш файлов. Никакого поиска по всему диску.

Локальные адреса — только HTTP numeric loopback `127.0.0.1` или `[::1]`, необязательный `/v1`; без userinfo, query и fragment. Со стороны DSH каталог читается по loopback. В конфигурации контейнера этот адрес преобразуется в `host.docker.internal`. При apply фиксированный инспектор из контейнера проверяет доступность выбранного локального model endpoint по метаданным. Если сервер слушает только Windows loopback и недоступен Docker, профиль не подтверждается; правила firewall автоматически не меняются.

Выбор OpenRouter явно выполняет публичный запрос каталога в Интернет. Сам apply не вызывает платные embedding/chat endpoints. Настоящая последующая обработка памяти или semantic search при таком профиле обращается к OpenRouter и может расходовать средства. Для неизвестной embedding-модели нужна явная размерность. У Cognee 1.6.7 OpenAI-compatible engine проверяет возвращённую ширину, но не передаёт параметр сокращения `dimensions`; для известных OpenAI моделей допускается только полная ширина.

## Ключи, применение и сохранность индекса

Ключ OpenRouter принадлежит штатному хранилищу DSH. Callback читает его приватно непосредственно перед построением нового env после повторной проверки разрешения; fallback — уже существующий ключ в серверном `.env`. Ключ не входит в профиль, каталог, prompt разрешения, результат, публичное состояние или receipt. Исключения resolver редактируются до безопасного кода ошибки.

Применение сверяет версию Cognee 1.6.7, здоровье, активные задания, текущую конфигурацию и число реальных записей. GLiNER сам по себе не доказывает локальные эмбеддинги: инспектор учитывает действительные условия keyless fallback Cognee, иначе отказывает в подтверждении. Неизвестные stage-specific overrides, BAML, skip-preflight и непроверяемая база не считаются безопасным исходным состоянием.

Если меняется embedding identity и в сервере уже есть данные, apply возвращает `PROCESSING_REINDEX_REQUIRED`. Автоматической очистки, смешения старых векторов, миграции или удаления данных нет. Смена только extraction-модели существующий embedding index не меняет. Активные pipeline runs блокируют перезапуск. Даже ранее созданные тестовые datasets автоматически не признаются одноразовыми.

Перед изменениями сохраняются защищённые копии `.env` и управляемого override. На Windows приватный файл создаётся пустым, защищается фиксированным вызовом `icacls`, после чего записываются байты; сбой ACL запрещает запись секрета. Значения посторонних env сохраняются. Исходный `compose.yaml` не переписывается. Собственный `compose.override.yaml` содержит фиксированный marker и снимает hardcoded `GRAPH_EXTRACTOR` базового compose через `${GRAPH_EXTRACTOR}`. Пользовательский override не перетирается: `PROCESSING_OVERRIDE_OWNED_BY_USER`.

Все subprocess выполняет app-owned runner. Операции: `inspect-cache`, `inspect-server`, `recreate`, `protect-private`. Для read-only broker разрешать только первые две и проверять точное совпадение с `validateProcessingCommand`; произвольный Python и shell-команды не разрешаются. Для mutating broker дополнительно нужны штатные права DSH и ограниченная область доступа. Runner возвращает `{code,stdout,stderr?}`; stderr не включается в публичные ошибки.

Файлы проверяются CAS перед изменением и после ожиданий. Credential epoch защищает ротацию ключа во время apply. Тот же профиль с новым ключом приводит к приватному обновлению env и пересозданию контейнера; тот же профиль с тем же подтверждённым ключом может только подтвердить состояние без перезапуска.

Если после dispatch результат неизвестен, автоматического rollback/retry нет: возвращается `unknown`, обработка остаётся выключенной, сохраняются защищённый backup и публичный receipt. Повторное применение требует нового разрешения и повторного чтения реального состояния. Изменение `.env`, binding или override вне менеджера также снимает готовность.

## Проверено

`node --test tests/memory-processing.test.mjs`: 16 тестов с fake runner/provider, включая CAS, несовпадение индексов, busy server, отозванные права, ACL, сохранность ключей, неизвестный исход restart и ротацию ключа во время dispatch. Реальные модели и paid endpoints в тестах не вызываются.

Отдельно read-only инспекторы проверены на локальном контейнере Cognee 1.6.7: оба встроенных кэша обнаружены; API healthy, база проверена, 11 записей, активных pipeline runs 0. Реальные env не изменялись и контейнер не перезапускался. Полный apply с локальными LLM/OpenRouter проверен на заглушках; готовность реального выбранного endpoint подтверждается только при разрешённом применении на машине пользователя.
