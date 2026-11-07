# Специализированные провайдеры: фактический порт и зависимости

Аудит ограничен локальным исходным bundle и установленным native DSH rc.5. Live-провайдеры не опрашивались, аккаунты не копировались.

| Семейство | Реализованный блок | Runtime / граница |
| --- | --- | --- |
| Kimi Code | Изолированный OAuth и native PiAi generation | Собственный credential, native protocol |
| GLM Coding Plan | Ключ, каталог, model resolve, generation через native PiAi | Native `zai`, один собственный ключ |
| Qwen Token Plan | International key-plan | Native `qwen-token-plan`; CN/Individual не притворяются Intl |
| OpenCode Go | Ключ, все родные model protocols | Native `opencode-go`, без собственных URL/attribution overrides |
| Google Gemini | Cold path+SHA256 setup, отдельный OAuth/callback/cancel, локальный auth-check, enable/disable native ACP | Установленный Antigravity ACP executable; отдельный HOME; без автозагрузки |
| Meta Muse | Cold setup, MSP device login/account/read/model/list, локальное отсоединение, native ACP generation | Установленный Muse CLI; MSP SDK1.4.14; без импорта CLI accounts |
| Cursor | Отдельный SDK-wrapper, см. пакет `src/cursor-provider` | Отдельная зона реализации; не часть key-plan или Google/Muse code |

Проверки key-plan: фактический PiAiAdapter установленного SDK с запрещённым fetch — все модели трёх маршрутов проходят listModels/resolveModel. Google/Muse: fixture controller/auth/HTTP/UI tests, проверка SHA-256 реального fixture-файла и сохранение чужих ACP profiles. Наличие классов и request methods проверено в локальных исходниках vendor SDK; полноценный OAuth и generation на аккаунтах здесь не выполнялись.

## Closure для сборщика

| Пакет | Закреплённая версия в donor | Прямые runtime зависимости / примечания |
| --- | --- | --- |
| `@muse-code/sdk` | 1.4.14 | Нет runtime dependencies, Node>=20, MIT; собственный SDK entry `dist/src/index.js` |
| `pi-antigravity-acp-provider` | 0.1.17-bundle.5 | `@agentclientprotocol/sdk`1.8.0, `@modelcontextprotocol/sdk`1.32.1, proper-lockfile4.1.2, unzipper0.12.5,zod4.6.7; peers pi-ai,typebox; optional pi-coding-agent не нужен для нашей factory |
| `@zaimokuza/dsh-acp-adapter` | 0.2.1-rc.3.1 | Уже существующий единый installed-profile registry; не монтировать второй экземпляр |
| `@cursor/sdk` | 1.0.38 | protobuf1.10.0, connect/connect-web^1.6.1,statsig3.31.0,zod peer; optional platform sdk-win32-x64 той же версии, Node>=22.13 |

Google package MIT, но local version содержит bundle patch. Сборщик обязан сохранять точные metadata/hash closure и LICENSE/NOTICE; зависимость с этим suffix нельзя молча заменять публичным upstream. Google/Muse executable runtime не копируется из домашнего профиля или исходного donor: пользователь явно устанавливает и привязывает его по проверенному digest. Google factory отключает managed setup; Muse не вызывает donor ensureMuseRuntime.

Cursor SDK имеет `SEE LICENSE IN LICENSE.md`, ©Anysphere, all rights reserved, применение по Cursor Terms of Service. Не маркировать SDK как MIT и не включать его binary/runtime в Git. В локальном donor фактический CJS entry существует, а metadata ESM/types пути отсутствуют — runtime resolver должен проверять реально доступный entry, не полагаться только на `module` поле. Детали текущей реализации и её ограничения принадлежат Cursor package.

## Что не объявляется перенесённым

Multiaccount, автоматическая ротация, usage/quota aggregation и donor-specific account statistics не входят в эти новые single-account adapters. Native API catalog доступен независимо. Для Google нужен именно ACP server Antigravity; обычный Gemini CLI этим именем не подменяется. Отсутствие установленного runtime отображается как настройка, а не как успешное подключение или неподдерживаемый web client. Ни один из новых блоков не зависит от MCP-фасада; project MCP не переписывается.

Assistant DSH, voice, Atlassian/Jira, поддержка/обновление поставщика и Live2D по прежнему исключены.
