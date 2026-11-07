# Дополнительные провайдеры

Без сетевых обращений при старте. Перенесён отдельный Kimi Code OAuth, один аккаунт, собственный credential key `airules-additional-providers/kimi`, отдельный route `airules-kimi-coding`. Настройки имеют отдельную fallback-секцию `airules-kimi`, компонент `KimiSettings` также экспортирован для общей страницы провайдеров. Вход запускает только явная кнопка. Нативные аккаунты и CLI не импортируются. Авторизацию и обработку моделей выполняет штатный PiAiAdapter текущего DSH, включая attribution headers.

Пакет не имеет внешних npm-зависимостей: staging должен разрешить peer dependencies из установленного DSH 0.2.1-rc.5. Добавить package в package dependencies/plugin config и client entry штатным способом. HTTP route требует admission native `connection` и CSRF для изменений. Само включение пакета не включает аккаунт и не устанавливает CLI. Не заменяет встроенный `kimi-coding`.

| Блок источника | Решение |
| --- | --- |
| Kimi | Реализован изолированный OAuth и штатный model adapter; без monkeypatch чужого адаптера и импорта native grant |
| Google Gemini / Muse CLI | Отложены: нужны явный путь установленного CLI, ACP permissions, lifecycle, workspace policy; поставщик автоматически разрешает runtime |
| Cursor | Отложен: SDK, usage API, account rotation, permission middleware; 61 KB связанного runtime |
| Claude Max | Не дублируется: базовые Claude subscriptions уже отдельным пакетом; Max-specific CLI auth требует отдельной реализации и установленного CLI |
| GLM / Qwen / OpenCode | Пока доступны штатные API-настройки DSH; специфические подписочные расширения не объявляются перенесёнными |

Проверки без сети: `node --test tests/additional-providers.test.mjs`. Live login / генерация требуют пользовательского аккаунта; не выполняются автоматически. Квоты, multiaccount и rotation не реализованы.
