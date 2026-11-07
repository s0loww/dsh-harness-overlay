window.__ModuleLoader__.load({ id: "airules-dsh-subscriptions", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
//#region rolldown:runtime
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
	if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
		key = keys[i];
		if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
			get: ((k) => from[k]).bind(null, key),
			enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
		});
	}
	return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
	value: mod,
	enumerable: true
}) : target, mod));

//#endregion
let react = require("react");
react = __toESM(react);
let react_jsx_runtime = require("react/jsx-runtime");
react_jsx_runtime = __toESM(react_jsx_runtime);
let __deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
__deepseek_ai_dsh_client_ui_primitives = __toESM(__deepseek_ai_dsh_client_ui_primitives);

//#region src/client/locales.ts
/** Copy dictionaries for the Subscriptions settings section. */
/** English strings (the key-set source of truth for this pair). */
const en = {
	modelsPartialSave: "Часть настроек сохранена. Остальные изменения остались в черновике; повторите сохранение.",
	modelsEdit: "Настроить список моделей",
	modelsHint: "Настройте видимость моделей, уровень рассуждения и размер контекста, затем сохраните. Выбор отключённых моделей будет очищен во всех чатах и настройках; появится предложение выбрать замену.",
	modelsAutomatic: "Показывать все модели, включая новые",
	modelsSelectAll: "Выбрать все",
	modelsSelectNone: "Снять выделение",
	modelsContext: "Контекст (токены)",
	modelsContextBounds: "По умолчанию {default} · максимум {max}",
	modelsContextHint: "Оставьте пустым, чтобы использовать значение провайдера. Запрошенное окно не превышает максимума, который объявляет аккаунт; для пула аккаунтов берётся наименьшее окно. Это влияет на локальную историю и сжатие, а не на возможности API.",
	modelsContextInvalid: "Введите положительное целое число токенов для {model}.",
	modelsTools: "Инструменты провайдера",
	modelsToolsHint: "Изменения действуют только для сессий, созданных после сохранения; у существующих сессий инструменты прежние. Генерация изображений доступна, если включён Codex или Grok.",
	modelsImage: "Создание изображений",
	modelsVideo: "Создание видео",
	modelsSearch: "Поиск в X",
	modelsSave: "Сохранить изменения",
	modelsSaved: "Сохранено. Изменения инструментов действуют в новых сессиях.",
	modelsSavedNoTools: "Настройки моделей сохранены.",
	modelsUnavailable: "Сейчас недоступно",
	nav: "Подписки",
	intro: "Подключите свою подписку через вход в аккаунт. Страница авторизации откроется в новой вкладке. Если это не сработает, вставьте адрес возврата или код вручную.",
	unavailable: "Соединение недоступно: не удалось получить состояние подписок.",
	checking: "Проверка…",
	loginInProgress: "Выполняется вход…",
	notLoggedIn: "Вход не выполнен",
	loggedInCount: "Подключено аккаунтов: {count}",
	accountExpires: "действует до {date}",
	defaultBadge: "По умолчанию",
	setDefault: "Использовать по умолчанию",
	addAccount: "Добавить аккаунт",
	addAccountOAuth: "Войти через браузер",
	addAccountKeychain: "Подключить аккаунт Claude Code",
	addAccountHint: "Будет подключён аккаунт, открытый в браузере. Для другого аккаунта сначала смените его в браузере или используйте приватное окно и ручной ввод кода ниже.",
	login: "Войти",
	cancel: "Отмена",
	logout: "Выйти",
	logoutAccountConfirm: "Отключить аккаунт {account} от {provider}?",
	manualSummary: "Не получилось войти через браузер? Вставьте адрес возврата или код",
	manualPlaceholder: "Вставьте адрес возврата или код",
	submit: "Подтвердить",
	loginMissingUrl: "Сервис не вернул адрес страницы авторизации",
	deviceCodePrompt: "Введите этот код на странице подтверждения GitHub:",
	deviceCodeCopy: "Копировать код",
	deviceCodeCopied: "Скопировано",
	deviceCodeOpenPage: "Открыть подтверждение GitHub",
	usageTitle: "Использование",
	usageRefresh: "Обновить",
	usageLoading: "Загрузка данных использования…",
	usageEmpty: "Сведения о лимитах не предоставлены.",
	usageError: "Не удалось получить данные использования: {message}",
	usageSession: "За 5 часов",
	usageWeekly: "За неделю",
	usageWindow: "Период",
	usageResets: "сброс {date}",
	usagePlan: "Тариф: {plan}",
	modelDefaultsTitle: "Уровень рассуждения по умолчанию",
	modelDefaultsHint: "Этот уровень выбирается при переключении модели. Для моделей без нескольких уровней действует настройка провайдера.",
	modelDefaultsFollowProvider: "Настройка провайдера",
	modelDefaultsNoLevels: "Моделей без выбора уровня рассуждения: {count}. Для них действует настройка провайдера.",
	modelDefaultsLoading: "Загрузка моделей…",
	modelDefaultsLoadFailed: "Не удалось загрузить модели: {message}",
	modelDefaultsRetry: "Повторить",
	modelDefaultsRefresh: "Обновить модели всех подписок",
	modelDefaultsSaving: "Сохранение…",
	modelDefaultsSaveFailedNamed: "Не удалось сохранить {model}: {message}",
	modelDefaultsSummary: "Моделей: {total} · настроено отдельно: {configured}",
	modelDefaultsSummaryNone: "Моделей: {total} · настройки провайдера",
	modelDefaultsSummaryEmpty: "У моделей нет выбора уровня рассуждения",
	modelDefaultsFilterPlaceholder: "Найти модель",
	modelDefaultsFilterEmpty: "Моделей по запросу «{query}» нет.",
	generating: "Создание изображения…",
	image: "изображение",
	viewImage: "Открыть изображение",
	viewImageNamed: "Открыть {name}",
	imageLoading: "Загрузка…",
	imageLoadFailed: "Повторить",
	imagePreview: "Предпросмотр изображения",
	imageClose: "Закрыть",
	generatingVideo: "Создание видео…",
	videoLoading: "Загрузка видео…",
	videoLoadFailed: "Не удалось загрузить видео: {message}",
	speed: "Скорость",
	speedStandard: "Обычная",
	speedStandardDescription: "Обычная скорость",
	speedFast: "Быстрая",
	speedFastDescription: "Скорость ×1,5, повышенный расход",
	commandFast: "Переключить скорость Codex (обычная/быстрая)",
	commandFastUnavailable: "Быстрый режим недоступен. Команда /fast работает только с поддерживающими её моделями Codex.",
	proxyTitle: "Прокси",
	proxyStatusNone: "Прокси плагина выключен. Действуют сетевые настройки DSH.",
	proxyStatusEnabled: "Включён · {url}",
	proxyStatusError: "Ошибка настройки: {message}",
	proxyConfigure: "Настроить…",
	proxyDialogTitle: "Настройки прокси",
	proxyDialogClose: "Закрыть",
	proxyEnabled: "Направлять запросы подписок через прокси",
	proxyUrl: "Адрес прокси",
	proxyUrlPlaceholder: "http://localhost:7890",
	proxyUrlHint: "Поддерживается HTTP/HTTPS-прокси (Clash/mihomo, v2rayN…). SOCKS не поддерживается.",
	proxyUsername: "Имя пользователя (необязательно)",
	proxyUsernamePlaceholder: "Имя пользователя прокси",
	proxyPassword: "Пароль",
	proxyPasswordPlaceholder: "Оставьте пустым, чтобы сохранить текущий пароль",
	proxyClearPassword: "Удалить сохранённый пароль",
	proxyBypass: "Адреса в обход прокси",
	proxyBypassPlaceholder: "127.0.0.1, localhost, *.example.com",
	proxyBypassHint: "Адреса через запятую: запросы к ним используют сетевые настройки DSH.",
	proxyTest: "Проверить",
	proxyTesting: "Проверка…",
	proxyTestOk: "Готово · HTTP {status} · {ms} мс",
	proxyTestOkDirect: "Готово (сетевые настройки DSH) · HTTP {status} · {ms} мс",
	proxyTestFail: "Ошибка: {message}",
	proxySave: "Сохранить",
	proxyCancel: "Отмена",
	proxySaving: "Сохранение…",
	proxyLoading: "Загрузка настроек прокси…",
	proxyLoadFailed: "Не удалось загрузить настройки прокси: {message}",
	proxySaved: "Сохранено. Новые запросы используют обновлённые сетевые настройки.",
	proxySaveFailed: "Не удалось сохранить: {message}",
	proxyNote: "В DSH v0.1.3-alpha.1 и новее лучше задать HTTP_PROXY / HTTPS_PROXY / ALL_PROXY / NO_PROXY на уровне хоста, а прокси этого плагина оставить выключенным. Эта необязательная настройка сохранена для старых версий и для маршрутизации только подписок. Выключенный или обходящий прокси запрос идёт по сетевым настройкам DSH — не обязательно напрямую. Действует для обмена токенами, API моделей, расхода и инструментов. Вход через браузер (OAuth) идёт через прокси браузера или системы."
};
/** zh strings, one per {@link en} key. */
const zh = {
	modelsPartialSave: "Часть настроек сохранена. Остальные изменения остались в черновике; повторите сохранение.",
	modelsEdit: "Настроить список моделей",
	modelsHint: "Настройте видимость моделей, уровень рассуждения и размер контекста, затем сохраните. Выбор отключённых моделей будет очищен во всех чатах и настройках; появится предложение выбрать замену.",
	modelsAutomatic: "Показывать все модели, включая новые",
	modelsSelectAll: "Выбрать все",
	modelsSelectNone: "Снять выделение",
	modelsContext: "Контекст (токены)",
	modelsContextBounds: "По умолчанию {default} · максимум {max}",
	modelsContextHint: "Leave blank to follow the provider. The requested window is capped by the account’s advertised maximum; account pools use the smallest member window. This controls local history and compaction, not the API’s capacity.",
	modelsContextInvalid: "Введите положительное целое число токенов для {model}.",
	modelsTools: "Инструменты провайдера",
	modelsToolsHint: "Changes apply only to sessions created after saving. Existing sessions keep their tools. Image generation remains available if either Codex or Grok is enabled.",
	modelsImage: "Создание изображений",
	modelsVideo: "Создание видео",
	modelsSearch: "Поиск в X",
	modelsSave: "Сохранить изменения",
	modelsSaved: "Сохранено. Изменения инструментов действуют в новых сессиях.",
	modelsSavedNoTools: "Настройки моделей сохранены.",
	modelsUnavailable: "Сейчас недоступно",
	nav: "Подписки",
	intro: "Подключите свою подписку через вход в аккаунт. Страница авторизации откроется в новой вкладке. Если это не сработает, вставьте адрес возврата или код вручную.",
	unavailable: "Соединение недоступно: не удалось получить состояние подписок.",
	checking: "Проверка…",
	loginInProgress: "Выполняется вход…",
	notLoggedIn: "Вход не выполнен",
	loggedInCount: "Подключено аккаунтов: {count}",
	accountExpires: "действует до {date}",
	defaultBadge: "По умолчанию",
	setDefault: "Использовать по умолчанию",
	addAccount: "Добавить аккаунт",
	addAccountOAuth: "Войти через браузер",
	addAccountKeychain: "Подключить аккаунт Claude Code",
	addAccountHint: "Будет подключён аккаунт, открытый в браузере. Для другого аккаунта сначала смените его в браузере или используйте приватное окно и ручной ввод кода ниже.",
	login: "Войти",
	cancel: "Отмена",
	logout: "Выйти",
	logoutAccountConfirm: "Отключить аккаунт {account} от {provider}?",
	manualSummary: "Не получилось войти через браузер? Вставьте адрес возврата или код",
	manualPlaceholder: "Вставьте адрес возврата или код",
	submit: "Commit",
	loginMissingUrl: "Сервис не вернул адрес страницы авторизации",
	deviceCodePrompt: "Введите этот код на странице подтверждения GitHub:",
	deviceCodeCopy: "Копировать код",
	deviceCodeCopied: "Скопировано",
	deviceCodeOpenPage: "Открыть подтверждение GitHub",
	usageTitle: "Использование",
	usageRefresh: "Обновить",
	usageLoading: "Загрузка данных использования…",
	usageEmpty: "Сведения о лимитах не предоставлены.",
	usageError: "Не удалось получить данные использования: {message}",
	usageSession: "За 5 часов",
	usageWeekly: "За неделю",
	usageWindow: "Период",
	usageResets: "сброс {date}",
	usagePlan: "Тариф: {plan}",
	modelDefaultsTitle: "Уровень рассуждения по умолчанию",
	modelDefaultsHint: "Этот уровень выбирается при переключении модели. Для моделей без нескольких уровней действует настройка провайдера.",
	modelDefaultsFollowProvider: "Настройка провайдера",
	modelDefaultsNoLevels: "Моделей без выбора уровня рассуждения: {count}. Для них действует настройка провайдера.",
	modelDefaultsLoading: "Загрузка моделей…",
	modelDefaultsLoadFailed: "Не удалось загрузить модели: {message}",
	modelDefaultsRetry: "Повторить",
	modelDefaultsRefresh: "Обновить модели всех подписок",
	modelDefaultsSaving: "Сохранение…",
	modelDefaultsSaveFailedNamed: "Не удалось сохранить {model}: {message}",
	modelDefaultsSummary: "Моделей: {total} · настроено отдельно: {configured}",
	modelDefaultsSummaryNone: "Моделей: {total} · настройки провайдера",
	modelDefaultsSummaryEmpty: "У моделей нет выбора уровня рассуждения",
	modelDefaultsFilterPlaceholder: "Найти модель",
	modelDefaultsFilterEmpty: "Моделей по запросу «{query}» нет.",
	generating: "Создание изображения…",
	image: "Изображение",
	viewImage: "Открыть изображение",
	viewImageNamed: "Открыть {name}",
	imageLoading: "Загрузка…",
	imageLoadFailed: "Повторить",
	imagePreview: "Предпросмотр изображения",
	imageClose: "Закрыть",
	generatingVideo: "Создание видео…",
	videoLoading: "Загрузка видео…",
	videoLoadFailed: "Не удалось загрузить видео: {message}",
	speed: "Скорость",
	speedStandard: "Обычная",
	speedStandardDescription: "Обычная скорость",
	speedFast: "Быстрая",
	speedFastDescription: "Скорость ×1,5, повышенный расход",
	commandFast: "Переключить скорость Codex (обычная/быстрая)",
	commandFastUnavailable: "Быстрый режим недоступен. Команда /fast работает только с поддерживающими её моделями Codex.",
	proxyTitle: "Прокси",
	proxyStatusNone: "Прокси плагина выключен. Действуют сетевые настройки DSH.",
	proxyStatusEnabled: "Включён · {url}",
	proxyStatusError: "Ошибка настройки: {message}",
	proxyConfigure: "Настроить…",
	proxyDialogTitle: "Настройки прокси",
	proxyDialogClose: "Закрыть",
	proxyEnabled: "Направлять запросы подписок через прокси",
	proxyUrl: "Адрес прокси",
	proxyUrlPlaceholder: "http://localhost:7890",
	proxyUrlHint: "Поддерживается HTTP/HTTPS-прокси (Clash/mihomo, v2rayN…). SOCKS не поддерживается.",
	proxyUsername: "Имя пользователя (необязательно)",
	proxyUsernamePlaceholder: "Имя пользователя прокси",
	proxyPassword: "Пароль",
	proxyPasswordPlaceholder: "Оставьте пустым, чтобы сохранить текущий пароль",
	proxyClearPassword: "Удалить сохранённый пароль",
	proxyBypass: "Адреса в обход прокси",
	proxyBypassPlaceholder: "127.0.0.1, localhost, *.example.com",
	proxyBypassHint: "Адреса через запятую: запросы к ним используют сетевые настройки DSH.",
	proxyTest: "Tests",
	proxyTesting: "Проверка…",
	proxyTestOk: "Готово · HTTP {status} · {ms} мс",
	proxyTestOkDirect: "Готово (сетевые настройки DSH) · HTTP {status} · {ms} мс",
	proxyTestFail: "Ошибка: {message}",
	proxySave: "Сохранить",
	proxyCancel: "Отмена",
	proxySaving: "Сохранение…",
	proxyLoading: "Загрузка настроек прокси…",
	proxyLoadFailed: "Не удалось загрузить настройки прокси: {message}",
	proxySaved: "Сохранено. Новые запросы используют обновлённые сетевые настройки.",
	proxySaveFailed: "Не удалось сохранить: {message}",
	proxyNote: "On DSH v0.1.3-alpha.1, prefer the host HTTP_PROXY / HTTPS_PROXY / ALL_PROXY / NO_PROXY settings and leave this plugin proxy disabled. This optional override is retained for older hosts and subscription-only routing. Disabled or bypassed requests use DSH network settings; they are not necessarily direct. Applies to token exchange, model APIs, usage and tools. Browser OAuth follows the browser/system proxy."
};

//#endregion
//#region src/client/subscriptions-rpc.ts
const SUBSCRIPTIONS_AUTH_CHANNEL$2 = "/airules-subscriptions-auth";
/** Business error returned by the `/subscriptions-auth` channel (error branch message). */
var SubscriptionsAuthError = class extends Error {};
/**
* Call one `/subscriptions-auth` endpoint and unwrap the business result.
* Shared by the settings section and the composer Speed toggle.
* @param rpc - Connection RPC caller.
* @param endpoint - channel-relative endpoint.
* @param payload - channel-owned request payload.
* @returns the success value, cast by the caller to the endpoint's shape.
*/
async function callSubscriptionsAuth(rpc, endpoint, payload) {
	let result;
	try {
		result = await rpc.call(SUBSCRIPTIONS_AUTH_CHANNEL$2, endpoint, payload);
	} catch (error) {
		throw new SubscriptionsAuthError(error instanceof Error ? error.message : String(error));
	}
	if (!result.ok) throw new SubscriptionsAuthError(result.error.message);
	return result.value;
}

//#endregion
//#region src/client/ProviderModelEditor.tsx
const border = "1px solid var(--dsw-alias-border-l2, #ddd)";
const control = {
	font: "inherit",
	color: "inherit",
	background: "transparent",
	border,
	borderRadius: 8,
	padding: "6px 10px",
	minWidth: 0
};
const actions = {
	display: "flex",
	flexWrap: "wrap",
	gap: 8,
	alignItems: "center"
};
/** Local draft: refreshes and failed saves never silently replace unsaved edits. */
function ProviderModelEditor({ provider, rpc, t = fallbackTranslate$3, renderModelDefaults }) {
	const [open, setOpen] = (0, react.useState)(false);
	const [catalog, setCatalog] = (0, react.useState)();
	const [draft, setDraft] = (0, react.useState)({});
	const [contexts, setContexts] = (0, react.useState)({});
	const [efforts, setEfforts] = (0, react.useState)({});
	const [query, setQuery] = (0, react.useState)("");
	const [busy, setBusy] = (0, react.useState)(false);
	const [dirty, setDirty] = (0, react.useState)(false);
	const [error, setError] = (0, react.useState)("");
	const [saved, setSaved] = (0, react.useState)(false);
	const generation = (0, react.useRef)(0);
	(0, react.useEffect)(() => () => {
		generation.current++;
	}, []);
	function reset(data) {
		setCatalog(data);
		setDraft(data.settings);
		setEfforts(Object.fromEntries(data.models.map((model) => [model.id, model.configured ?? ""])));
		setContexts(Object.fromEntries(Object.entries(data.settings.contextWindows ?? {}).map(([id, value]) => [id, String(value)])));
		setDirty(false);
	}
	async function load(force = false) {
		const request = ++generation.current;
		setBusy(true);
		setError("");
		try {
			const data = await callSubscriptionsAuth(rpc, "providerSettings", {
				provider,
				force
			});
			if (generation.current === request) reset(data);
		} catch (error$1) {
			if (generation.current === request) setError(String(error$1 instanceof Error ? error$1.message : error$1));
		} finally {
			if (generation.current === request) setBusy(false);
		}
	}
	function edit(next) {
		setDraft(next);
		setDirty(true);
		setSaved(false);
	}
	async function save() {
		const windows = Object.create(null);
		for (const [model, text] of Object.entries(contexts)) {
			if (!text.trim()) continue;
			const value = Number(text);
			if (!/^\d+$/.test(text.trim()) || !Number.isSafeInteger(value) || value <= 0) {
				setError(t("modelsContextInvalid", { model }));
				return;
			}
			windows[model] = value;
		}
		const settings = {
			...draft,
			...provider === "codex" ? { contextWindows: windows } : {}
		};
		const request = ++generation.current;
		setBusy(true);
		setError("");
		let savedEfforts = 0;
		try {
			for (const model of catalog?.models ?? []) {
				const effort = efforts[model.id] ?? "";
				if (effort === (model.configured ?? "") || !model.efforts?.length) continue;
				await callSubscriptionsAuth(rpc, "setModelDefault", {
					provider,
					model: model.id,
					...effort ? { effort } : {}
				});
				savedEfforts++;
				if (generation.current === request) setCatalog((current) => current && {
					...current,
					models: current.models.map((row) => {
						if (row.id !== model.id) return row;
						const { configured: _previous,...rest } = row;
						return {
							...rest,
							...effort ? { configured: effort } : {}
						};
					})
				});
			}
			const result = await callSubscriptionsAuth(rpc, "setProviderSettings", {
				provider,
				settings
			});
			if (generation.current !== request) return;
			setDraft(settings);
			setCatalog((current) => current && {
				...current,
				settings
			});
			setDirty(false);
			setSaved(true);
			if (typeof document !== "undefined") document.dispatchEvent(new CustomEvent("dsh1c-model-selection-changed", { detail: { cleanup: result?.cleanup } }));
		} catch (error$1) {
			if (generation.current === request) setError((savedEfforts ? t("modelsPartialSave") + " " : "") + String(error$1 instanceof Error ? error$1.message : error$1));
		} finally {
			if (generation.current === request) setBusy(false);
		}
	}
	const allModels = catalog?.models ?? [];
	const known = new Set(allModels.map((model) => model.id));
	const missing = (draft.visibleModels ?? []).filter((id) => !known.has(id)).map((id) => ({
		id,
		name: id
	}));
	const models = [...allModels, ...missing].filter((model) => `${model.name} ${model.id}`.toLowerCase().includes(query.trim().toLowerCase()));
	const selected = new Set(draft.visibleModels ?? allModels.map((model) => model.id));
	// dsh1c-r228: models the catalog gained after a manual selection, and every model of a selection none of whose
	// models is offered any more, are shown in the picker — tick them here as well.
	if (Array.isArray(draft.visibleModels) && draft.visibleModels.length > 0) {
		const stale = !allModels.some((model) => draft.visibleModels.includes(model.id));
		for (const model of allModels) if (stale || Array.isArray(draft.knownModels) && !draft.knownModels.includes(model.id)) selected.add(model.id);
	}
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		style: {
			borderTop: border,
			marginTop: 12,
			paddingTop: 12
		},
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
			type: "button",
			style: {
				...control,
				border: 0,
				padding: 0,
				fontSize: 16,
				cursor: "pointer"
			},
			"aria-expanded": open,
			onClick: () => {
				setOpen(!open);
				if (!open && !busy && !dirty) load();
			},
			children: [
				t("modelsEdit"),
				" ",
				open ? "▴" : "▾"
			]
		}), open && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			style: {
				display: "grid",
				gap: 12,
				marginTop: 12
			},
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					style: { margin: 0 },
					children: t("modelsHint")
				}),
				error && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					role: "alert",
					style: {
						margin: 0,
						color: "var(--dsw-alias-state-error-primary, #b42318)"
					},
					children: error
				}),
				saved && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					role: "status",
					style: { margin: 0 },
					children: t((catalog?.tools.length ?? 0) > 0 ? "modelsSaved" : "modelsSavedNoTools")
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: actions,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						style: control,
						disabled: busy || dirty,
						onClick: () => {
							load(true);
						},
						children: t("usageRefresh")
					}), busy && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						role: "status",
						children: t("modelDefaultsLoading")
					})]
				}),
				...(catalog?.accountCatalogs ?? []).map(account => (0, react_jsx_runtime.jsxs)("section", {
					"aria-label": `Каталог ${account.name}`, style: { border, borderRadius: 10, padding: 12, overflowWrap: "anywhere" },
					children: [(0, react_jsx_runtime.jsx)("strong", { children: `${account.name}${account.isDefault ? " · Основной аккаунт" : ""} · ${account.enabled ? "Используется" : "Не используется"}` }),
						(0, react_jsx_runtime.jsx)("p", { role: ["error", "stale", "auth-error"].includes(account.status) ? "alert" : "status", children: account.message ?? (account.source === "account" ? `Каталог аккаунта: ${account.models.length} моделей.` : "Каталог аккаунта ещё не получен.") }),
						account.at !== void 0 && (0, react_jsx_runtime.jsx)("p", { children: `Последнее успешное получение: ${new Date(account.at).toLocaleString()}` }),
						account.attemptedAt !== void 0 && account.attemptedAt !== account.at && (0, react_jsx_runtime.jsx)("p", { children: `Последняя попытка: ${new Date(account.attemptedAt).toLocaleString()}` }),
						account.source === "account" && (0, react_jsx_runtime.jsxs)("details", { children: [(0, react_jsx_runtime.jsx)("summary", { children: `Модели каталога (${account.models.length})` }), (0, react_jsx_runtime.jsx)("p", { children: account.models.map(model => model.name).join(", ") || "Нет моделей" })] })]
				}, account.account)),
				catalog && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("fieldset", {
					disabled: busy,
					style: {
						border: 0,
						padding: 0,
						margin: 0,
						minWidth: 0,
						display: "grid",
						gap: 12
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								type: "checkbox",
								checked: draft.visibleModels === void 0,
								onChange: (event) => {
									const next = { ...draft };
									if (event.target.checked) delete next.visibleModels;
									else next.visibleModels = allModels.map((model) => model.id);
									edit(next);
								}
							}),
							" ",
							t("modelsAutomatic")
						] }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: actions,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									style: {
										...control,
										flex: "1 1 180px"
									},
									value: query,
									onChange: (event) => setQuery(event.target.value),
									placeholder: t("modelDefaultsFilterPlaceholder"),
									"aria-label": t("modelDefaultsFilterPlaceholder")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									style: control,
									onClick: () => edit({
										...draft,
										visibleModels: allModels.map((model) => model.id)
									}),
									children: t("modelsSelectAll")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									style: control,
									onClick: () => edit({
										...draft,
										visibleModels: []
									}),
									children: t("modelsSelectNone")
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								maxHeight: 360,
								overflowY: "auto",
								display: "grid",
								gap: 8
							},
							children: [models.map((model) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									borderBottom: border,
									padding: "8px 2px",
									display: "grid",
									gap: 8
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									style: { overflowWrap: "anywhere" },
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											type: "checkbox",
											checked: selected.has(model.id),
											onChange: (event) => {
												const next = new Set(selected);
												if (event.target.checked) next.add(model.id);
												else next.delete(model.id);
												edit({
													...draft,
													visibleModels: [...next]
												});
											}
										}),
										" ",
										model.name,
										!known.has(model.id) && ` (${t("modelsUnavailable")})`
									]
								}), catalog.accountCatalogs && (0, react_jsx_runtime.jsx)("small", {
									children: `Каталоги аккаунтов: ${(catalog.accountCatalogs ?? []).filter(account => account.source === "account" && account.models.some(row => row.id === model.id)).map(account => `${account.name}${account.isDefault ? " (основной)" : ""}${account.enabled ? "" : " (выключен)"}${account.status === "stale" ? " (прежний каталог)" : ""}`).join(", ") || "не подтверждено; список DSH"}`
								}), renderModelDefaults?.({ model, catalog, settings: draft, onChange: edit, disabled: busy }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: actions,
									children: [(model.efforts?.length ?? 0) > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
										style: actions,
										children: [t("modelDefaultsTitle"), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
											style: control,
											"aria-label": `${model.name} ${t("modelDefaultsTitle")}`,
											value: efforts[model.id] ?? "",
											onChange: (event) => {
												setEfforts({
													...efforts,
													[model.id]: event.target.value
												});
												setDirty(true);
												setSaved(false);
											},
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
													value: "",
													children: t("modelDefaultsFollowProvider")
												}),
												model.configured && !model.efforts?.some((effort) => effort.id === model.configured) && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
													value: model.configured,
													disabled: true,
													children: [
														model.configured,
														" (",
														t("modelsUnavailable"),
														")"
													]
												}),
												model.efforts?.map((effort) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
													value: effort.id,
													children: effort.name
												}, effort.id))
											]
										})]
									}), provider === "codex" && model.maxContextWindow !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: actions,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
											style: actions,
											children: [t("modelsContext"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
												style: {
													...control,
													width: 140
												},
												inputMode: "numeric",
												value: contexts[model.id] ?? "",
												"aria-label": `${model.name} ${t("modelsContext")}`,
												placeholder: String(model.defaultContextWindow),
												onChange: (event) => {
													setContexts({
														...contexts,
														[model.id]: event.target.value
													});
													setDirty(true);
													setSaved(false);
												}
											})]
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", { children: t("modelsContextBounds", {
											default: model.defaultContextWindow,
											max: model.maxContextWindow
										}) })]
									})]
								})]
							}, model.id)), models.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("modelDefaultsFilterEmpty", { query }) })]
						}),
						provider === "codex" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", { children: t("modelsContextHint") }),
						catalog.tools.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "grid",
								gap: 8
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: t("modelsTools") }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", { children: t("modelsToolsHint") }),
								catalog.tools.map((tool) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "checkbox",
										checked: draft.tools?.[tool] !== false,
										onChange: (event) => edit({
											...draft,
											tools: {
												...draft.tools,
												[tool]: event.target.checked
											}
										})
									}),
									" ",
									t(tool === "image_generate" ? "modelsImage" : tool === "video_generate" ? "modelsVideo" : "modelsSearch")
								] }, tool))
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: actions,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: control,
								disabled: !dirty,
								onClick: () => {
									save();
								},
								children: t("modelsSave")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: control,
								disabled: !dirty,
								onClick: () => {
									reset(catalog);
									setError("");
									setSaved(false);
								},
								children: t("cancel")
							}), !dirty && Array.isArray(draft.visibleModels) && allModels.some(model => !draft.visibleModels.includes(model.id)) && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button", style: control, disabled: busy, onClick: () => save(),
								title: "Очистить выбор отключённых моделей во всех сохранённых чатах, настройке новых чатов, ролях и резервных цепочках; затем выбрать замену.",
								children: "Очистить выбор отключённых моделей"
							})]
						})
					]
				})
			]
		})]
	});
}

//#endregion
//#region src/client/SubscriptionsSection.tsx
/** Poll cadence while a provider login attempt is busy. */
const POLL_INTERVAL_MS$2 = 2e3;
/** Card display metadata, in page order (names are brand names, not translated). */
const PROVIDERS = [
	{
		id: "codex",
		name: "OpenAI (OAuth)"
	},
	{
		id: "claude",
		name: "Claude (OAuth)"
	},
	{
		id: "grok",
		name: "Grok (X Premium)"
	},
	{
		id: "copilot",
		name: "GitHub Copilot"
	}
];
/** Human text of an action failure, SubscriptionsAuthError or not. */
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}
/** Copy a keyed map without the entries whose key is not in `live`. */
function dropStale(map, live) {
	const stale = Object.keys(map).filter((key) => !live.has(key));
	if (stale.length === 0) return map;
	const next = { ...map };
	for (const key of stale) delete next[key];
	return next;
}
/**
* English-dictionary fallback for a missing inject `t` (standalone renders);
* the slot inject always supplies the locale-bound one.
* @param key - dictionary key.
* @param params - `{name}` template params.
* @returns the template with params substituted.
*/
function fallbackTranslate$3(key, params) {
	let text = en[key];
	for (const [name, value] of Object.entries(params ?? {})) text = text.replaceAll(`{${name}}`, String(value));
	return text;
}
const styles$5 = {
	section: {
		display: "flex",
		flexDirection: "column",
		gap: 12,
		maxWidth: 560,
		color: "var(--dsw-alias-label-primary)"
	},
	intro: {
		margin: 0,
		color: "var(--dsw-alias-label-tertiary)",
		fontSize: 14,
		lineHeight: "22px"
	},
	card: {
		border: "1px solid var(--dsw-alias-border-l2)",
		borderRadius: 12,
		padding: "12px 14px",
		display: "flex",
		flexDirection: "column",
		gap: 6
	},
	proxyCard: {
		padding: "12px 14px",
		display: "flex",
		flexDirection: "column",
		gap: 6
	},
	separator: { borderTop: "1px solid var(--dsw-alias-border-l2)" },
	cardHeader: {
		display: "flex",
		alignItems: "center",
		gap: 8
	},
	dot: {
		width: 8,
		height: 8,
		borderRadius: "50%",
		flexShrink: 0
	},
	name: {
		fontWeight: 500,
		fontSize: 14,
		lineHeight: "22px",
		color: "var(--dsw-alias-label-primary)"
	},
	statusLine: {
		margin: 0,
		fontSize: 12,
		lineHeight: "18px",
		color: "var(--dsw-alias-label-tertiary)"
	},
	errorLine: {
		margin: 0,
		fontSize: 12,
		lineHeight: "18px",
		color: "var(--dsw-alias-state-error-primary)"
	},
	actions: {
		display: "flex",
		gap: 8,
		marginTop: 4,
		alignItems: "center",
		flexWrap: "wrap"
	},
	button: {
		boxSizing: "border-box",
		display: "inline-flex",
		alignItems: "center",
		justifyContent: "center",
		height: 28,
		padding: "0 10px",
		borderRadius: 14,
		border: "1px solid var(--dsw-alias-border-l2)",
		background: "transparent",
		color: "var(--dsw-alias-label-primary)",
		font: "inherit",
		fontSize: 12,
		lineHeight: "18px",
		cursor: "pointer"
	},
	usage: {
		display: "flex",
		flexDirection: "column",
		gap: 6,
		marginTop: 4,
		borderTop: "1px solid var(--dsw-alias-border-l2)",
		paddingTop: 8
	},
	usageHeader: {
		display: "flex",
		alignItems: "center",
		gap: 8
	},
	usageTitle: {
		fontSize: 12,
		lineHeight: "18px",
		fontWeight: 500,
		color: "var(--dsw-alias-label-secondary)"
	},
	usagePlan: {
		fontSize: 12,
		lineHeight: "18px",
		color: "var(--dsw-alias-label-tertiary)"
	},
	usageRefresh: {
		boxSizing: "border-box",
		display: "inline-flex",
		alignItems: "center",
		justifyContent: "center",
		height: 22,
		padding: "0 8px",
		borderRadius: 11,
		marginLeft: "auto",
		border: "1px solid var(--dsw-alias-border-l2)",
		background: "transparent",
		color: "var(--dsw-alias-label-secondary)",
		font: "inherit",
		fontSize: 12,
		lineHeight: "18px",
		cursor: "pointer"
	},
	usageRow: {
		display: "flex",
		flexDirection: "column",
		gap: 3
	},
	usageMeta: {
		display: "flex",
		justifyContent: "space-between",
		gap: 8,
		fontSize: 12,
		lineHeight: "18px",
		color: "var(--dsw-alias-label-tertiary)"
	},
	accountRow: {
		display: "flex",
		flexDirection: "column",
		gap: 6,
		border: "1px solid var(--dsw-alias-border-l2)",
		borderRadius: 8,
		padding: "8px 10px",
		marginTop: 4
	},
	accountHeader: {
		display: "flex",
		alignItems: "center",
		gap: 8
	},
	accountName: {
		fontSize: 13,
		lineHeight: "20px",
		color: "var(--dsw-alias-label-primary)",
		userSelect: "all"
	},
	starButton: {
		border: "none",
		background: "transparent",
		padding: 0,
		font: "inherit",
		fontSize: 14,
		lineHeight: "20px",
		cursor: "pointer",
		color: "var(--dsw-alias-state-warn-label)"
	},
	usageTrack: {
		height: 6,
		borderRadius: 3,
		overflow: "hidden",
		background: "var(--dsw-alias-bg-layer-1)",
		border: "1px solid var(--dsw-alias-border-l2)"
	},
	usageFill: {
		height: "100%",
		borderRadius: 3
	},
	deviceCode: {
		marginTop: 4,
		display: "flex",
		flexDirection: "column",
		gap: 6,
		border: "1px solid var(--dsw-alias-border-l2)",
		borderRadius: 8,
		padding: "10px 12px",
		background: "var(--dsw-alias-bg-layer-1)"
	},
	deviceCodeText: {
		fontFamily: "monospace",
		fontSize: 18,
		lineHeight: "24px",
		letterSpacing: 2,
		color: "var(--dsw-alias-label-primary)",
		userSelect: "all"
	},
	proxyField: {
		display: "flex",
		flexDirection: "column",
		gap: 4
	},
	proxyLabel: {
		fontSize: 12,
		lineHeight: "18px",
		color: "var(--dsw-alias-label-secondary)"
	},
	proxyInput: {
		height: 32,
		width: "100%",
		boxSizing: "border-box",
		border: "1px solid var(--dsw-alias-border-l2)",
		borderRadius: 8,
		padding: "0 10px",
		font: "inherit",
		fontSize: 14,
		lineHeight: "22px",
		background: "var(--dsw-alias-bg-layer-1)",
		color: "var(--dsw-alias-label-primary)"
	},
	proxyHint: {
		margin: 0,
		fontSize: 12,
		lineHeight: "18px",
		color: "var(--dsw-alias-label-tertiary)"
	},
	proxyCheck: {
		display: "flex",
		alignItems: "center",
		gap: 8,
		fontSize: 13,
		lineHeight: "20px",
		color: "var(--dsw-alias-label-primary)",
		cursor: "pointer"
	},
	proxyMessage: {
		margin: 0,
		fontSize: 12,
		lineHeight: "18px"
	},
	proxyActions: {
		display: "flex",
		gap: 8,
		alignItems: "center",
		justifyContent: "flex-end",
		marginTop: 2
	},
	modalOverlay: {
		position: "fixed",
		inset: 0,
		zIndex: 1e3,
		display: "flex",
		alignItems: "center",
		justifyContent: "center",
		padding: 16,
		background: "rgba(0, 0, 0, 0.45)"
	},
	modal: {
		width: 460,
		maxWidth: "100%",
		maxHeight: "90vh",
		overflowY: "auto",
		boxSizing: "border-box",
		display: "flex",
		flexDirection: "column",
		gap: 12,
		padding: "16px 18px",
		borderRadius: 12,
		background: "var(--dsw-alias-bg-layer-1)",
		border: "1px solid var(--dsw-alias-border-l2)"
	},
	modalHeader: {
		display: "flex",
		alignItems: "center",
		gap: 8
	},
	modalTitle: {
		fontWeight: 600,
		fontSize: 15,
		lineHeight: "22px",
		color: "var(--dsw-alias-label-primary)"
	}
};
/** Status dot color for one provider state. */
function dotColor(status) {
	if (status?.busy === true) return "var(--dsw-alias-state-warn-label)";
	if ((status?.accounts.length ?? 0) > 0) return "var(--dsw-alias-state-success-primary)";
	return "var(--dsw-alias-label-dimmed)";
}
/**
* One-line status text for one provider state.
* @param t - section translate.
* @param status - the provider's last reported state.
* @returns the localized status line.
*/
function statusText(t, status) {
	if (status === void 0) return t("checking");
	if (status.busy) return t("loginInProgress");
	if (status.accounts.length > 0) return t("loggedInCount", { count: status.accounts.length });
	return t("notLoggedIn");
}
/**
* Localized label of one usage window (kind, plus the model scope when named).
* @param t - section translate.
* @param window - the reported window.
* @returns e.g. "За 5 часов" or "Weekly · Opus".
*/
function usageWindowLabel(t, window$1) {
	const base = window$1.kind === "session" ? t("usageSession") : window$1.kind === "weekly" ? t("usageWeekly") : t("usageWindow");
	return window$1.scope !== void 0 && window$1.scope !== "" ? `${base} · ${window$1.scope}` : base;
}
/** Bar fill color: success normally, warn from 80%, error from 95%. */
function usageBarColor(usedPercent) {
	if (usedPercent >= 95) return "var(--dsw-alias-state-error-primary)";
	if (usedPercent >= 80) return "var(--dsw-alias-state-warn-label)";
	return "var(--dsw-alias-state-success-primary)";
}
function validUsagePercent(value) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}
function usageDate(value) {
	return new Date(value).toLocaleString("ru-RU", { timeZoneName: "short" });
}
/** One-line status text of the proxy config card. */
function proxyStatusText(t, proxy, loadError) {
	if (loadError !== void 0) return t("proxyLoadFailed", { message: loadError });
	if (proxy === void 0) return t("proxyLoading");
	if (proxy.error !== void 0) return t("proxyStatusError", { message: proxy.error });
	if (proxy.enabled) return t("proxyStatusEnabled", { url: proxy.url });
	return t("proxyStatusNone");
}
/** Feedback-line color of the proxy dialog. */
function messageColor(tone) {
	return tone === "error" ? "var(--dsw-alias-state-error-primary)" : "var(--dsw-alias-state-success-primary)";
}
/**
* The Subscriptions settings page component.
* @param props - the slot inject face ({@link SubscriptionsSectionInjected}).
* @returns the section body, or a notice while the RPC face is absent.
*/
// dsh1c: selected subscription login card
let dsh1cSubscriptionProvider = "";
// dsh1c-r113: subscriptions are a part of the single Models settings page.
function SubscriptionOverview(props) {
	// dsh1c-r114: provider is owned by the shared Models page, no second selector.
	const selected = props.providerId || "";
	if (!selected) return null;
	return (0, react_jsx_runtime.jsxs)("section", { "aria-label": "Подключение провайдера", children: [
		(0, react_jsx_runtime.jsx)("h3", { children: "Подключение" }),
		selected === "cursor" ? (0, react_jsx_runtime.jsxs)("div", { style: styles$5.section, role: "status", children: [
			(0, react_jsx_runtime.jsx)("p", { style: styles$5.intro, children: "Подключается действующая подписка Cursor. Нажмите «+ Добавить по OAuth», чтобы войти в аккаунт через браузер, или «+ Добавить по API», чтобы подключить аккаунт по ключу API. После подключения откройте «Настроить список моделей», нажмите «Обновить» и выберите модель для чата DSH." }),
			(0, react_jsx_runtime.jsx)("div", { style: styles$5.separator })
		] }) : (0, react_jsx_runtime.jsx)(SubscriptionsSection, { ...props, embedded: true, key: selected })
	] });
}
		function SubscriptionsSection(props) {
	const [selectedProvider, setSelectedProvider] = (0, react.useState)(() => props.providerId || dsh1cSubscriptionProvider);
	const [authorizeLinks, setAuthorizeLinks] = (0, react.useState)({});
	(0, react.useEffect)(() => {
		const select = () => setSelectedProvider(dsh1cSubscriptionProvider);
		document.addEventListener("dsh1c-subscription-provider", select);
		return () => document.removeEventListener("dsh1c-subscription-provider", select);
	}, []);
	const { rpc } = props;
	const t = props.t ?? fallbackTranslate$3;
	const [statuses, setStatuses] = (0, react.useState)({});
	const [enabledBusy, setEnabledBusy] = (0, react.useState)("");
	const [errors, setErrors] = (0, react.useState)({});
	const [manualDrafts, setManualDrafts] = (0, react.useState)({
		codex: "",
		claude: "",
		grok: "",
		copilot: ""
	});
	/** Pending device-flow codes (copilot), shown while the attempt polls. */
	const [deviceCodes, setDeviceCodes] = (0, react.useState)({});
	const [copiedCode, setCopiedCode] = (0, react.useState)(void 0);
	/** Usage snapshots keyed `${provider}:${accountKey}` — every account tracks its own windows. */
	const [usages, setUsages] = (0, react.useState)({});
	const [usageErrors, setUsageErrors] = (0, react.useState)({});
	const [usageLoading, setUsageLoading] = (0, react.useState)({});
	const mountedRef = (0, react.useRef)(true);
	const pollersRef = (0, react.useRef)(/* @__PURE__ */ new Map());
	/** Accounts with a `usage` call in flight; guards the auto-fetch effect against re-entry. */
	const usageInflightRef = (0, react.useRef)(/* @__PURE__ */ new Set());
	/** Proxy config as last answered by `proxyGet`/`proxySet`. */
	const [proxy, setProxy] = (0, react.useState)(void 0);
	const [proxyLoadError, setProxyLoadError] = (0, react.useState)(void 0);
	/** Proxy dialog state (draft fields; the password never pre-fills). */
	const [proxyOpen, setProxyOpen] = (0, react.useState)(false);
	const [proxyEnabled, setProxyEnabled] = (0, react.useState)(false);
	const [proxyUrl, setProxyUrl] = (0, react.useState)("");
	const [proxyUsername, setProxyUsername] = (0, react.useState)("");
	const [proxyPassword, setProxyPassword] = (0, react.useState)("");
	const [proxyClearPassword, setProxyClearPassword] = (0, react.useState)(false);
	const [proxyBypass, setProxyBypass] = (0, react.useState)("");
	const [proxySaving, setProxySaving] = (0, react.useState)(false);
	const [proxyTesting, setProxyTesting] = (0, react.useState)(false);
	const [proxyMessage, setProxyMessage] = (0, react.useState)(void 0);
	const [proxyTestResult, setProxyTestResult] = (0, react.useState)(void 0);
	const setProviderError = (0, react.useCallback)((provider, message) => {
		if (!mountedRef.current) return;
		setErrors((prev) => {
			const next = { ...prev };
			if (message === void 0) delete next[provider];
			else next[provider] = message;
			return next;
		});
	}, []);
	const stopPolling = (0, react.useCallback)((provider) => {
		const poller = pollersRef.current.get(provider);
		if (poller !== void 0) {
			clearInterval(poller);
			pollersRef.current.delete(provider);
		}
	}, []);
	/** Refetch every provider's status; stop a provider's poller once its attempt settles. */
	const refresh = (0, react.useCallback)(async () => {
		if (rpc === void 0) return;
		let response;
		try {
			response = await callSubscriptionsAuth(rpc, "status", {});
		} catch {
			return;
		}
		if (!mountedRef.current) return;
		setStatuses(response.providers);
		for (const { id } of PROVIDERS) {
			const status = response.providers[id];
			if (!status.busy) {
				const finished = pollersRef.current.has(id);
				stopPolling(id);
				if (finished) document.dispatchEvent(new CustomEvent("dsh1c-model-selection-changed"));
				if (finished && status.lastLogin?.account) {
					const key = `${id}:${status.lastLogin.account}`;
					setUsages(previous => { const next = { ...previous }; delete next[key]; return next; });
					setUsageErrors(previous => { const next = { ...previous }; delete next[key]; return next; });
				}
				setDeviceCodes((prev) => {
					if (prev[id] === void 0) return prev;
					const next = { ...prev };
					delete next[id];
					return next;
				});
			}
		}
	}, [rpc, stopPolling]);
	const startPolling = (0, react.useCallback)((provider) => {
		if (pollersRef.current.has(provider)) return;
		pollersRef.current.set(provider, setInterval(() => {
			refresh();
		}, POLL_INTERVAL_MS$2));
	}, [refresh]);
	(0, react.useEffect)(() => {
		mountedRef.current = true;
		refresh().then(() => {
			if (!mountedRef.current) return;
			setStatuses((current) => {
				for (const { id } of PROVIDERS) if (current[id]?.busy === true) startPolling(id);
				return current;
			});
		});
		return () => {
			mountedRef.current = false;
			for (const poller of pollersRef.current.values()) clearInterval(poller);
			pollersRef.current.clear();
		};
	}, [refresh, startPolling]);
	const loadUsage = (0, react.useCallback)(async (provider, account, force = false) => {
		const key = `${provider}:${account}`;
		if (rpc === void 0 || usageInflightRef.current.has(key)) return;
		usageInflightRef.current.add(key);
		setUsageLoading((prev) => ({
			...prev,
			[key]: true
		}));
		try {
			const usage = await callSubscriptionsAuth(rpc, "usage", {
				provider,
				account,
				...force ? { force: true } : {}
			});
			if (!mountedRef.current) return;
			setUsages((prev) => ({
				...prev,
				[key]: usage
			}));
			setUsageErrors((prev) => {
				const next = { ...prev };
				delete next[key];
				return next;
			});
		} catch (error) {
			if (mountedRef.current) setUsageErrors((prev) => ({
				...prev,
				[key]: messageOf(error)
			}));
		} finally {
			usageInflightRef.current.delete(key);
			if (mountedRef.current) setUsageLoading((prev) => ({
				...prev,
				[key]: false
			}));
		}
	}, [rpc]);
	(0, react.useEffect)(() => {
		const live = /* @__PURE__ */ new Set();
		for (const { id } of PROVIDERS) for (const account of statuses[id]?.accounts ?? []) {
			const key = `${id}:${account.key}`;
			live.add(key);
			if (account.requiresLogin) continue;
			if (usages[key] === void 0 && usageErrors[key] === void 0) loadUsage(id, account.key);
		}
		setUsages((prev) => dropStale(prev, live));
		setUsageErrors((prev) => dropStale(prev, live));
	}, [
		statuses,
		usages,
		usageErrors,
		loadUsage
	]);
	const login = (0, react.useCallback)(async (provider, method, account) => {
		if (rpc === void 0) return;
		setProviderError(provider, void 0);
		try {
			const response = await callSubscriptionsAuth(rpc, "login", {
				provider,
				...account === void 0 ? {} : { account },
				...method === void 0 ? {} : { method }
			});
			if (typeof response.authorizeUrl === "string" && response.authorizeUrl === "") {
				await refresh();
				return;
			}
			if (typeof response.authorizeUrl !== "string") throw new SubscriptionsAuthError(t("loginMissingUrl"));
			setAuthorizeLinks((prev) => ({ ...prev, [provider]: response.authorizeUrl }));
			if (!mountedRef.current) return;
			setStatuses((prev) => ({
				...prev,
				[provider]: {
					accounts: prev[provider]?.accounts ?? [],
					...prev[provider],
						detail: void 0,
						lastLogin: void 0,
						targetAccount: account,
					busy: true
				}
			}));
			if (typeof response.userCode === "string" && response.userCode.length > 0) setDeviceCodes((prev) => ({
				...prev,
				[provider]: {
					userCode: response.userCode,
					verificationUrl: response.authorizeUrl
				}
			}));
			else window.open(response.authorizeUrl, "_blank", "noopener");
			startPolling(provider);
		} catch (error) {
			setProviderError(provider, messageOf(error));
		}
	}, [
		rpc,
		t,
		setProviderError,
		startPolling
	]);
	const cancel = (0, react.useCallback)(async (provider) => {
		if (rpc === void 0) return;
		stopPolling(provider);
		try {
			await callSubscriptionsAuth(rpc, "cancel", { provider });
			if (mountedRef.current) {
				setManualDrafts(prev => ({ ...prev, [provider]: "" }));
				setAuthorizeLinks(prev => ({ ...prev, [provider]: "" }));
			}
		} catch (error) {
			setProviderError(provider, messageOf(error));
		}
		await refresh();
	}, [
		rpc,
		stopPolling,
		setProviderError,
		refresh
	]);
	const submitManual = (0, react.useCallback)(async (provider) => {
		if (rpc === void 0) return;
		const input = manualDrafts[provider].trim();
		if (input === "") return;
		setProviderError(provider, void 0);
		try {
			await callSubscriptionsAuth(rpc, "manual", {
				provider,
				input
			});
			if (mountedRef.current) setManualDrafts((prev) => ({
				...prev,
				[provider]: ""
			}));
		} catch (error) {
			setProviderError(provider, messageOf(error));
		}
		await refresh();
	}, [
		rpc,
		manualDrafts,
		setProviderError,
		refresh
	]);
	const logout = (0, react.useCallback)(async (provider, account, display, name) => {
		if (rpc === void 0) return;
		if (!window.confirm(t("logoutAccountConfirm", {
			provider: name,
			account: display
		}))) return;
		setProviderError(provider, void 0);
		try {
			await callSubscriptionsAuth(rpc, "logout", {
				provider,
				account
			});
		} catch (error) {
			setProviderError(provider, messageOf(error));
		}
		await refresh();
	}, [
		rpc,
		t,
		setProviderError,
		refresh
	]);
	const setDefault = (0, react.useCallback)(async (provider, account) => {
		if (rpc === void 0) return;
		setProviderError(provider, void 0);
		try {
			await callSubscriptionsAuth(rpc, "setDefault", {
				provider,
				account
			});
		} catch (error) {
			setProviderError(provider, messageOf(error));
		}
		await refresh();
	}, [
		rpc,
		setProviderError,
		refresh
	]);
	const setEnabled = async (provider, account, enabled) => {
		if (!rpc || enabledBusy) return;
		setEnabledBusy(account);
		setProviderError(provider, void 0);
		try {
			await callSubscriptionsAuth(rpc, "setEnabled", { provider, account, enabled });
			await refresh();
			document.dispatchEvent(new CustomEvent("dsh1c-model-selection-changed"));
		} catch (error) { setProviderError(provider, messageOf(error)); }
		finally { if (mountedRef.current) setEnabledBusy(""); }
	};
	const copyDeviceCode = (0, react.useCallback)((provider, userCode) => {
		navigator.clipboard?.writeText(userCode).then(() => {
			if (!mountedRef.current) return;
			setCopiedCode(provider);
			setTimeout(() => {
				if (mountedRef.current) setCopiedCode((current) => current === provider ? void 0 : current);
			}, 1500);
		}).catch(() => void 0);
	}, []);
	(0, react.useEffect)(() => {
		if (rpc === void 0) return;
		let alive = true;
		callSubscriptionsAuth(rpc, "proxyGet", {}).then((view) => {
			if (!alive) return;
			setProxy(view);
			setProxyLoadError(void 0);
		}).catch((error) => {
			if (alive) setProxyLoadError(messageOf(error));
		});
		return () => {
			alive = false;
		};
	}, [rpc]);
	(0, react.useEffect)(() => {
		if (!proxyOpen) return;
		const onKey = (event) => {
			if (event.key === "Escape") setProxyOpen(false);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [proxyOpen]);
	const openProxyDialog = (0, react.useCallback)(() => {
		if (proxy === void 0) return;
		setProxyEnabled(proxy.enabled);
		setProxyUrl(proxy.url);
		setProxyUsername(proxy.username ?? "");
		setProxyPassword("");
		setProxyClearPassword(false);
		setProxyBypass(proxy.bypass.join(", "));
		setProxyMessage(void 0);
		setProxyTestResult(void 0);
		setProxyOpen(true);
	}, [proxy]);
	const saveProxy = (0, react.useCallback)(async () => {
		if (rpc === void 0) return;
		setProxySaving(true);
		setProxyMessage(void 0);
		try {
			setProxy(await callSubscriptionsAuth(rpc, "proxySet", {
				enabled: proxyEnabled,
				url: proxyUrl.trim(),
				username: proxyUsername,
				...proxyClearPassword ? { password: null } : proxyPassword !== "" ? { password: proxyPassword } : {},
				bypass: proxyBypass.split(/[,\n]/).map((entry) => entry.trim()).filter((entry) => entry !== "")
			}));
			setProxyLoadError(void 0);
			setProxyMessage({
				tone: "success",
				text: t("proxySaved")
			});
			setProxyOpen(false);
		} catch (error) {
			setProxyMessage({
				tone: "error",
				text: t("proxySaveFailed", { message: messageOf(error) })
			});
		} finally {
			setProxySaving(false);
		}
	}, [
		rpc,
		proxyEnabled,
		proxyUrl,
		proxyUsername,
		proxyPassword,
		proxyClearPassword,
		proxyBypass,
		t
	]);
	const testProxy = (0, react.useCallback)(async () => {
		if (rpc === void 0 || proxyTesting) return;
		setProxyTesting(true);
		setProxyTestResult(void 0);
		try {
			setProxyTestResult(await callSubscriptionsAuth(rpc, "proxyTest", { proxy: {
				url: proxyUrl.trim(),
				...proxyUsername.trim() !== "" ? { username: proxyUsername.trim() } : {},
				...proxyPassword !== "" ? { password: proxyPassword } : {}
			} }));
		} catch (error) {
			setProxyTestResult({
				ok: false,
				viaProxy: false,
				error: messageOf(error)
			});
		} finally {
			setProxyTesting(false);
		}
	}, [
		rpc,
		proxyTesting,
		proxyUrl,
		proxyUsername,
		proxyPassword
	]);
	if (rpc === void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
		style: styles$5.intro,
		children: t("unavailable")
	});
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		style: styles$5.section,
		children: [
			!props.embedded && selectedProvider && (0, react_jsx_runtime.jsxs)("div", { children: [
				(0, react_jsx_runtime.jsx)("h2", { children: "Подключение " + PROVIDERS.find((row) => row.id === selectedProvider)?.name }),
				(0, react_jsx_runtime.jsx)("p", { children: selectedProvider === "claude" ? "Ограничение текущего подключения Claude" : "Нажмите «Войти» в карточке ниже. После входа обновите провайдеров и выберите модель для чата DSH." }),
				(0, react_jsx_runtime.jsx)("button", { type: "button", style: styles$5.button, onClick: () => { dsh1cSubscriptionProvider = ""; setSelectedProvider(""); }, children: "Все подписки" })
			] }),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				style: styles$5.intro,
				children: selectedProvider === "codex" ? "Подключается действующая подписка ChatGPT / Codex. Нажмите «Войти» и войдите в аккаунт OpenAI в браузере. API-ключ не нужен. После входа обновите модели и выберите модель OpenAI (OAuth) для чата DSH." : selectedProvider === "claude" ? "Claude (OAuth)" : t("intro")
			}),
			!selectedProvider && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: styles$5.proxyCard,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: styles$5.cardHeader,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: {
							...styles$5.dot,
							background: proxy?.enabled === true ? "var(--dsw-alias-state-success-primary)" : "var(--dsw-alias-label-dimmed)"
						} }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: styles$5.name,
							children: t("proxyTitle")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							style: {
								...styles$5.button,
								marginLeft: "auto",
								flexShrink: 0
							},
							onClick: openProxyDialog,
							children: t("proxyConfigure")
						})
					]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					style: styles$5.statusLine,
					children: proxyStatusText(t, proxy, proxyLoadError)
				})]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { style: styles$5.separator }),
			PROVIDERS.filter((row) => !selectedProvider || row.id === selectedProvider).map(({ id, name }) => {
				const status = statuses[id];
				const busy = status?.busy === true;
				const deviceCode = deviceCodes[id];
				const accounts = status?.accounts ?? [];
				return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: id === "codex" ? { ...styles$5.card, border: "none", padding: 0 } : styles$5.card,
					children: [
						(0, react_jsx_runtime.jsxs)(id === "codex" ? "details" : react_jsx_runtime.Fragment, {
							...(id === "codex" ? { id: "dsh1c-codex-accounts", style: { width: "100%", fontSize: 13, lineHeight: "20px" } } : {}),
							children: [
							id === "codex" && (0, react_jsx_runtime.jsx)("summary", { style: { fontSize: 16 }, children: "Аккаунты" }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: id === "codex" ? { ...styles$5.cardHeader, flexWrap: "wrap", marginTop: 12, marginBottom: 12 } : styles$5.cardHeader,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: {
								...styles$5.dot,
								background: dotColor(status)
							} }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: styles$5.name,
								children: name
							}), id === "codex" && (0, react_jsx_runtime.jsx)("p", { style: { ...styles$5.statusLine, marginLeft: 4 }, children: statusText(t, status) })]
						}),
						id !== "codex" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: styles$5.statusLine,
							children: statusText(t, status)
						}),
						status?.detail !== void 0 && status.detail !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: styles$5.statusLine,
							children: status.detail
						}),
						busy && status?.targetAccount && (0, react_jsx_runtime.jsx)("p", { role: "status", children: `Повторный вход: ${accounts.find(account => account.key === status.targetAccount)?.account ?? status.targetAccount}. Другая подписка не заменит эту запись.` }),
						status?.lastLogin && (0, react_jsx_runtime.jsx)("p", { role: "status", children: status.lastLogin.updated
							? `Вход в ${status.lastLogin.name} обновлён. Это уже подключённая подписка; новая запись не добавлена.`
							: `Подписка ${status.lastLogin.name} добавлена. Другие подписки сохранены.` }),
						errors[id] !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: styles$5.errorLine,
							children: errors[id]
						}),
						busy && authorizeLinks[id] && (0, react_jsx_runtime.jsx)("a", { href: authorizeLinks[id], target: "_blank", rel: "noopener noreferrer", children: "Открыть страницу авторизации" }),
						accounts.map((account) => {
							const usageKey = `${id}:${account.key}`;
							const usage = usages[usageKey];
							const usageError = usageErrors[usageKey];
							const display = account.account ?? account.key;
							const showUsage = usage?.supported !== false && (usage !== void 0 || usageError !== void 0 || usageLoading[usageKey] === true);
							return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								"data-subscription-account": true,
								style: styles$5.accountRow,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: id === "codex" ? { ...styles$5.accountHeader, flexWrap: "wrap", gap: "8px 12px" } : styles$5.accountHeader,
									children: [
										id === "codex" && (0, react_jsx_runtime.jsx)("span", { style: { ...styles$5.accountName, overflowWrap: "anywhere" }, children: display }),
										id === "codex" && (0, react_jsx_runtime.jsxs)("label", { style: { display: "flex", gap: 8, alignItems: "center" }, children: [
											(0, react_jsx_runtime.jsx)("input", { type: "checkbox", "aria-label": `Использовать подписку Codex ${display} (${account.key})`, checked: account.enabled !== false,
											disabled: busy || Boolean(enabledBusy), onChange: event => setEnabled(id, account.key, event.target.checked) }), "Использовать подписку"
										] }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											style: styles$5.starButton,
											title: account.isDefault ? t("defaultBadge") : t("setDefault"),
											onClick: () => {
												if (!account.isDefault) setDefault(id, account.key);
											},
											children: account.isDefault ? id === "codex" ? "★ Основной" : "★" : "☆"
										}),
										id !== "codex" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											style: styles$5.accountName,
											children: display
										}),
										id !== "codex" && account.plan !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											style: styles$5.usagePlan,
											children: account.plan
										}),
										account.expiresAt !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											style: styles$5.statusLine,
											children: t("accountExpires", { date: new Date(account.expiresAt).toLocaleString() })
										}),
										id === "codex" && (0, react_jsx_runtime.jsx)("button", {
											type: "button", style: styles$5.button, disabled: busy,
											"aria-label": `Войти заново Codex ${display} (${account.key})`,
											onClick: () => login(id, void 0, account.key), children: "Войти заново"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											style: {
												...styles$5.button,
												marginLeft: "auto",
												flexShrink: 0
											},
											onClick: () => {
												logout(id, account.key, display, name);
											},
											children: t("logout")
										})
									]
								}), id === "codex" && account.requiresLogin && (0, react_jsx_runtime.jsx)("p", { role: "status", style: styles$5.errorLine, children: "Требуется повторный вход. Нажмите «Войти заново» в этой карточке." }), showUsage && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: styles$5.usage,
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											style: styles$5.usageHeader,
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													style: styles$5.usageTitle,
													children: t("usageTitle")
												}),
												usage?.plan !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													style: styles$5.usagePlan,
													children: t("usagePlan", { plan: usage.plan })
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
													type: "button",
													style: {
														...styles$5.usageRefresh,
														...usageLoading[usageKey] === true ? {
															opacity: .5,
															cursor: "default"
														} : {}
													},
													disabled: usageLoading[usageKey] === true,
													onClick: () => {
														loadUsage(id, account.key, true);
													},
													children: t("usageRefresh")
												})
											]
										}),
										usage === void 0 && usageError === void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											style: styles$5.statusLine,
											children: t("usageLoading")
										}),
										usageError !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											style: styles$5.errorLine,
											children: t("usageError", { message: usageError })
										}),
										usage?.observedAt !== void 0 && (0, react_jsx_runtime.jsx)("p", { style: styles$5.statusLine, children: `Данные получены: ${usageDate(usage.observedAt)}` }),
                                        usage?.stale === true && (0, react_jsx_runtime.jsx)("p", { role: "status", style: styles$5.errorLine, children: usage.refreshError }),
                                        usage !== void 0 && (usage.displayWindows ?? usage.windows ?? []).length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											style: styles$5.statusLine,
											children: t("usageEmpty")
										}),
										(usage?.displayWindows ?? usage?.windows ?? []).map((window$1, index) => {
											const percent = validUsagePercent(window$1.usedPercent) ? window$1.usedPercent : null;
											return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												style: styles$5.usageRow,
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
													style: styles$5.usageMeta,
													children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: usageWindowLabel(t, window$1) }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [percent === null ? "Использование: нет данных" : `Использовано ${Math.round(percent)}%`, window$1.resetsAt !== void 0 ? ` · ${t("usageResets", { date: usageDate(window$1.resetsAt) })}` : " · дата сброса неизвестна"] })]
												}), percent !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
													style: styles$5.usageTrack,
													children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { style: {
														...styles$5.usageFill,
														width: `${String(percent)}%`,
														background: usageBarColor(percent)
													} })
												})]
											}, index);
										})
									]
								})]
							}, account.key);
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: styles$5.actions,
							children: [
								!busy && accounts.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									style: styles$5.button,
									onClick: () => {
										login(id);
									},
									children: t("login")
								}),
								!busy && accounts.length > 0 && id === "claude" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									style: styles$5.button,
									onClick: () => {
										login(id, "oauth");
									},
									children: t("addAccountOAuth")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									style: styles$5.button,
									onClick: () => {
										login(id, "keychain");
									},
									children: t("addAccountKeychain")
								})] }),
								!busy && accounts.length > 0 && id !== "claude" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									style: styles$5.button,
									onClick: () => {
										login(id);
									},
									children: t("addAccount")
								}),
								busy && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									style: styles$5.button,
									onClick: () => {
										cancel(id);
									},
									children: t("cancel")
								})
							]
						}),
						!busy && accounts.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: styles$5.statusLine,
							children: t("addAccountHint")
						}),
						] }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ProviderModelEditor, {
							provider: id,
							rpc,
							t
						}),
						busy && deviceCode !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: styles$5.deviceCode,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: styles$5.statusLine,
									children: t("deviceCodePrompt")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: styles$5.deviceCodeText,
									children: deviceCode.userCode
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: styles$5.actions,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										style: styles$5.button,
										onClick: () => {
											copyDeviceCode(id, deviceCode.userCode);
										},
										children: copiedCode === id ? t("deviceCodeCopied") : t("deviceCodeCopy")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										style: styles$5.button,
										onClick: () => {
											window.open(deviceCode.verificationUrl, "_blank", "noopener");
										},
										children: t("deviceCodeOpenPage")
									})]
								})
							]
						}),
						busy && deviceCode === void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("details", {
							style: styles$5.manual,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("summary", { children: t("manualSummary") }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: styles$5.manualRow,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									style: styles$5.manualInput,
									value: manualDrafts[id],
									placeholder: t("manualPlaceholder"),
									onChange: (event) => setManualDrafts((prev) => ({
										...prev,
										[id]: event.target.value
									}))
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									style: styles$5.button,
									onClick: () => {
										submitManual(id);
									},
									children: t("submit")
								})]
							})]
						})
					]
				}, id);
			}),
			proxyOpen && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: styles$5.modalOverlay,
				onClick: () => setProxyOpen(false),
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: styles$5.modal,
					onClick: (event) => event.stopPropagation(),
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: styles$5.modalHeader,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: styles$5.modalTitle,
								children: t("proxyDialogTitle")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: {
									...styles$5.button,
									marginLeft: "auto"
								},
								onClick: () => setProxyOpen(false),
								children: t("proxyDialogClose")
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							style: styles$5.proxyCheck,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								type: "checkbox",
								checked: proxyEnabled,
								onChange: (event) => setProxyEnabled(event.target.checked)
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("proxyEnabled") })]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							style: styles$5.proxyField,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: styles$5.proxyLabel,
									children: t("proxyUrl")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									style: styles$5.proxyInput,
									value: proxyUrl,
									placeholder: t("proxyUrlPlaceholder"),
									onChange: (event) => setProxyUrl(event.target.value)
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									style: styles$5.proxyHint,
									children: t("proxyUrlHint")
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							style: styles$5.proxyField,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: styles$5.proxyLabel,
								children: t("proxyUsername")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								style: styles$5.proxyInput,
								value: proxyUsername,
								placeholder: t("proxyUsernamePlaceholder"),
								onChange: (event) => setProxyUsername(event.target.value)
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: styles$5.proxyField,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: styles$5.proxyLabel,
									children: t("proxyPassword")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									type: "password",
									style: styles$5.proxyInput,
									value: proxyPassword,
									placeholder: t("proxyPasswordPlaceholder"),
									onChange: (event) => setProxyPassword(event.target.value)
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									style: styles$5.proxyCheck,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "checkbox",
										checked: proxyClearPassword,
										onChange: (event) => setProxyClearPassword(event.target.checked)
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("proxyClearPassword") })]
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							style: styles$5.proxyField,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: styles$5.proxyLabel,
									children: t("proxyBypass")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									style: styles$5.proxyInput,
									value: proxyBypass,
									placeholder: t("proxyBypassPlaceholder"),
									onChange: (event) => setProxyBypass(event.target.value)
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
									style: styles$5.proxyHint,
									children: t("proxyBypassHint")
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: styles$5.proxyHint,
							children: t("proxyNote")
						}),
						proxyMessage !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: {
								...styles$5.proxyMessage,
								color: messageColor(proxyMessage.tone)
							},
							children: proxyMessage.text
						}),
						proxyTestResult !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: {
								...styles$5.proxyMessage,
								color: proxyTestResult.ok ? "var(--dsw-alias-state-success-primary)" : "var(--dsw-alias-state-error-primary)"
							},
							children: proxyTestResult.ok ? proxyTestResult.viaProxy ? t("proxyTestOk", {
								status: String(proxyTestResult.status),
								ms: String(proxyTestResult.latencyMs)
							}) : t("proxyTestOkDirect", {
								status: String(proxyTestResult.status),
								ms: String(proxyTestResult.latencyMs)
							}) : t("proxyTestFail", { message: proxyTestResult.error ?? "" })
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: styles$5.proxyActions,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									style: {
										...styles$5.button,
										...proxyTesting ? {
											opacity: .5,
											cursor: "default"
										} : {}
									},
									disabled: proxyTesting,
									onClick: () => {
										testProxy();
									},
									children: proxyTesting ? t("proxyTesting") : t("proxyTest")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									style: {
										...styles$5.button,
										...proxySaving ? {
											opacity: .5,
											cursor: "default"
										} : {}
									},
									disabled: proxySaving,
									onClick: () => {
										saveProxy();
									},
									children: proxySaving ? t("proxySaving") : t("proxySave")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									style: styles$5.button,
									onClick: () => setProxyOpen(false),
									children: t("proxyCancel")
								})
							]
						})
					]
				})
			})
		]
	});
}

//#endregion
//#region src/client/ImageGallery.tsx
/** Display box for a lone image (platform rule): long edge 240px with the
* rendered aspect ratio clamped to [0.25, 4] — the overflow is cropped by
* `object-fit: cover` — and never upscaled past the image's natural size. The
* crop anchor keeps the top of very tall images and the left of very wide
* ones, where the informative content usually starts. */
function singleFit(attachment) {
	const natural = attachment.width / attachment.height;
	const ratio = Math.min(4, Math.max(.25, natural));
	const box = ratio >= 1 ? {
		width: 240,
		height: 240 / ratio
	} : {
		width: 240 * ratio,
		height: 240
	};
	const scale = Math.min(1, attachment.width / box.width, attachment.height / box.height);
	return {
		width: Math.max(1, Math.round(box.width * scale)),
		height: Math.max(1, Math.round(box.height * scale)),
		objectPosition: natural < .25 ? "center top" : natural > 4 ? "left center" : "center"
	};
}
const styles$4 = {
	gallery: {
		display: "flex",
		flexWrap: "wrap",
		gap: 8,
		justifyContent: "flex-start"
	},
	frame: {
		display: "grid",
		placeItems: "center",
		overflow: "hidden",
		padding: 0,
		border: "1px solid var(--dsw-alias-border-l2-darkmode-thin)",
		borderRadius: 8,
		background: "var(--dsw-alias-interactive-bg-hover-solid)",
		cursor: "zoom-in"
	},
	tile: {
		width: 64,
		height: 64
	},
	img: {
		width: "100%",
		height: "100%",
		objectFit: "cover",
		display: "block"
	},
	loading: {
		fontSize: 12,
		color: "var(--dsw-alias-label-tertiary)",
		padding: "0 8px"
	},
	error: {
		fontSize: 12,
		color: "var(--dsw-alias-state-error-primary)",
		cursor: "pointer",
		border: "1px solid var(--dsw-alias-border-l2-darkmode-thin)",
		borderRadius: 8,
		background: "transparent",
		padding: "6px 10px"
	},
	overlay: {
		position: "fixed",
		inset: 0,
		zIndex: 1e3,
		display: "grid",
		placeItems: "center",
		background: "rgba(0, 0, 0, 0.72)",
		padding: 24
	},
	overlayImg: {
		maxWidth: "92vw",
		maxHeight: "92vh",
		objectFit: "contain",
		borderRadius: 4
	},
	close: {
		position: "absolute",
		top: 12,
		right: 12,
		width: 32,
		height: 32,
		display: "grid",
		placeItems: "center",
		border: "none",
		borderRadius: "50%",
		cursor: "pointer",
		background: "rgba(255, 255, 255, 0.16)",
		color: "#fff",
		fontSize: 16,
		lineHeight: 1
	}
};
/**
* Full-viewport original-image preview: backdrop or close-control click and
* Escape all dismiss; the image itself is inert so a click on it does not
* fall through to the backdrop dismissal.
*/
function ImageLightbox({ src, alt, labels, onClose }) {
	(0, react.useEffect)(() => {
		const onKey = (event) => {
			if (event.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("keydown", onKey);
		};
	}, [onClose]);
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		role: "dialog",
		"aria-label": labels.dialog,
		style: styles$4.overlay,
		onClick: onClose,
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("img", {
			src,
			alt,
			style: styles$4.overlayImg,
			onClick: (event) => {
				event.stopPropagation();
			}
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
			type: "button",
			"aria-label": labels.close,
			style: styles$4.close,
			onClick: onClose,
			children: "×"
		})]
	});
}
/**
* Compact history renderer with retryable loading and click-to-open original
* preview. A lone image renders at its `singleFit` size; an image among
* several renders as a fixed 64px square tile.
*/
function MessageImage({ attachment, load, variant, labels }) {
	const [src, setSrc] = (0, react.useState)(null);
	const [error, setError] = (0, react.useState)(false);
	const [open, setOpen] = (0, react.useState)(false);
	const [attempt, setAttempt] = (0, react.useState)(0);
	const retry = (0, react.useCallback)(() => {
		setAttempt((a) => a + 1);
	}, []);
	const close = (0, react.useCallback)(() => {
		setOpen(false);
	}, []);
	const fit = (0, react.useMemo)(() => variant === "single" ? singleFit(attachment) : void 0, [attachment, variant]);
	(0, react.useEffect)(() => {
		let live = true;
		setError(false);
		setSrc(null);
		load(attachment).then((url) => {
			if (live) setSrc(url);
		}).catch(() => {
			if (live) setError(true);
		});
		return () => {
			live = false;
		};
	}, [
		attachment,
		load,
		attempt
	]);
	const label = attachment.name ?? labels.image;
	if (error) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
		type: "button",
		style: styles$4.error,
		onClick: retry,
		children: labels.loadFailed
	});
	const box = fit === void 0 ? styles$4.tile : {
		width: fit.width,
		height: fit.height
	};
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
		type: "button",
		style: {
			...styles$4.frame,
			...box
		},
		title: labels.open,
		"aria-label": labels.openNamed(label),
		onClick: () => {
			if (src !== null) setOpen(true);
		},
		children: src === null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
			style: styles$4.loading,
			children: labels.loading
		}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("img", {
			src,
			alt: label,
			style: {
				...styles$4.img,
				objectPosition: fit?.objectPosition
			}
		})
	}), open && src !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ImageLightbox, {
		src,
		alt: label,
		labels: labels.lightbox,
		onClose: close
	})] });
}
/** Wrapping image group: a lone image renders large, several render as 64px
* square tiles (same rule as the platform gallery). */
function ImageGallery({ images, load, labels }) {
	if (images.length === 0) return null;
	const variant = images.length === 1 ? "single" : "tile";
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
		style: styles$4.gallery,
		children: images.map((image, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MessageImage, {
			attachment: image.attachment,
			load,
			variant,
			labels
		}, `${image.attachment.attachmentId}:${index}`))
	});
}

//#endregion
//#region src/client/ImageGenerateToolview.tsx
/** Logical RPC channel served by the node half of this plugin. */
const SUBSCRIPTIONS_AUTH_CHANNEL$1 = "/airules-subscriptions-auth";
/** Title prompt truncation budget (characters). */
const PROMPT_MAX_LENGTH$1 = 60;
/**
* Call one `/subscriptions-auth` endpoint and unwrap the business result.
* @param rpc - Connection RPC caller.
* @param endpoint - channel-relative endpoint.
* @param payload - channel-owned request payload.
* @returns the success value, cast by the caller to the endpoint's shape.
*/
async function callSubscriptionsAuth$1(rpc, endpoint, payload) {
	const result = await rpc.call(SUBSCRIPTIONS_AUTH_CHANNEL$1, endpoint, payload);
	if (!result.ok) throw new Error(result.error.message);
	return result.value;
}
/**
* Build the ImageGallery loader over the `image` endpoint.
* @param rpc - Connection RPC caller.
* @returns loader resolving an attachment ref to a data URL.
*/
function createImageLoader(rpc) {
	return (attachment) => callSubscriptionsAuth$1(rpc, "image", { ...attachment }).then((result) => `data:${result.mediaType};base64,${result.dataBase64}`);
}
/**
* English-dictionary fallback for a missing locale seat (standalone renders);
* the framework always supplies the namespace-bound one.
* @param key - dictionary key.
* @param params - `{name}` template params.
* @returns the template with params substituted.
*/
function fallbackTranslate$2(key, params) {
	let text = en[key];
	for (const [name, value] of Object.entries(params ?? {})) text = text.replaceAll(`{${name}}`, String(value));
	return text;
}
/** Extract the prompt from the call's raw args JSON; falls back to the first string value, then the raw line. */
function derivePrompt$1(argsRaw) {
	let parsed;
	try {
		parsed = JSON.parse(argsRaw);
	} catch {
		parsed = void 0;
	}
	let prompt;
	if (typeof parsed === "object" && parsed !== null) {
		const args = parsed;
		if (typeof args.prompt === "string" && args.prompt !== "") prompt = args.prompt;
		else for (const value of Object.values(args)) if (typeof value === "string" && value !== "") {
			prompt = value;
			break;
		}
	}
	const line = (prompt ?? argsRaw).split("\n", 1)[0] ?? "";
	return line.length > PROMPT_MAX_LENGTH$1 ? `${line.slice(0, PROMPT_MAX_LENGTH$1)}…` : line;
}
/** Flatten a settled result's text blocks (the degraded text-only route and the error line). */
function resultText$1(block) {
	if (!("kind" in block)) return "";
	const parts = [];
	for (const part of block.content) if (part.type === "text") parts.push(part.text);
	if (parts.length === 0 && block.error !== void 0) parts.push(`${block.error.name}: ${block.error.code}`);
	return parts.join("\n");
}
/** Image attachments of a settled result; empty while running or on the text-only route. */
function resultImages(block) {
	if (!("kind" in block)) return [];
	const images = [];
	for (const part of block.content) if (part.type === "image") images.push({ attachment: part.attachment });
	return images;
}
const styles$3 = {
	container: {
		display: "flex",
		flexDirection: "column",
		gap: 6,
		padding: "4px 0"
	},
	row: {
		display: "flex",
		alignItems: "center",
		gap: 6,
		minWidth: 0
	},
	icon: {
		display: "inline-flex",
		flexShrink: 0,
		color: "var(--dsw-alias-label-tertiary)"
	},
	title: {
		fontSize: 13,
		lineHeight: "20px",
		color: "var(--dsw-alias-label-primary)",
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	subtle: {
		margin: 0,
		fontSize: 12,
		lineHeight: "18px",
		color: "var(--dsw-alias-label-tertiary)"
	},
	output: {
		margin: 0,
		fontSize: 12,
		lineHeight: "18px",
		color: "var(--dsw-alias-label-secondary)",
		whiteSpace: "pre-wrap",
		overflowWrap: "anywhere"
	},
	error: {
		margin: 0,
		fontSize: 12,
		lineHeight: "18px",
		color: "var(--dsw-alias-state-error-primary)"
	}
};
/**
* The `image_generate` keyed toolview component.
* @param props - owner share, inject face, and locale seat (spread flat).
* @returns the call row plus, once settled, the gallery / text / error body.
*/
function ImageGenerateToolview(props) {
	const { block, load } = props;
	const t = props.t ?? fallbackTranslate$2;
	if (block === void 0) return null;
	const settled = "kind" in block;
	const argsRaw = (settled ? block.call?.argsRaw : block.argsRaw) ?? "";
	let references = 0;
	try {
		const args = JSON.parse(argsRaw);
		if (Array.isArray(args?.referenceImages)) references = args.referenceImages.length;
	} catch {}
	const title = `image_generate${references > 0 ? ` (${references} ref)` : ""}: ${derivePrompt$1(argsRaw)}`;
	const images = resultImages(block);
	const text = settled ? resultText$1(block) : "";
	const labels = {
		image: t("image"),
		open: t("viewImage"),
		openNamed: (name) => t("viewImageNamed", { name }),
		loading: t("imageLoading"),
		loadFailed: t("imageLoadFailed"),
		lightbox: {
			dialog: t("imagePreview"),
			close: t("imageClose")
		}
	};
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		style: styles$3.container,
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: styles$3.row,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: styles$3.icon,
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.IconSparkleRegular, { size: 14 })
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: styles$3.title,
					children: title
				})]
			}),
			!settled && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				style: styles$3.subtle,
				children: t("generating")
			}),
			settled && block.isError && text !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				style: styles$3.error,
				children: text.split("\n", 1)[0]
			}),
			settled && !block.isError && images.length > 0 && load !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ImageGallery, {
				images,
				load,
				labels
			}),
			settled && !block.isError && images.length === 0 && text !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				style: styles$3.output,
				children: text
			})
		]
	});
}

//#endregion
//#region src/client/VideoGenerateToolview.tsx
/** Logical RPC channel served by the node half of this plugin. */
const SUBSCRIPTIONS_AUTH_CHANNEL = "/airules-subscriptions-auth";
/** Title prompt truncation budget (characters). */
const PROMPT_MAX_LENGTH = 60;
/**
* Build the video loader over the `/subscriptions-auth` `video` endpoint.
* @param rpc - Connection RPC caller.
* @returns loader resolving a bare file name to the decoded bytes.
*/
function createVideoLoader(rpc) {
	return async (name) => {
		const result = await rpc.call(SUBSCRIPTIONS_AUTH_CHANNEL, "video", { name });
		if (!result.ok) throw new Error(result.error.message);
		return result.value;
	};
}
/**
* English-dictionary fallback for a missing locale seat (standalone renders);
* the framework always supplies the namespace-bound one.
*/
function fallbackTranslate$1(key, params) {
	let text = en[key];
	for (const [name, value] of Object.entries(params ?? {})) text = text.replaceAll(`{${name}}`, String(value));
	return text;
}
/** Extract the prompt from the call's raw args JSON; falls back to the first string value, then the raw line. */
function derivePrompt(argsRaw) {
	let parsed;
	try {
		parsed = JSON.parse(argsRaw);
	} catch {
		parsed = void 0;
	}
	let prompt;
	if (typeof parsed === "object" && parsed !== null) {
		const args = parsed;
		if (typeof args.prompt === "string" && args.prompt !== "") prompt = args.prompt;
		else for (const value of Object.values(args)) if (typeof value === "string" && value !== "") {
			prompt = value;
			break;
		}
	}
	const line = (prompt ?? argsRaw).split("\n", 1)[0] ?? "";
	return line.length > PROMPT_MAX_LENGTH ? `${line.slice(0, PROMPT_MAX_LENGTH)}…` : line;
}
/** Flatten a settled result's text blocks (the fallback body and the error line). */
function resultText(block) {
	if (!("kind" in block)) return "";
	const parts = [];
	for (const part of block.content) if (part.type === "text") parts.push(part.text);
	if (parts.length === 0 && block.error !== void 0) parts.push(`${block.error.name}: ${block.error.code}`);
	return parts.join("\n");
}
/**
* The generated video's bare file name: presentation meta first (top-level
* dispatches), then the render text's "Saved video to …" line (nested
* dispatches compute no meta).
*/
function resolveFileName(block) {
	if (!("kind" in block)) return void 0;
	const meta = block.meta;
	if (typeof meta === "object" && meta !== null) {
		const fileName = meta.fileName;
		if (typeof fileName === "string" && fileName.length > 0) return fileName;
	}
	const match = /^Saved video to (.+\.mp4)/m.exec(resultText(block));
	if (match === null) return void 0;
	const path = match[1];
	return path.slice(path.lastIndexOf("/") + 1);
}
/** Decode a base64 payload into bytes (browser-side; no Buffer). */
function base64Bytes(dataBase64) {
	const binary = atob(dataBase64);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return bytes;
}
const styles$2 = {
	container: {
		display: "flex",
		flexDirection: "column",
		gap: 6,
		padding: "4px 0"
	},
	row: {
		display: "flex",
		alignItems: "center",
		gap: 6,
		minWidth: 0
	},
	icon: {
		display: "inline-flex",
		flexShrink: 0,
		color: "var(--dsw-alias-label-tertiary)"
	},
	title: {
		fontSize: 13,
		lineHeight: "20px",
		color: "var(--dsw-alias-label-primary)",
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	},
	subtle: {
		margin: 0,
		fontSize: 12,
		lineHeight: "18px",
		color: "var(--dsw-alias-label-tertiary)"
	},
	output: {
		margin: 0,
		fontSize: 12,
		lineHeight: "18px",
		color: "var(--dsw-alias-label-secondary)",
		whiteSpace: "pre-wrap",
		overflowWrap: "anywhere"
	},
	error: {
		margin: 0,
		fontSize: 12,
		lineHeight: "18px",
		color: "var(--dsw-alias-state-error-primary)"
	},
	video: {
		display: "block",
		maxWidth: 480,
		width: "100%",
		borderRadius: 8,
		backgroundColor: "var(--dsw-alias-fill-tertiary)"
	}
};
/**
* The `video_generate` keyed toolview component.
* @param props - owner share, inject face, and locale seat (spread flat).
* @returns the call row plus, once settled, the player / text / error body.
*/
function VideoGenerateToolview(props) {
	const { block, loadVideo } = props;
	const t = props.t ?? fallbackTranslate$1;
	const settled = block !== void 0 && "kind" in block;
	const isError = settled && block.isError;
	const fileName = block !== void 0 && settled && !isError ? resolveFileName(block) : void 0;
	const [load, setLoad] = (0, react.useState)({ phase: "loading" });
	(0, react.useEffect)(() => {
		if (fileName === void 0 || loadVideo === void 0) return;
		let cancelled = false;
		let objectUrl;
		setLoad({ phase: "loading" });
		loadVideo(fileName).then((video) => {
			if (cancelled) return;
			objectUrl = URL.createObjectURL(new Blob([base64Bytes(video.dataBase64).slice()], { type: video.mediaType }));
			setLoad({
				phase: "ready",
				url: objectUrl
			});
		}, (error) => {
			if (cancelled) return;
			setLoad({
				phase: "failed",
				message: error instanceof Error ? error.message : String(error)
			});
		});
		return () => {
			cancelled = true;
			if (objectUrl !== void 0) URL.revokeObjectURL(objectUrl);
		};
	}, [fileName, loadVideo]);
	if (block === void 0) return null;
	const title = `video_generate: ${derivePrompt((settled ? block.call?.argsRaw : block.argsRaw) ?? "")}`;
	const text = settled ? resultText(block) : "";
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		style: styles$2.container,
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: styles$2.row,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: styles$2.icon,
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.IconSparkleRegular, { size: 14 })
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: styles$2.title,
					children: title
				})]
			}),
			!settled && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				style: styles$2.subtle,
				children: t("generatingVideo")
			}),
			settled && isError && text !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				style: styles$2.error,
				children: text.split("\n", 1)[0]
			}),
			settled && !isError && fileName !== void 0 && load.phase === "loading" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				style: styles$2.subtle,
				children: t("videoLoading")
			}),
			settled && !isError && fileName !== void 0 && load.phase === "failed" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				style: styles$2.error,
				children: t("videoLoadFailed", { message: load.message })
			}),
			settled && !isError && fileName !== void 0 && load.phase === "ready" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("video", {
				style: styles$2.video,
				src: load.url,
				controls: true,
				preload: "metadata"
			}),
			settled && !isError && fileName === void 0 && text !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				style: styles$2.output,
				children: text
			})
		]
	});
}

//#endregion
//#region src/client/SpeedSelect.tsx
/**
* The `loadSpeed` half of the inject face: the plugin's own speed state plus
* the host's current model selection (the visibility gate). A model-RPC
* failure throws rather than answering "hidden" — the caller keeps its last
* known state, so a transient failure never locks the toggle away.
*
* `sessionId` is a plain string: slot and command contexts brand it through
* different dsh-session copies, and only the service boundary needs one.
*
* `models` resolves lazily per call: the ui-model-selection service may
* register after this plugin applies, and a shell without it (no model seat
* at all) simply keeps the toggle hidden.
*/
function createSpeedLoader(connection, models, sessionId) {
	return async () => {
		const state = await callSubscriptionsAuth(connection.rpc, "speed", { sessionId });
		const directories = models();
		if (directories === void 0) return {
			visible: false,
			tier: state.tier
		};
		const { current } = await directories.directoryFor(sessionId).load();
		return {
			visible: current !== null && current.provider === "codex" && state.fastModels.includes(current.model),
			tier: state.tier
		};
	};
}
/** The `setSpeed` half of the inject face: boolean outcome for the component's busy state. */
function createSpeedSetter(connection, sessionId) {
	return (tier) => callSubscriptionsAuth(connection.rpc, "setSpeed", {
		sessionId,
		tier
	}).then(() => true, () => false);
}
/** English-dictionary fallback for a missing inject `t` (standalone renders). */
function fallbackTranslate(key) {
	return en[key];
}
const TIERS = ["standard", "fast"];
/**
* The composer Speed control: a trigger reading `速度 · 快速`/`速度 · 标准`
* that opens a two-row menu (standard/fast with descriptions, check mark on
* the current tier). Mount and every open reload the host state so a model
* switch made since the last open self-corrects.
*/
/** How often the control re-reads the host state (model switches arrive only by asking). */
const POLL_INTERVAL_MS$1 = 3e3;
/**
* The composer Speed control: a trigger reading `速度 · 快速`/`速度 · 标准`
* that opens a two-row menu (standard/fast with descriptions, check mark on
* the current tier). The host pushes nothing on a model switch, so the
* control re-reads on a slow poll with a single-flight guard; a failed read
* keeps the last known state, so a transient RPC failure can never lock the
* toggle away (the earlier mount-only load had no recovery path).
*/
function SpeedSelect({ loadSpeed, setSpeed, t }) {
	const translate = t ?? fallbackTranslate;
	const [state, setState] = (0, react.useState)(null);
	const [open, setOpen] = (0, react.useState)(false);
	const [busy, setBusy] = (0, react.useState)(false);
	const rootRef = (0, react.useRef)(null);
	const loadRef = (0, react.useRef)(loadSpeed);
	loadRef.current = loadSpeed;
	(0, react.useEffect)(() => {
		if (loadRef.current === void 0) return;
		let cancelled = false;
		let inflight = false;
		const reload = () => {
			const load = loadRef.current;
			if (load === void 0 || inflight) return;
			inflight = true;
			load().then((loaded) => {
				if (!cancelled) setState(loaded);
			}, () => {}).finally(() => {
				inflight = false;
			});
		};
		reload();
		const timer = setInterval(reload, POLL_INTERVAL_MS$1);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, []);
	(0, react.useEffect)(() => {
		if (!open) return;
		const closeOutside = (event) => {
			if (!rootRef.current?.contains(event.target)) setOpen(false);
		};
		document.addEventListener("mousedown", closeOutside);
		return () => {
			document.removeEventListener("mousedown", closeOutside);
		};
	}, [open]);
	if (loadSpeed === void 0 || setSpeed === void 0 || state === null || !state.visible) return null;
	const choose = (tier) => {
		if (busy) return;
		if (tier === state.tier) {
			setOpen(false);
			return;
		}
		setBusy(true);
		setSpeed(tier).then((ok) => {
			setBusy(false);
			if (ok) {
				setState({
					visible: true,
					tier
				});
				setOpen(false);
			}
		});
	};
	const show = () => {
		setOpen(true);
		const load = loadRef.current;
		if (load === void 0) return;
		load().then(setState, () => {});
	};
	const tierName = (tier) => translate(tier === "fast" ? "speedFast" : "speedStandard");
	const tierDescription = (tier) => translate(tier === "fast" ? "speedFastDescription" : "speedStandardDescription");
	const triggerLabel = `${translate("speed")} · ${tierName(state.tier)}`;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		ref: rootRef,
		style: styles$1.root,
		onKeyDown: (event) => {
			if (event.key === "Escape" && open) {
				event.preventDefault();
				setOpen(false);
			}
		},
		children: [open && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
			style: styles$1.menu,
			role: "menu",
			"aria-label": translate("speed"),
			children: TIERS.map((tier) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
				type: "button",
				role: "menuitemradio",
				"aria-checked": tier === state.tier,
				style: styles$1.item,
				disabled: busy,
				onClick: () => {
					choose(tier);
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: styles$1.itemCheck,
					children: tier === state.tier ? "✓" : ""
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
					style: styles$1.itemText,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: styles$1.itemName,
						children: tierName(tier)
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: styles$1.itemDescription,
						children: tierDescription(tier)
					})]
				})]
			}, tier))
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
			type: "button",
			style: styles$1.trigger,
			"aria-haspopup": "menu",
			"aria-expanded": open,
			title: triggerLabel,
			disabled: busy,
			onClick: () => {
				if (open) setOpen(false);
				else show();
			},
			children: triggerLabel
		})]
	});
}
const styles$1 = {
	root: {
		position: "relative",
		display: "inline-flex"
	},
	trigger: {
		border: "1px solid var(--dsw-alias-border-l2)",
		borderRadius: 8,
		background: "transparent",
		color: "var(--dsw-alias-label-secondary)",
		font: "inherit",
		fontSize: 12,
		lineHeight: "18px",
		padding: "2px 8px",
		cursor: "pointer",
		whiteSpace: "nowrap"
	},
	menu: {
		position: "absolute",
		bottom: "100%",
		right: 0,
		marginBottom: 4,
		minWidth: 180,
		padding: 4,
		zIndex: 20,
		background: "var(--dsw-alias-bg-layer-1)",
		border: "1px solid var(--dsw-alias-border-l2)",
		borderRadius: 8,
		display: "flex",
		flexDirection: "column",
		gap: 2
	},
	item: {
		display: "flex",
		alignItems: "flex-start",
		gap: 6,
		width: "100%",
		border: "none",
		borderRadius: 6,
		background: "transparent",
		padding: "6px 8px",
		cursor: "pointer",
		font: "inherit",
		textAlign: "left"
	},
	itemCheck: {
		width: 14,
		flexShrink: 0,
		fontSize: 12,
		lineHeight: "18px",
		color: "var(--dsw-alias-label-primary)"
	},
	itemText: {
		display: "flex",
		flexDirection: "column"
	},
	itemName: {
		fontSize: 12,
		lineHeight: "18px",
		color: "var(--dsw-alias-label-primary)"
	},
	itemDescription: {
		fontSize: 11,
		lineHeight: "16px",
		color: "var(--dsw-alias-label-tertiary)"
	}
};

//#endregion
//#region src/client/SubscriptionUsageBadge.tsx
/** How often the badge re-reads usage; the server also shares its own cache/negative-cache across UI surfaces. */
const POLL_INTERVAL_MS = 15 * 6e4;
/** Brand display names (short form for the compact badge). */
const PROVIDER_NAMES = {
	codex: "OpenAI (OAuth)",
	cursor: "Cursor",
	claude: "Claude",
	grok: "Grok",
	copilot: "Copilot"
};
/**
* Compact time-remaining label derived from the window's `resetsAt` timestamp:
* "6d18h" (days+hours), "1h58m" (hours+minutes), or "42m" (minutes only).
* Falls back to the scope/kind abbreviation when no reset time is known.
*/
function windowLabel(w) {
	if (w.resetsAt === void 0) {
		if (w.scope !== void 0 && w.scope !== "") return w.scope;
		switch (w.kind) {
			case "session": return "5h";
			case "weekly": return "Wk";
			default: return "W";
		}
	}
	const ms = Math.max(0, w.resetsAt - Date.now());
	const minutes = Math.floor(ms / 6e4);
	const hours = Math.floor(minutes / 60);
	const days = Math.floor(hours / 24);
	if (days > 0) return `${days}d${hours % 24}h`;
	if (hours > 0) return `${hours}h${minutes % 60}m`;
	return `${Math.max(1, minutes)}m`;
}
/**
* Usage of the account selected by the existing dispatcher for this chat model.
* The selection key hides old telemetry synchronously on a model/chat change.
*/
function SubscriptionUsageBadge({ rpc, directory, sessionId, useProjection }) {
	const state = (0, react.useSyncExternalStore)(directory.subscribe, directory.getSnapshot, directory.getSnapshot);
	const provider = state.current?.provider, model = state.current?.model;
	const key = JSON.stringify([sessionId, provider, model]);
	const stats = useProjection?.("sessionStats");
	const [display, setDisplay] = (0, react.useState)(null);
	(0, react.useEffect)(() => {
		let active = true, revision = 0;
		const refresh = async () => {
			const request = ++revision;
			if (!rpc || !sessionId || !model || !PROVIDER_NAMES[provider] || state.routable === false) { setDisplay(null); return; }
			try {
				const value = await callSubscriptionsAuth(rpc, "modelUsage", { sessionId, provider, model });
				if (active && request === revision) setDisplay(value.supported ? { key, value } : null);
			} catch { if (active && request === revision) setDisplay(null); }
		};
		void refresh();
		const timer = setInterval(refresh, POLL_INTERVAL_MS);
		document.addEventListener("dsh1c-model-selection-changed", refresh);
		return () => {
			active = false;
			clearInterval(timer);
			document.removeEventListener("dsh1c-model-selection-changed", refresh);
		};
	}, [rpc, directory, key, state.routable, stats]);
	if (state.routable === false || display?.key !== key) return null;
	const d = display.value;
	const windows = d.displayWindows ?? d.windows ?? [];
	const shownResets = new Set();
	const parts = windows.map(w => {
		const showReset = w.resetsAt !== void 0 && !shownResets.has(w.resetsAt);
		if (showReset) shownResets.add(w.resetsAt);
		const label = w.scope ? (showReset ? windowLabel(w) + " " : "") + w.scope : windowLabel(showReset ? w : { kind: w.kind });
		return `${label} ${validUsagePercent(w.usedPercent) ? `${Math.round(w.usedPercent)}% использовано` : "нет данных"}`;
	});
	const text = `${PROVIDER_NAMES[d.provider] || d.provider}${d.accountName ? " · " + d.accountName : ""} · ${parts.length ? parts.join(" · ") : "лимиты недоступны"}${d.stale ? " (данные устарели)" : ""}`;
	const basis = ({ active: "Аккаунт выполняющегося запроса выбранной модели.", last: "Аккаунт последнего запроса выбранной модели в этом чате.", next: "Предварительный аккаунт для следующего запроса выбранной модели; при отправке он может измениться." })[d.basis] || "Для выбранной модели не удалось определить доступный аккаунт.";
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
		"data-subscription-usage": true,
		style: styles.root,
		title: `${text}. ${basis}${d.observedAt ? " Данные получены: " + new Date(d.observedAt).toLocaleString() + "." : ""}`,
		children: text
	});
}
const styles = { root: {
	order: 1,
	marginInlineStart: "auto",
	color: "var(--dsw-alias-label-tertiary)",
	fontSize: 12,
	lineHeight: "18px",
	whiteSpace: "nowrap",
	minWidth: 0,
	maxWidth: "100%",
	overflow: "hidden",
	textOverflow: "ellipsis"
} };

//#endregion
//#region src/client/index.ts
/** Dictionary namespace owned by this plugin. */
const NS = "settings.subscriptions";
/**
* Required services (cordis fiber inject): `slots` carries the registration
* seat, `connection` the `/subscriptions-auth` RPC caller, and `locale` the copy
* dictionaries.
*/
const inject = [
	"slots",
	"connection",
	"locale"
];
/**
* Register the Subscriptions section once the `settings.section` declaration
* is on the ledger (the shell's apply order relative to this one is NOT
* constrained; registration depends on the slot through `slots.inject()`).
* @param ctx - client root context.
*/
function apply(ctx) {
	ctx.effect(() => {
		const select = (event) => {
			const id = event.detail?.provider;
			dsh1cSubscriptionProvider = PROVIDERS.some((row) => row.id === id) ? id : "";
		};
		document.addEventListener("dsh1c-subscription-provider", select);
		return () => document.removeEventListener("dsh1c-subscription-provider", select);
	}, "dsh1c: subscription navigation");
	ctx.effect(() => ctx.locale.register(NS, {
		zh,
		en
	}), "dsh-plugin-subscriptions: copy dictionaries");
	ctx.effect(() => {
		const style = document.createElement("style");
		style.setAttribute("data-plugin", "dsh-plugin-subscriptions");
		style.textContent = "div[role=\"dialog\"][aria-modal=\"true\"]:has(> nav) { padding-top: 14px; } [data-composer-dock]:has([data-subscription-usage]) { width: 100%; max-width: var(--dsh-composer-card-max-width); } .dsh1c-card[data-subscription-account], [data-subscription-account] { background: color-mix(in srgb, #7c9ac7 8%, var(--dsw-alias-bg-layer-1, #fff)); }";
		document.head.appendChild(style);
		return () => style.remove();
	}, "dsh-plugin-subscriptions: settings panel breathing room");
	const connection = ctx.get("connection");
	const t = ctx.locale.bind(NS);
	const injected = () => ({
		rpc: connection.rpc,
		t
	});
	ctx.slots.inject("settings.section", () => ctx.slots.register({
		name: "settings.section",
		id: "subscriptions",
		order: 90,
		label: () => t("nav"),
		inject: injected
	}, SubscriptionsSection));
	const toolviewInjected = () => ({ load: createImageLoader(connection.rpc) });
	ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({
		name: "tool.call.toolview",
		key: "image_generate",
		locale: NS,
		inject: toolviewInjected
	}, ImageGenerateToolview));
	const videoToolviewInjected = () => ({ loadVideo: createVideoLoader(connection.rpc) });
	ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({
		name: "tool.call.toolview",
		key: "video_generate",
		locale: NS,
		inject: videoToolviewInjected
	}, VideoGenerateToolview));
	const models = () => ctx.get("modelDirectories");
	ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
		name: "conversation.composer.dock",
		id: "subscription-usage",
		order: 10,
		inject: (sessionId) => ({ rpc: connection.rpc, sessionId, directory: models().directoryFor(sessionId).store })
	}, SubscriptionUsageBadge));
	ctx.inject(["commandUi"], (scope) => {
		const command = scope.get("commandUi");
		scope.effect(() => command.register({
			name: "fast",
			description: () => t("commandFast"),
			available: () => true,
			ui: {
				kind: "popupSelect",
				options: async (session) => {
					const state = await createSpeedLoader(connection, models, session.sessionId)();
					if (!state.visible) throw new Error(t("commandFastUnavailable"));
					return [{
						id: "standard",
						label: t("speedStandard"),
						detail: t("speedStandardDescription")
					}, {
						id: "fast",
						label: t("speedFast"),
						detail: t("speedFastDescription")
					}].map((option) => ({
						...option,
						active: option.id === state.tier
					}));
				},
				onSelect: async (option, session) => {
					await createSpeedSetter(connection, session.sessionId)(option.id);
				}
			}
		}), "dsh-plugin-subscriptions: /fast contribution");
	});
}

//#endregion
exports.ProviderModelEditor = ProviderModelEditor;
exports.SubscriptionProviderPanel = SubscriptionsSection;
exports.apply = apply;
exports.inject = inject;
return module.exports; } });
//# sourceMappingURL=client.js.map
// dsh1c-ui-locale: 3d9a1bd843f88955f21d5afa76e6dcc81aac24be1979d6eeb58f12769389aa2d

// dsh1c-ui-locale: 29a924f7d9e5339acd50184f348b84dacce079c890451afa133cfff9095df842

