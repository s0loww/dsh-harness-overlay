# Переключение рассуждений: UI dev12

Установлено 2026-11-04, официальный Desktop rc.5, policy dev13.

Анимированный dsh-effort-slider 1.1.0 оказался несовместим с rc.5 в двух местах:
старый connection.api.sessions вместо native per-session ModelDirectory и
document capture handler, блокирующий штатный клик до поиска legacy global
current session. Перенос только API не исправлял открытие меню (UI dev11).

Shipping UI dev12 отключает browser apply/inject плагина и его static CSS.
Сохраняются пакет и Cordis row, но не устанавливаются слушатели, WebGL-панель
или глобальные перехватчики. Используется штатное session-bound меню DSH.
Экспериментальный shared-directory adapter оставлен только для отдельных
тестов и возможного будущего переноса через настоящий native slot.

Проверено:

- Полный набор 206/206 PASS; настоящий native runtime передаёт High/XHigh в
  Codex wire при default Low, неподдерживаемый уровень отклоняется до сети.
- Patched factory регистрирует ноль DOM listeners/styles и не блокирует клик.
- Candidate08: rollback/reapply и visible startup PASS.
- Live receipt:
  var/live-promotion-backups/release-20261104-native-effort-ui12/receipt.json.
- Guarded update сохраняет пользовательский cordis.patch.yml побайтно.
- В живом чате после исходного Low виден High, меню содержит native radio
  Low/Medium/High/Extra High/Max/Ultra. Сохраняем выбранный пользователем High.
- Пользователь подтвердил: «Да, работает».
- Проверка UI не отправляла новых сообщений модели и не меняла model defaults
  в настройках провайдера.
