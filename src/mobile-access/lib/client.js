window.__ModuleLoader__.load({
  id: "airules-dsh-mobile-access",
  factory: require => {
    const React = require("react"), h = React.createElement
    function MobileAccessSettingsSection() {
      const [state, setState] = React.useState(null);
      const [password, setPassword] = React.useState("");
      const [port, setPort] = React.useState("3443");
      const [busy, setBusy] = React.useState(false);
      const [failure, setFailure] = React.useState("");
      const [message, setMessage] = React.useState("");
      const [pairing, setPairing] = React.useState(null);
      const csrf = React.useRef("");
      const revision = React.useRef(0);
      const savedPort = React.useRef("3443");
      const request = React.useCallback(async action => {
        const current = ++revision.current;
        try {
          const response = await fetch("/airules/mobile-access", {
            method: action ? "POST" : "GET", credentials: "same-origin", mode: "same-origin",
            headers: { accept: "application/json", ...(action ? { "content-type": "application/json", "x-dsh-csrf": csrf.current } : {}) },
            ...(action ? { body: JSON.stringify(action) } : {}), signal: AbortSignal.timeout(action ? 30000 : 10000)
          });
          if (response.status === 403) throw new Error("Управление доступом с телефона доступно только в локальном DSH Desktop.");
          const body = await response.json();
          if (current !== revision.current) return null;
          if (body.csrfToken) csrf.current = body.csrfToken;
          if (typeof body.running === "boolean" && body.status) { setState(body); if (!body.running) setPairing(null); }
          if (!response.ok || !body.ok) throw new Error(action?.password
            ? "Не удалось сохранить пароль. Используйте от 10 до 1024 символов и повторите сохранение."
            : body.message || "Не удалось получить состояние доступа с телефона.");
          setState(body); setFailure("");
          return body;
        } catch (error) {
          if (current !== revision.current) return null;
          setFailure(error.name === "TimeoutError" || error.name === "AbortError"
            ? "DSH не ответил вовремя. Обновите состояние доступа."
            : error.name === "TypeError" ? "Нет связи с DSH. Повторите действие, когда приложение снова будет доступно."
            : error.name === "SyntaxError" ? "Не удалось прочитать ответ DSH. Обновите состояние доступа."
            : error.message || "Не удалось выполнить действие.");
          return null;
        }
      }, []);
      React.useEffect(() => { void request(); return () => { revision.current++; }; }, [request]);
      React.useEffect(() => {
        if (!state) return;
        const next = String(state.port), previous = savedPort.current;
        savedPort.current = next;
        setPort(current => current === previous ? next : current);
      }, [state?.port]);
      React.useEffect(() => {
        if (busy) return;
        let stopped = false, timer;
        const poll = async () => { await request(); if (!stopped) timer = setTimeout(poll, 3000); };
        timer = setTimeout(poll, 3000);
        return () => { stopped = true; clearTimeout(timer); };
      }, [request, busy]);
      React.useEffect(() => {
        if (!pairing) return;
        const remaining = new Date(pairing.expiresAt).getTime() - Date.now();
        const timer = setTimeout(() => setPairing(null), Math.max(0, Number.isFinite(remaining) ? remaining : 0));
        return () => clearTimeout(timer);
      }, [pairing]);
      const act = async (action, success = "") => {
        setBusy(true); setMessage("");
        try {
          const result = await request(action);
          if (result && success) setMessage(success);
          return result;
        } finally { setBusy(false); }
      };
      const savePassword = async event => {
        event.preventDefault();
        const result = await act({ action: "setPassword", password }, "Пароль сохранён. Используйте его для входа с телефона.");
        if (result) { setPassword(""); setPairing(null); }
      };
      const savePort = async event => {
        event.preventDefault();
        const result = await act({ action: "setPort", port: Number(port) }, "Порт сохранён.");
        if (result) { savedPort.current = String(result.port); setPort(savedPort.current); }
      };
      const revoke = async deviceId => {
        const result = await act(deviceId ? { action: "revoke", deviceId } : { action: "revokeAll" }, deviceId ? "Доступ клиента отозван." : "Все подключения завершены. Для нового входа потребуется пароль или новая привязка.");
        if (result) setPairing(null);
      };
      const running = state?.running === true;
      const changing = busy || state?.status === "starting";
      const unavailable = !state || !!failure;
      const passwordValid = password.length >= 10 && password.length <= 1024;
      const portValid = /^\d+$/.test(port) && Number.isInteger(Number(port)) && Number(port) >= 1024 && Number(port) <= 65535;
      const portDirty = port !== String(state?.port ?? 3443);
      const dirty = password.length > 0 || portDirty;
      const labels = { stopped: "Выключен", starting: "Включается…", running: "Включён", error: "Ошибка подключения" };
      const urls = (state?.urls || []).filter(url => typeof url === "string" && url.startsWith("https://"));
      const devices = state?.devices || [];
      const dateLabel = value => new Date(value).toLocaleString("ru-RU");
      return h("section", { className: "dsh1c-panel", "data-dsh1c-settings": "MobileAccessSettingsSection", "aria-label": "Доступ с телефона" },
        h("h2", null, "Доступ с телефона"),
        h("p", null, "Открывайте DSH в браузере телефона через dsh-relay. Компьютер и DSH должны оставаться включёнными, а телефон — быть в той же сети или подключён к настроенному VPN."),
        h("p", { className: "dsh1c-status" }, "Управление доступом доступно только в локальном DSH Desktop."),
        h("form", { className: "dsh1c-field", onSubmit: savePassword },
          h("label", { className: "dsh1c-field" }, "Пароль для входа с телефона", h("input", {
            type: "password", autoComplete: "new-password", value: password, minLength: 10, maxLength: 1024, spellCheck: false,
            disabled: changing || !state, "aria-label": "Пароль доступа с телефона", placeholder: state?.hasPassword ? "Сохранён. Введите новый для замены" : "Не менее 10 символов",
            onChange: event => { setPassword(event.target.value); setMessage(""); }
          })),
          h("p", { className: "dsh1c-status" }, state?.hasPassword ? "Пароль сохранён и не показывается. Замена пароля завершит текущие подключения." : "Сначала сохраните пароль, затем включите доступ."),
          h("div", { className: "dsh1c-actions" }, h("button", { type: "submit", className: "dsh1c-button", disabled: changing || !state || !passwordValid }, "Сохранить пароль"))),
        h("p", { role: "status" }, "Статус: " + (failure ? "недоступен" : state ? labels[state.status] || "неизвестен" : "проверяем…")),
        h("div", { className: "dsh1c-actions" },
          h("button", { type: "button", className: "dsh1c-button", disabled: changing || !state || (!running && (unavailable || !state.hasPassword || dirty)), onClick: () => act({ action: running ? "stop" : "start" }) }, running ? "Выключить доступ с телефона" : "Включить доступ с телефона"),
          h("button", { type: "button", className: "dsh1c-button dsh1c-secondary", disabled: changing || unavailable || !state?.hasPassword, onClick: () => revoke() }, "Завершить все подключения"),
          h("button", { type: "button", className: "dsh1c-button dsh1c-secondary", disabled: busy, onClick: () => act() }, "Обновить состояние доступа")),
        dirty ? h("p", { className: "dsh1c-status" }, "Перед включением сохраните изменённые пароль и порт.") : null,
        h("label", { className: "dsh1c-status" }, h("input", {
          type: "checkbox", checked: state?.autoStart === true, disabled: changing || unavailable || !state?.hasPassword,
          onChange: event => act({ action: "setAutoStart", enabled: event.target.checked })
        }), " Включать доступ с телефона при запуске DSH"),
        h("p", { className: "dsh1c-status" }, "Выключение сохраняет пароль и привязки. Автозапуск действует при следующем запуске DSH."),
        running ? h("div", { className: "dsh1c-field" },
          h("h3", null, "Открыть в браузере телефона"),
          urls.length ? urls.map(url => h("a", { key: url, href: url, target: "_blank", rel: "noopener noreferrer", className: "dsh1c-path" }, url)) : h("p", null, "Сетевой адрес пока не определён. Проверьте подключение компьютера к сети."),
          state?.qrDataUrl ? h("img", { src: state.qrDataUrl, width: 196, height: 196, alt: "QR-код HTTPS адреса DSH для браузера телефона", style: { maxWidth: "100%", objectFit: "contain", background: "white" } }) : null,
          h("p", { className: "dsh1c-status" }, "Откройте ссылку или отсканируйте QR и введите сохранённый пароль. При первом открытии браузер предупредит о локальном сертификате. Адрес доступен в вашей сети или через VPN; публичный интернет-туннель не создаётся.")) : null,
        h("details", null, h("summary", null, "Дополнительные настройки и клиенты"),
          h("form", { className: "dsh1c-field", onSubmit: savePort },
            h("label", { className: "dsh1c-field" }, "HTTPS порт", h("input", { type: "number", min: 1024, max: 65535, step: 1, value: port, disabled: changing || !state, "aria-label": "HTTPS порт доступа с телефона", onChange: event => { setPort(event.target.value); setMessage(""); } })),
            h("p", { className: "dsh1c-status" }, "От 1024 до 65535. Изменение порта перезапустит включённый доступ."),
            h("button", { type: "submit", className: "dsh1c-button dsh1c-secondary", disabled: changing || !state || !portValid || !portDirty }, "Сохранить порт")),
          state?.fingerprint ? h("p", { className: "dsh1c-status" }, "Отпечаток сертификата: ", h("span", { className: "dsh1c-path", style: { overflowWrap: "anywhere" } }, state.fingerprint)) : null,
          h("h3", null, "Клиенты с токеном доступа"),
          h("p", { className: "dsh1c-status" }, "Этот список относится к совместимым клиентам dsh-relay. Входы из обычного браузера здесь не отображаются; для них используйте «Завершить все подключения»."),
          devices.length ? devices.map(device => h("div", { key: device.id, className: "dsh1c-field" },
            h("span", null, device.name || "Клиент dsh-relay"), h("span", { className: "dsh1c-status" }, "Доступ до " + dateLabel(device.expiresAt)),
            h("button", { type: "button", className: "dsh1c-button dsh1c-secondary", disabled: changing || unavailable, onClick: () => revoke(device.id) }, "Отозвать доступ: " + (device.name || "клиент")))) : h("p", { className: "dsh1c-status" }, "Клиенты с токеном ещё не привязаны."),
          h("button", { type: "button", className: "dsh1c-button dsh1c-secondary", disabled: changing || unavailable || !running, onClick: async () => { const result = await act({ action: "createPairing" }); if (result) setPairing(result.pairing || null); } }, "Создать код для совместимого клиента"),
          pairing ? h("div", { className: "dsh1c-field" }, h("p", null, "Одноразовый код: ", h("strong", null, pairing.code)), h("p", { className: "dsh1c-status" }, "Действует до " + dateLabel(pairing.expiresAt) + ". Этот код и QR предназначены для совместимого клиента dsh-relay, а не для браузера."), pairing.qrDataUrl ? h("img", { src: pairing.qrDataUrl, width: 196, height: 196, alt: "QR-код привязки совместимого клиента dsh-relay", style: { maxWidth: "100%", objectFit: "contain", background: "white" } }) : null) : null),
        failure || state?.status === "error" ? h("p", { role: "alert", className: "dsh1c-error" }, failure || state.message) : null,
        message ? h("p", { role: "status" }, message) : null);
    }

    return { inject: ["slots"], apply(ctx) {
      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section", id: "airules-mobile-access", order: 19, label: () => "Доступ с телефона"
      }, MobileAccessSettingsSection))
    } }
  }
})
