# Метаданные 1С: локальный просмотр

Самостоятельная панель правой боковой панели DSH: объекты из XML/EDT,
пути BSL-модулей, элементы и обработчики событий управляемых форм.
Выбранный native sessionId определяет рабочую папку. Поддержаны открытые
и сохранённые сеансы `1c-airules`; native sandboxPolicy должен разрешать чтение.
Закрытый сеанс читается через native read-only persistence handle и bounded
`sessionProjections.restore`, без поддельного Session с одним header. Если
история превышает 20000 событий, надо открыть сеанс перед просмотром.
Корень, переданный клиентом, не принимается. Доступ к API защищён native connection.

Это сводка файлов, а не рендеринг платформы 1С. Поиск ограничен 4000 записями,
200 XML/MDO-файлами, глубиной 8, 1 MiB на файл, 8 MiB принятых XML и 2.5 s
между файловыми операциями. Символические ссылки и junctions пропускаются,
DOCTYPES/ENTITY запрещены, XML-сущности не раскрываются. Параллельная подмена
каталогов другим процессом не является поддерживаемым сценарием работы.
Нет фонового опроса, записи файлов, shell, COM, MCP, обращения к базе или deploy.

Аудит исходной сборки Олега:

| Блок | Почему не переносится целиком | Продолжение |
|---|---|---|
| `metadata-tree.js` | Full gate, configuration targets, borrow, evidence/deploy и graph MCP | В этом пакете реализована независимая локальная сводка |
| `project-wizard.js` | Создание/подготовка базы, `.cf/.dt`, запись settings/defaults, bundled MCP URLs | Отдельно проектировать source-only мастер после сравнения проектного deploy |
| `long-operations.js` | Перехват всех MCP, распознавание configurator/deploy, запись shell background policy | Панель фактически зарегистрированных native jobs требует отдельного контракта API; не имитировать jobs |
| `version-help.js` | Full policy и поиск raw MCP методов `ssl_search`/`docsearch` | В будущем адаптер через проектно подключённый фасад; сохранять since/citations, не обещать version filter платформы |

Staging: пакет `airules-dsh-onec-panels`, вложенный `fast-xml-parser@4.5.7`
и его зависимость `strnum@1.1.2`. В runtime DSH дополнительных vendor-пакетов нет.
Проверка: `node --test tests/onec-panels.test.mjs` из корня overlay.
Реализация написана заново; исходники supplier policy не копировались.
