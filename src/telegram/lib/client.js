window.__ModuleLoader__.load({
  id: "airules-dsh-telegram",
  factory: require => {
    const React = require("react");
    const h = React.createElement;
    let workspacePanelsContext = null;
    function selectedWorkspaceSessionId() {
      const current = workspacePanelsContext?.get?.("uiSession")?.adapter?.current?.getSnapshot?.();
      if (current?.key) return current.key;
      const sessions = workspacePanelsContext?.get?.("sessions") || workspacePanelsContext?.sessions;
      const list = sessions?.list?.getSnapshot();
      return Object.values(list?.byId || {}).find(session => (session.retainedBy?.mainView ?? 0) > 0)?.id ?? list?.current ?? null;
    }
    function subscribeWorkspaceSession(listener) {
      const sessions = workspacePanelsContext?.get?.("sessions") || workspacePanelsContext?.sessions;
      const offList = sessions?.list?.subscribe(listener);
      const offCurrent = workspacePanelsContext?.get?.("uiSession")?.adapter?.current?.subscribe?.(listener);
      return () => { offList?.(); offCurrent?.(); };
    }
    function useWorkspaceSessionId() {
      // DSH 0.1.6 moved the selected (also blank) session from .current to
      // source-labelled ownership. Match the native workspace list selection.
      return React.useSyncExternalStore(subscribeWorkspaceSession, selectedWorkspaceSessionId);
    }


    function TelegramSettingsSection() {
      const sessionId = useWorkspaceSessionId();
      const [state, setState] = React.useState(null);
      const [owner, setOwner] = React.useState("");
      const [token, setToken] = React.useState("");
      const [busy, setBusy] = React.useState(false);
      const [failure, setFailure] = React.useState("");
      const [message, setMessage] = React.useState("");
      const [forgetRequested, setForgetRequested] = React.useState(false);
      const csrf = React.useRef("");
      const revision = React.useRef(0);
      const savedOwner = React.useRef("");
      const request = React.useCallback(async action => {
        const current = ++revision.current;
        try {
          const response = await fetch("/airules/telegram-control", {
            method: action ? "POST" : "GET", credentials: "same-origin", mode: "same-origin",
            headers: { accept: "application/json", ...(action ? { "content-type": "application/json", "x-dsh-csrf": csrf.current } : {}) },
            ...(action ? { body: JSON.stringify(action) } : {}), signal: AbortSignal.timeout(action ? 30000 : 10000)
          });
          if (response.status === 403) throw new Error("Управление Telegram доступно только в локальном DSH Desktop.");
          const body = await response.json();
          if (!response.ok || !body.ok) throw new Error(action?.token
            ? "Не удалось сохранить Telegram. Проверьте токен и ID владельца и повторите сохранение."
            : body.message || body.error || "Не удалось получить состояние Telegram.");
          if (current !== revision.current) return null;
          csrf.current = body.csrfToken || "";
          setState(body); setFailure("");
          return body;
        } catch (error) {
          if (current !== revision.current) return null;
          setFailure(error.name === "TimeoutError" || error.name === "AbortError"
            ? "DSH не ответил вовремя. Обновите статус Telegram."
            : error.name === "TypeError" ? "Нет связи с DSH. Повторите действие, когда приложение снова будет доступно."
            : error.name === "SyntaxError" ? "Не удалось прочитать ответ DSH. Обновите статус Telegram."
            : error.message || "Не удалось выполнить действие Telegram.");
          return null;
        }
      }, []);
      React.useEffect(() => { void request(); return () => { revision.current++; }; }, [request]);
      React.useEffect(() => {
        if (!state) return;
        const next = state.ownerId == null ? "" : String(state.ownerId);
        const previous = savedOwner.current;
        savedOwner.current = next;
        setOwner(current => current === previous ? next : current);
      }, [state?.ownerId]);
      React.useEffect(() => {
        if (busy) return;
        let stopped = false, timer;
        const poll = async () => { await request(); if (!stopped) timer = setTimeout(poll, 3000); };
        timer = setTimeout(poll, 3000);
        return () => { stopped = true; clearTimeout(timer); };
      }, [request, busy]);
      const act = async (action, success = "") => {
        setBusy(true); setMessage(""); setForgetRequested(false);
        try {
          const result = await request(action);
          if (result && success) setMessage(success);
          return result;
        } finally { setBusy(false); }
      };
      const save = async event => {
        event.preventDefault();
        const result = await act({ action: "save", ownerId: Number(owner), ...(token.trim() ? { token: token.trim() } : {}) }, "Настройки Telegram сохранены. Подключение включается отдельной кнопкой.");
        if (result) { setToken(""); savedOwner.current = result.ownerId == null ? "" : String(result.ownerId); setOwner(savedOwner.current); }
      };
      const forget = async () => {
        const result = await act({ action: "forget" }, "Настройки Telegram удалены. Подключение и автозапуск выключены.");
        if (result) { setToken(""); setOwner(""); savedOwner.current = ""; }
      };
      const ownerValid = /^[1-9]\d*$/.test(owner) && Number.isSafeInteger(Number(owner));
      const dirty = owner !== (state?.ownerId == null ? "" : String(state.ownerId)) || token.length > 0;
      const active = state?.active ?? state?.status === "running";
      const changing = busy || ["starting", "stopping"].includes(state?.status);
      const unavailable = !state || !!failure;
      const labels = { stopped: "Выключен", starting: "Подключается…", running: "Подключён", stopping: "Отключается…", error: "Ошибка подключения" };
      return h("section", { className: "airulesTelegram-panel", "data-airulesTelegram-settings": "TelegramSettingsSection", "aria-label": "Telegram" },
        h("h2", null, "Telegram"),
        h("p", null, "Продолжайте выбранный чат DSH с телефона. Компьютер и DSH должны оставаться включёнными."),
        h("p", { className: "airulesTelegram-status" }, "Создайте отдельного бота в ", h("a", { href: "https://t.me/BotFather", target: "_blank", rel: "noopener noreferrer" }, "BotFather"), ". Укажите свой числовой Telegram ID: доступ получит только этот пользователь в личном чате."),
        h("form", { className: "airulesTelegram-field", onSubmit: save },
          h("label", { className: "airulesTelegram-field" }, "Токен бота", h("input", {
            type: "password", autoComplete: "new-password", value: token, maxLength: 256, spellCheck: false,
            disabled: changing, "aria-label": "Токен Telegram-бота",
            placeholder: state?.tokenStored ? "Сохранён. Введите новый только для замены" : state?.configured ? "Задан для текущего запуска" : "Токен от BotFather",
            onChange: event => { setToken(event.target.value); setMessage(""); }
          })),
          state?.configured ? h("p", { className: "airulesTelegram-status" }, state.tokenStored
            ? "Токен сохранён с защитой Windows. Пустое поле сохраняет прежний токен."
            : "Токен задан для текущего запуска. Нажмите «Сохранить настройки Telegram», чтобы сохранить его с защитой Windows для следующих запусков.") : null,
          h("label", { className: "airulesTelegram-field" }, "Ваш Telegram ID", h("input", {
            type: "text", inputMode: "numeric", autoComplete: "off", value: owner, maxLength: 20, pattern: "[1-9][0-9]*",
            disabled: changing, "aria-label": "Telegram ID владельца", placeholder: "Числовой ID пользователя",
            onChange: event => { setOwner(event.target.value); setMessage(""); }
          })),
          h("div", { className: "airulesTelegram-actions" }, h("button", {
            type: "submit", className: "airulesTelegram-button", disabled: changing || !state || !ownerValid || (!state.configured && !token.trim()) || (!dirty && (!state.configured || state.tokenStored))
          }, "Сохранить настройки Telegram"))),
        h("p", { role: "status" }, "Статус: " + (failure ? "недоступен" : state ? labels[state.status] || "неизвестен" : "проверяем…")),
        state?.binding ? h("p", { className: "airulesTelegram-status" }, "Привязанный чат: ", h("span", { className: "airulesTelegram-path" }, state.binding.sessionId), state.binding.workspaceTitle ? " · " + state.binding.workspaceTitle : "")
          : h("p", { className: "airulesTelegram-status" }, "Чат ещё не привязан. Откройте нужный чат DSH и нажмите «Привязать текущий чат»."),
        h("div", { className: "airulesTelegram-actions" },
          h("button", { type: "button", className: "airulesTelegram-button", disabled: changing || !state || (!active && (unavailable || !state.configured || dirty)), onClick: () => act({ action: active ? "stop" : "start" }) }, active ? "Отключить Telegram" : "Подключить Telegram"),
          h("button", { type: "button", className: "airulesTelegram-button airulesTelegram-secondary", disabled: changing || unavailable || !state?.configured || dirty || !sessionId, onClick: () => act({ action: "connect", sessionId }, "Текущий чат привязан. Напишите боту /start в Telegram.") }, "Привязать текущий чат"),
          h("button", { type: "button", className: "airulesTelegram-button airulesTelegram-secondary", disabled: changing || unavailable || !state?.binding, onClick: () => act({ action: "disconnect" }, "Чат отвязан. Настройки бота сохранены.") }, "Отвязать чат"),
          h("button", { type: "button", className: "airulesTelegram-button airulesTelegram-secondary", disabled: busy, onClick: () => act() }, "Обновить статус Telegram")),
        dirty ? h("p", { className: "airulesTelegram-status" }, "Перед подключением сохраните изменённые настройки. Замена токена или владельца отключит связь и прежнюю привязку.") : null,
        h("label", { className: "airulesTelegram-status" }, h("input", {
          type: "checkbox", checked: state?.autoStart === true, disabled: changing || unavailable || !state?.configured,
          onChange: event => act({ action: "setAutoStart", autoStart: event.target.checked })
        }), " Подключать Telegram при запуске DSH"),
        h("p", { className: "airulesTelegram-status" }, "Выбранный чат сохраняется после выключения. Автозапуск действует при следующем запуске DSH."),
        failure || state?.error ? h("p", { role: "alert", className: "airulesTelegram-error" }, failure || state.error) : null,
        message ? h("p", { role: "status" }, message) : null,
        state?.configured || state?.ownerId ? h("div", { className: "airulesTelegram-actions" }, forgetRequested
          ? h("div", { role: "group", "aria-label": "Удаление настроек Telegram" },
            h("p", null, "Удалить сохранённый токен, владельца и привязку? Telegram и автозапуск будут выключены."),
            h("button", { type: "button", className: "airulesTelegram-button", disabled: changing, onClick: forget }, "Удалить настройки Telegram"),
            h("button", { type: "button", className: "airulesTelegram-button airulesTelegram-secondary", disabled: changing, onClick: () => setForgetRequested(false) }, "Отмена"))
          : h("button", { type: "button", className: "airulesTelegram-button airulesTelegram-secondary", disabled: changing || unavailable, onClick: () => setForgetRequested(true) }, "Удалить сохранённые настройки…")) : null);
    }

    const css = ".airulesTelegram-panel{display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary);max-width:850px}.airulesTelegram-panel h2,.airulesTelegram-panel p{margin:0}.airulesTelegram-panel p{font-size:13px;line-height:1.5}.airulesTelegram-field{display:flex;flex-direction:column;gap:6px}.airulesTelegram-field input{box-sizing:border-box;max-width:100%;padding:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit}.airulesTelegram-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.airulesTelegram-button{padding:8px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer}.airulesTelegram-button:disabled{opacity:.5;cursor:default}.airulesTelegram-status{font-size:12px}.airulesTelegram-path{overflow-wrap:anywhere;font-family:monospace}.airulesTelegram-error{color:var(--dsw-alias-state-error-primary)}";
    function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement("style");
        style.textContent = css;
        style.dataset.pluginCss = "airules-dsh-telegram";
        document.head.appendChild(style);
        return () => style.remove();
      });
      ctx.inject(["sessions"], ready => ready.effect(() => {
        workspacePanelsContext = ready;
        return () => { if (workspacePanelsContext === ready) workspacePanelsContext = null; };
      }));
      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section", id: "airules-telegram", order: 18, label: () => "Telegram"
      }, TelegramSettingsSection));
    }
    return { inject: ["slots"], apply };
  }
});

