# Дополнительные провайдеры

Без сетевых обращений при старте. Перенесён отдельный Kimi Code OAuth, один аккаунт, собственный credential key `airules-additional-providers/kimi`, отдельный route `airules-kimi-coding`. Настройки имеют отдельную fallback-секцию `airules-kimi`, компонент `KimiSettings` также экспортирован для общей страницы провайдеров. Вход запускает только явная кнопка. Нативные аккаунты и CLI не импортируются. Авторизацию и обработку моделей выполняет штатный PiAiAdapter текущего DSH, включая attribution headers.

Пакет не имеет внешних npm-зависимостей: staging должен разрешить peer dependencies из установленного DSH 0.2.1-rc.5. Добавить package в package dependencies/plugin config и client entry штатным способом. HTTP route требует admission native `connection` и CSRF для изменений. Само включение пакета не включает аккаунт и не устанавливает CLI. Не заменяет встроенный `kimi-coding`.

| Блок источника | Решение |
| --- | --- |
| Kimi | Реализован изолированный OAuth и штатный model adapter; без monkeypatch чужого адаптера и импорта native grant |
| Google Gemini / Muse CLI | Отдельный пакет `airules-dsh-provider-extensions`: явный установленный runtime и SHA-256, отдельный вход, generation через общий ACP adapter |
| Cursor | Отдельный пакет интеграции SDK; не относится к PiAi key-plan adapter |
| Claude Max | Не дублируется: базовые Claude subscriptions уже отдельным пакетом; Max-specific CLI auth требует отдельной реализации и установленного CLI |
| GLM / Qwen / OpenCode | Реализованы изолированные key-plan routes через штатный PiAiAdapter; один ключ на план, без ротации/квот |

`ApiPlanSettings({providerId})` и `PLAN_SUBSCRIPTIONS` экспортированы для общей страницы. Fallback — секция `airules-api-plans`. Route `/airules/additional-provider-plans`: native admission, CSRF, bounded JSON, revision CAS при сохранении. Собственные native credential slots: `zai-plan`, `qwen-plan`, `opencode-go`; записи `{kind:'api-key',key}`. Сохранение ключа не проверяет подписку сетевым запросом.

| Route | Native provider | План |
| --- | --- | --- |
| `airules-zai-plan` | `zai` | GLM Coding Plan |
| `airules-qwen-plan` | `qwen-token-plan` | Qwen Token Plan International |
| `airules-opencode-go` | `opencode-go` | OpenCode Go |

Нативные protocols, attribution headers и каталог моделей сохраняются. CN и Individual варианты Qwen не подменяются международным endpoint; специфические варианты этой карточкой не добавляются. Ключи окружения и чужие native/CLI credentials не читаются. После изменения ключа обновляется регистрация адаптеров и каталог. Без ключа план не публикует доступные модели.

Проверки без сети: `node --test tests/additional-providers.test.mjs tests/additional-providers-extended.test.mjs`. Вторая группа проверяет фактический native PiAiAdapter из закреплённого SDK: listModels/resolveModel всех трёх планов с запрещённым fetch. Live login / генерация требуют пользовательского аккаунта; автоматически не выполняются. Квоты, multiaccount и rotation не реализованы.
