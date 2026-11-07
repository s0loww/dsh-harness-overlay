# Группировка настроек: адаптация native shell rc5

`patchSettingsShell(source)` из `patch.mjs` — offline-преобразование pinned
`@deepseek-ai/dsh-client-ui-settings-general/lib/client.js` версии 0.2.1-rc.5.
Проверяет SHA256 исходника до изменения, повторное применение идемпотентно.
Меняет только внутреннюю навигацию SettingsPanel и размеры диалога/меню.
Зарегистрированные реальные `settings.section` группируются в семь разделов.
Пустые группы не рисуются, неизвестные плагины доступны в «Другие расширения».

Нативные store, launcher, shortcuts, focus/modal layer, close, onboarding,
settings.action и рендер страниц сохраняются. Новых настроек, разрешений,
HTTP-запросов или заглушек адаптация не создаёт. Готовый providers-settings
скрывает дубли только если его реальный section зарегистрирован; deep-link
на старые models/account/subscriptions/Kimi направляется на единую страницу.

Почему offline patch: официальный API позволяет добавлять `settings.section`,
но у private SettingsPanel отсутствует slot для рендера навигационных групп.
Сборка Олега решает это патчем `scripts/repair-settings-navigation-r148.mjs`.
Здесь используется собственная небольшая реализация по той же UX-структуре.
Замена целого `sidebar.settings` потеряла бы private store и shortcut lifecycle.

Реальные API pinned клиента:

- `ctx.slots.inject('settings.section', () => ctx.slots.register({ name:
  'settings.section', id, label: () => '...', order }, Component))`;
- ledger: `entries/getVersion/subscribe('settings.section')`;
- native shell вызывает `renderSlot('settings.section', {close:onClose}, {only:id})`;
- проектная страница использует `sessions.list` через объявленный inject и
  selected `retainedBy.mainView`, затем `current`. Клиент передаёт sessionId,
  host определяет cwd по attached header или sessionPersistence.stat;
- рекомендуемый id проекта: `airules-onec-project`, id общей модели/провайдеров:
  `airules-providers-settings`.

Мастер, deploy/проверки, supplier MCP canon, поддержка/обновление сборки,
голос, Live2D и Jira этим пакетом не добавляются. Наличие пунктов зависит
только от реально скомпонованных плагинов. Версионная адаптация нужна заново
при изменении официального baseline; несоответствие хеша останавливает staging.

Проверка: `node --test tests/settings-shell.test.mjs`.
