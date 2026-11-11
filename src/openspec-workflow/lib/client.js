window.__ModuleLoader__.load({
  id: "dsh-openspec-workflow",
  factory: (require) => {
    const React = require("react");
    let projectUi = null;
    try { projectUi = require('airules-dsh-project-context'); } catch { /* legacy standalone bundle */ }
    const h = React.createElement;
    const OPENSPEC_API = "/onec/openspec", OPENSPEC_READ_API = "/onec/openspec/read", OPENSPEC_ACTION_API = "/onec/openspec/action", OPENSPEC_REFRESH_MS = 5000;
    let workspacePanelsContext = null;
    let nativeWorkspaceSidebar = null;
    function useWorkspaceSessionId() {
      const sessions = workspacePanelsContext?.get?.("sessions") || workspacePanelsContext?.sessions;
      // DSH 0.1.6 moved the selected (also blank) session from .current to
      // source-labelled ownership. Match the native workspace list selection.
      return React.useSyncExternalStore((listener) => sessions?.list?.subscribe(listener) || (() => {}), () => {
        const list = sessions?.list?.getSnapshot();
        return Object.values(list?.byId || {}).find((session) => (session.retainedBy?.mainView ?? 0) > 0)?.id ?? list?.current ?? null;
      });
    }

    const openSpecTicketRequests = new Map();
    function queueOpenSpecTicket(event) {
      const { ticket, sessionId } = event.detail || {};
      if (typeof sessionId !== 'string' || !sessionId || typeof ticket !== 'string' || ticket.length > 2048 || !/^(?:https?:\/\/|[A-Za-z][A-Za-z0-9_]*-\d+$)/u.test(ticket)) return;
      openSpecTicketRequests.set(sessionId, /^https?:/u.test(ticket) ? ticket : ticket.toUpperCase());
      openOpenSpecWorkspace();
      globalThis.dispatchEvent?.(new CustomEvent('onec:openspec-ticket-ready', { detail: { sessionId } }));
    }
    function openOpenSpecWorkspace() {
      return openWorkspacePanel("onec-openspec", "Изменения OpenSpec");
    }

    function openWorkspacePanel(kind) {
      if (!nativeWorkspaceSidebar) return false;
      nativeWorkspaceSidebar.openTab(kind);
      return true;
    }

    function WorkspaceIcon({ kind, size = 16 }) {
      const paths = kind === "mcp" ? ["M8 3v4m8-4v4M6 7h12v4a6 6 0 0 1-12 0V7Zm6 10v4"]
        : kind === "import" ? ["M14 3h6v18H4V3h6", "M12 2v12m-4-4 4 4 4-4"]
          : kind === "settings" ? ["M21 4h-7M10 4H3m18 8h-9m-4 0H3m18 8h-5m-4 0H3", "M14 2v4M8 10v4m8 4v4"]
          : ["M6 3h12v18H6z", "M9 7h6m-6 5h6m-6 5h4"];
      return h("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true }, ...paths.map((d, index) => h("path", { d, key: index })));
    }
    const OpenSpecIcon = (props) => h(WorkspaceIcon, { ...props, kind: "openspec" });
    function useOpenSpecWorkspace(requestedSessionId, projectId) {
      const currentSessionId = useWorkspaceSessionId();
      const sessionId = requestedSessionId ?? currentSessionId;
      const [received, setSnapshot] = React.useState(null);
      const snapshot = received?.sessionId === sessionId ? received : null;
      const [error, setError] = React.useState(null);
      const [loading, setLoading] = React.useState(true);
      const csrf = React.useRef("");
      const generation = React.useRef(0);
      const snapshotRequest = React.useRef(0);
      const pendingActions = React.useRef(0);
      const load = React.useCallback(async (options = {}) => {
        if (options.silent && pendingActions.current > 0) return null;
        const id = generation.current, requestId = ++snapshotRequest.current;
        if (!sessionId) { setLoading(false); setError("Выберите рабочую область и откройте её сеанс."); return null; }
        if (!options.silent) { setLoading(true); setError(null); }
        try {
          const response = await fetch(`${OPENSPEC_API}?sessionId=${encodeURIComponent(sessionId)}${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ''}`, { headers: { accept: "application/json" } });
          const body = await response.json();
          if (id !== generation.current || requestId !== snapshotRequest.current) return null;
          if (!response.ok || !body.ok) throw new Error(openSpecErrorMessage(body.message || body.error ? body : `HTTP ${response.status}`));
          csrf.current = body.csrfToken || csrf.current;
          setSnapshot({ ...body, sessionId });
          return body;
        } catch (reason) {
          if (id === generation.current && requestId === snapshotRequest.current) setError(openSpecErrorMessage(reason));
          return null;
        } finally { if (id === generation.current && requestId === snapshotRequest.current && !options.silent) setLoading(false); }
      }, [sessionId, projectId]);
      const action = React.useCallback(async (input) => {
        snapshotRequest.current += 1; pendingActions.current += 1;
        setError(null);
        try {
        const response = await fetch(OPENSPEC_ACTION_API, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json", "x-dsh-csrf": csrf.current },
          body: JSON.stringify({ ...input, sessionId: sessionId || "", ...(projectId ? { projectId } : {}) })
        });
        const body = await response.json();
        if (!response.ok || !body.ok) {
          const failure = new Error(openSpecErrorMessage(body.message || body.error ? body : `HTTP ${response.status}`));
          failure.code = body.error;
          if (body.revision) failure.revision = body.revision;
          throw failure;
        }
        return body;
        } finally { pendingActions.current -= 1; }
      }, [sessionId, projectId]);
      React.useEffect(() => {
        load();
        const changed = () => load();
        globalThis.document?.addEventListener?.("dsh-project-presets-changed", changed);
        const timer = setInterval(() => { load({ silent: true }); }, OPENSPEC_REFRESH_MS);
        return () => { clearInterval(timer); globalThis.document?.removeEventListener?.("dsh-project-presets-changed", changed); generation.current += 1; };
      }, [load]);
      return { snapshot, error, setError, loading, load, action };
    }

    function TicketSystemSettingsSection({ sessionId: requestedSessionId } = {}) {
      const currentSessionId = useWorkspaceSessionId();
      const project = projectUi?.useProject ? projectUi.useProject({ presets: ['1c-airules'] }) : null;
      const selected = requestedSessionId === undefined ? project : null;
      const sessionId = requestedSessionId ?? selected?.id ?? selected?.sessionId ?? currentSessionId;
      const projectId = selected?.projectId;
      return h(React.Fragment, null,
        selected && projectUi?.ProjectPicker && h(projectUi.ProjectPicker, { project: selected }),
        h(TicketSystemSettingsEditor, { key: projectId || sessionId || 'no-project', sessionId, projectId }));
    }
    function TicketSystemSettingsEditor({ sessionId, projectId }) {
      const state = useOpenSpecWorkspace(sessionId, projectId);
      const [draft, setDraft] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [message, setMessage] = React.useState('');
      const source = draft || state.snapshot?.ticketSource || { url: '', revision: null };
      if (!sessionId) return h('section', { className: 'dsh1c-panel' }, h('h3', null, 'Система учета задач'), h('p', null, 'Выберите проект. Источник сохраняется для проекта; доступность изменения определяется его штатными правами.'));
      const edit = event => setDraft(current => ({ ...(current || state.snapshot?.ticketSource || { version: 1, revision: null }), url: event.target.value }));
      const save = async event => {
        event.preventDefault(); setBusy(true); setMessage('');
        try {
          await state.action({ action: 'ticket-source', url: source.url || '', expectedRevision: source.revision ?? null });
          setDraft(null); await state.load({ silent: true }); setMessage('Общий источник сохранён. OpenSpec использует эту же настройку.');
        } catch (error) { setMessage(openSpecErrorMessage(error)); }
        finally { setBusy(false); }
      };
      return h('section', { className: 'dsh1c-panel dsh1c-field' }, h('h3', null, 'Система учета задач'),
        h('p', { className: 'dsh1c-status' }, 'Общая настройка выбранного проекта. Jira или другая система; Atlassian MCP для ссылки не требуется.'),
        h('form', { onSubmit: save, className: 'dsh1c-field' },
          h('label', null, 'Ссылка на список открытых тикетов', h('input', { type: 'url', value: source.url || '', maxLength: 2048, placeholder: 'https://tracker.example/issues?state=open', onChange: edit, 'aria-label': 'Ссылка на список открытых тикетов' })),
          h('div', { className: 'dsh1c-actions' }, h('button', { type: 'submit', className: 'dsh1c-button', disabled: busy || state.loading || !!state.snapshot?.ticketSource?.invalid }, 'Сохранить источник'),
            h('button', { type: 'button', className: 'dsh1c-button', onClick: () => { setDraft(null); void state.load(); } }, 'Перечитать'))),
        state.error || message ? h('p', { role: 'status' }, state.error || message) : null);
    }

    function openSpecErrorMessage(reason) {
      const message = String(reason?.message || reason?.error || reason || '').trim();
      const detail = (reason?.code || reason?.error || '') + ' ' + message;
      if (/OPENSPEC_ACTION_REJECTED|(?:inspect|action)[^\n]{0,40}rejected/i.test(detail)) return 'Обработчик OpenSpec в запущенной версии не поддерживает это действие. Обновите поставку и перезапустите DSH Desktop; перед закрытием скопируйте несохранённые правки.';
      if (/REVISION_CONFLICT|VERSION_CONFLICT/.test(detail)) return 'Файл изменился на диске. Ваш черновик остаётся в панели; перечитайте файл и сравните изменения перед сохранением.';
      if (/CSRF|HTTP 401|HTTP 403/.test(detail)) return 'Сеанс панели устарел. Скопируйте несохранённые правки и заново откройте панель OpenSpec.';
      if (/Failed to fetch|fetch failed|NetworkError|ECONN|HTTP 50[0234]/i.test(detail)) return 'Не удалось связаться с DSH Desktop. Убедитесь, что приложение запущено, и повторите действие.';
      if (message.length <= 400 && /[А-Яа-яЁё]/.test(message) && !/[{}]|\n\s*at |[A-Z][A-Z0-9]+_[A-Z0-9_]+/.test(message)) return message;
      return 'Не удалось выполнить действие OpenSpec. Повторите попытку; если ошибка сохраняется, обновите поставку и перезапустите DSH Desktop, предварительно скопировав несохранённые правки.';
    }

    function OpenSpecActionIcon({ kind, size = 16 }) {
      const paths = {
        play: 'M8 5l11 7-11 7z', archive: 'M3 4h18v4H3z M5 8v12h14V8 M9 12h6',
        plus: 'M12 5v14 M5 12h14', more: 'M5 12h.01 M12 12h.01 M19 12h.01',
        check: 'M5 12l4 4L19 6', refresh: 'M20 7v5h-5 M4 17v-5h5 M6 7a7 7 0 0 1 12-1l2 3 M4 15l2 3a7 7 0 0 0 12-1',
        file: 'M6 3h8l4 4v14H6z M14 3v5h4 M9 12h6 M9 16h6',
        save: 'M4 3h14l3 3v15H3V3z M7 3v6h10V3 M7 21v-8h10v8',
        chat: 'M4 4h16v12H9l-5 4z M8 8h8 M8 12h5', search: 'M15 15l6 6 M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
        notice: 'M12 8v5 M12 17h.01 M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18', arrow: 'M9 5l7 7-7 7', close: 'M6 6l12 12 M6 18L18 6', list: 'M9 6h12 M9 12h12 M9 18h12 M3 6h1 M3 12h1 M3 18h1'
      };
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: false }, h('path', { d: paths[kind] || paths.file }));
    }

    // File drafts belong to the project; AI delivery state belongs to its actual chat.
    const openSpecPanelDrafts = new Map();
    const openSpecAiDrafts = new Map();
    function projectDraftKey(snapshot) {
      const root = snapshot?.projectRoot;
      return typeof root === 'string' && root && root.length <= 4096 && !root.includes('\0') ? root : null;
    }
    function rememberProjectDrafts(root, drafts) {
      if (!root) return false;
      if (!Object.keys(drafts).length) { openSpecPanelDrafts.delete(root); return true; }
      if (!openSpecPanelDrafts.has(root) && openSpecPanelDrafts.size >= 128) return false;
      openSpecPanelDrafts.set(root, { drafts }); return true;
    }
    function readProjectDrafts(root) { return openSpecPanelDrafts.get(root)?.drafts || {}; }
    function OpenSpecPanel({ compact = false, sessionId }) {
      const state = useOpenSpecWorkspace(sessionId);
      const [artifactPath, setArtifactPath] = React.useState('');
      const [page, setPage] = React.useState(null);
      const [drafts, setDrafts] = React.useState({});
      const draftOwner = React.useRef({ root: null, restoring: false });
      const [selection, setSelection] = React.useState('');
      const selectionRef = React.useRef(null);
      const editorRef = React.useRef(null);
      const aiTrigger = React.useRef(null);
      const previousChange = React.useRef('');
      const [documentTab, setDocumentTab] = React.useState('proposal');
      const [focusedDocumentTab, setFocusedDocumentTab] = React.useState('proposal');
      const [requirementsPath, setRequirementsPath] = React.useState('');
      const [aiDrafts, setAiDrafts] = React.useState(openSpecAiDrafts.get(sessionId) || {});
      const [aiOpenPath, setAiOpenPath] = React.useState('');
      const [transition, setTransition] = React.useState(null);
      const transitionRef = React.useRef(null);
      const transitionTrigger = React.useRef(null);
      const [stage, setStage] = React.useState('requirements');
      const [taskView, setTaskView] = React.useState('list');
      const [notice, setNotice] = React.useState('');
      const [creating, setCreating] = React.useState(false);
      const [description, setDescription] = React.useState('');
      const [newTicket, setNewTicket] = React.useState('');
      const [readDescription, setReadDescription] = React.useState(true);
      const [pane, setPane] = React.useState('specs');
      const [sourceDraft, setSourceDraft] = React.useState(null);
      React.useEffect(() => {
        const receive = () => {
          const ticket = typeof openSpecTicketRequests !== 'undefined' ? openSpecTicketRequests.get(sessionId) : null;
          if (!ticket) return;
          openSpecTicketRequests.delete(sessionId);
          previousChange.current = state.snapshot?.selectedChange || previousChange.current;
          setNewTicket(ticket); setReadDescription(true); setDescription(''); setPane('specs'); setCreating(true); setExplored(false); setResearchFirst(false);
        };
        receive(); globalThis.addEventListener?.('onec:openspec-ticket-ready', receive);
        return () => globalThis.removeEventListener?.('onec:openspec-ticket-ready', receive);
      }, [sessionId, state.snapshot?.selectedChange]);
      const [ticketTarget, setTicketTarget] = React.useState('');
      const [ticketEdits, setTicketEdits] = React.useState({});
      const [ticketList, setTicketList] = React.useState(null);
      const [ticketSelected, setTicketSelected] = React.useState([]);
      const [ticketListBusy, setTicketListBusy] = React.useState(false);
      const [ticketListError, setTicketListError] = React.useState('');
      const [explored, setExplored] = React.useState(false);
      const [researchFirst, setResearchFirst] = React.useState(false);
      const [exploreTopic, setExploreTopic] = React.useState('');
      const [exploreOpen, setExploreOpen] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const snapshot = state.snapshot;
      const draftProject = projectDraftKey(snapshot);
      const sourceConfig = sourceDraft || snapshot?.ticketSource || { url: '' };
      const editSource = patch => setSourceDraft(current => ({ ...(current || snapshot?.ticketSource || { version: 1, url: '', revision: null }), ...patch }));
      const ticketServer = sourceConfig.server || '', ticketSite = sourceConfig.cloudId || '';
      const ticketRequest = React.useRef(null);
      ticketRequest.current = ticketList?.status === 'loading' ? ticketList.requestId : null;
      React.useEffect(() => {
        if (!sourceDraft && snapshot && Object.hasOwn(snapshot, 'ticketList')) setTicketList(snapshot.ticketList);
      }, [snapshot?.ticketList, sourceDraft]);
      React.useEffect(() => () => {
        if (ticketRequest.current) void state.action({ action: 'tickets-cancel', requestId: ticketRequest.current }).catch(() => {});
      }, [sessionId]);
      const listPending = ticketListBusy || ticketList?.status === 'loading';

      const changes = snapshot?.changes || [];
      const change = !creating && changes.find(({ id }) => id === snapshot?.selectedChange);
      const ticketChoices = [...changes.map(item => ({ target: 'changes/' + item.id, label: item.id === change?.id ? 'Текущее изменение' : 'Изменение · ' + item.id })), ...(snapshot?.specs || []).map(item => ({ target: item.path, label: 'Основная спецификация · ' + item.id }))];
      const linkTarget = ticketChoices.some(item => item.target === ticketTarget) ? ticketTarget : change ? 'changes/' + change.id : '';
      const linkDraft = ticketEdits[linkTarget];
      const linkedTicket = snapshot?.tickets?.links?.[linkTarget] || '';
      // Derive row markers from the fresh snapshot after link/unlink, without another MCP read.
      const ticketRows = (ticketList?.issues || []).map(issue => ({ ...issue,
        linkedTargets: Object.entries(snapshot?.tickets?.links || {}).filter(([, saved]) => saved === issue.ticket).map(([target]) => target)
      }));
      const activeTarget = React.useRef('');
      activeTarget.current = `${snapshot?.sessionId || ''}:${change?.id || ''}`;
      const readGeneration = React.useRef(0);
      const reviewed = React.useRef(new Set());
      const workflow = snapshot?.workflow || change?.workflow || {};
      const audit = workflow.audit || {};
      const exploreEnabled = snapshot?.exploreEnabled === true || snapshot?.settings?.OPENSPEC_EXPLORE === 'true';
      const artifactChoices = change ? [
        { id: 'proposal', label: 'Постановка', stage: 'requirements', path: `changes/${change.id}/proposal.md`, available: change.artifacts?.some(item => item.id === 'proposal' && item.status === 'done') },
        ...(change.specArtifacts || []).map(entry => ({ id: `spec-${entry.id}`, label: entry.id, stage: 'requirements', path: entry.path, available: true })),
        { id: 'design', label: 'Технические детали', stage: 'design', path: `changes/${change.id}/design.md`, available: change.artifacts?.some(item => item.id === 'design' && item.status === 'done') },
        { id: 'tasks', label: 'Текст tasks.md', stage: 'development', path: `changes/${change.id}/tasks.md`, available: change.artifacts?.some(item => item.id === 'tasks' && item.status === 'done') }
      ] : [];
      const stageDocuments = artifactChoices.filter(item => item.stage === stage);
      const requirementDocuments = artifactChoices.filter(item => item.id.startsWith('spec-'));
      const defaultArtifact = stage === 'requirements'
        ? documentTab === 'requirements' ? (requirementDocuments.find(item => item.path === requirementsPath) || requirementDocuments[0])?.path || '' : stageDocuments.find(item => item.id === 'proposal' && item.available)?.path || ''
        : stageDocuments.find(item => item.available)?.path || '';
      const draft = drafts[artifactPath];
      const dirty = !!page && !!draft && draft.text !== page.text;
      const unsavedChange = change && Object.keys(drafts).some(path => path.startsWith(`changes/${change.id}/`));
      const editable = page && !page.missing && page.nextOffsetBytes == null;
      const documentText = draft?.text ?? page?.text ?? '';
      const aiDraft = aiDrafts[artifactPath];
      const icon = kind => h(OpenSpecActionIcon, { kind });
      const button = (label, kind, onClick, props = {}) => h('button', { type: 'button', className: 'dsh1c-button dsh1c-secondary', disabled: busy, onClick, ...props }, icon(kind), label);

      const readArtifact = React.useCallback(async (path, append = false) => {
        if (!path) { setArtifactPath(''); setPage(null); return; }
        const target = activeTarget.current, request = ++readGeneration.current;
        setBusy(true); state.setError(null); setArtifactPath(path); setSelection(''); selectionRef.current = null;
        if (!append) setPage(null);
        try {
          const offset = append && page?.path === path ? page.nextOffsetBytes : 0;
          const response = await fetch(`${OPENSPEC_READ_API}?sessionId=${encodeURIComponent(snapshot?.sessionId || '')}&path=${encodeURIComponent(path)}&offset=${offset || 0}&limit=32768`, { headers: { accept: 'application/json' } });
          const body = await response.json();
          if (target !== activeTarget.current || request !== readGeneration.current) return;
          if (!response.ok || !body.ok) throw new Error(openSpecErrorMessage(body.message || body.error ? body : `HTTP ${response.status}`));
          if (append && page?.path === path && body.version !== page.version) throw new Error('Документ изменился во время чтения. Перечитайте файл.');
          setPage(append && page?.path === path ? { ...body, text: `${page.text}${body.text}` } : body);
        } catch (reason) {
          if (target === activeTarget.current && request === readGeneration.current) state.setError(openSpecErrorMessage(reason));
        } finally { if (request === readGeneration.current) setBusy(false); }
      }, [page, snapshot?.sessionId]);

      React.useEffect(() => {
        readGeneration.current += 1;
        setArtifactPath(''); setPage(null); setSelection(''); selectionRef.current = null; setTaskView('list'); setTransition(null); setExploreOpen(false);
        setStage(['requirements', 'design', 'development', 'archive'].includes(workflow.stage) ? workflow.stage : 'requirements');
      }, [snapshot?.sessionId, change?.id, workflow.stage]);
      React.useEffect(() => {
        if (!draftProject) return;
        draftOwner.current = { root: draftProject, restoring: true };
        setDrafts(readProjectDrafts(draftProject));
      }, [draftProject]);
      React.useEffect(() => {
        if (!draftProject || draftOwner.current.root !== draftProject) return;
        if (draftOwner.current.restoring) { draftOwner.current.restoring = false; return; }
        if (!rememberProjectDrafts(draftProject, drafts)) setNotice('Слишком много проектов с несохранёнными черновиками. Сохраните или скопируйте текущую правку перед закрытием панели.');
      }, [draftProject, drafts]);
      React.useEffect(() => {
        setAiDrafts(openSpecAiDrafts.get(snapshot?.sessionId) || {}); setAiOpenPath(''); setCreating(false); setDescription(''); setExplored(false); setExploreTopic(''); setExploreOpen(false);
      }, [snapshot?.sessionId]);
      React.useEffect(() => {
        if (!snapshot?.sessionId) return;
        if (Object.keys(aiDrafts).length) openSpecAiDrafts.set(snapshot.sessionId, aiDrafts);
        else openSpecAiDrafts.delete(snapshot.sessionId);
      }, [aiDrafts]);
      React.useEffect(() => {
        if (!change || workflow.stage !== 'requirements') return;
        const requirement = requirementDocuments.find(item => item.path === workflow.path);
        setDocumentTab(requirement ? 'requirements' : 'proposal');
        if (requirement) setRequirementsPath(requirement.path);
      }, [snapshot?.sessionId, change?.id, workflow.path, workflow.stage]);
      React.useEffect(() => { setFocusedDocumentTab(documentTab); }, [documentTab, change?.id]);
      React.useEffect(() => {
        const dialog = transitionRef.current;
        if (!transition || !dialog) return;
        if (!dialog.open) dialog.showModal?.();
        // R197 OS-18: showModal ставит фокус на «Закрыть»; начальный фокус — на основное безопасное действие.
        dialog.querySelector?.('[data-initial-focus]')?.focus?.();
        return () => { dialog.close?.(); transitionTrigger.current?.focus?.(); };
      }, [!!transition]);
      React.useEffect(() => {
        // R197 OS-9: меню «Ещё» и меню задач закрываются кликом вне меню и по Escape.
        const doc = globalThis.document;
        if (!doc?.addEventListener) return;
        const openMenus = () => Array.from(doc.querySelectorAll('.dsh1c-openspec-panel details.dsh1c-spec-menu[open]'));
        const onPointer = event => { for (const menu of openMenus()) if (!menu.contains(event.target)) menu.removeAttribute('open'); };
        const onKey = event => {
          if (event.key !== 'Escape') return;
          const menus = openMenus();
          if (!menus.length) return;
          event.preventDefault(); event.stopPropagation();
          for (const menu of menus) { const focused = menu.contains(doc.activeElement); menu.removeAttribute('open'); if (focused) menu.querySelector('summary')?.focus?.(); }
        };
        doc.addEventListener('pointerdown', onPointer, true); doc.addEventListener('keydown', onKey, true);
        return () => { doc.removeEventListener('pointerdown', onPointer, true); doc.removeEventListener('keydown', onKey, true); };
      }, []);
      React.useEffect(() => {
        if (!change || compact || (workflow.stage && workflow.stage !== stage && workflow.stage !== 'explore')) return;
        if (defaultArtifact) void readArtifact(defaultArtifact);
        else { setArtifactPath(''); setPage(null); }
      }, [snapshot?.sessionId, change?.id, stage, defaultArtifact, compact]);
      React.useEffect(() => {
        if (!change || change.workflow?.invalid || !['requirements', 'design'].includes(stage) || !defaultArtifact || (workflow.stage && workflow.stage !== stage && workflow.stage !== 'explore')) return;
        const key = `${snapshot.sessionId}:${change.id}:${stage}`;
        if (reviewed.current.has(key) || audit[stage]?.reviewedAt) return;
        reviewed.current.add(key);
        state.action({ action: 'review', change: change.id, stage }).then(() => state.load({ silent: true })).catch(reason => {
          reviewed.current.delete(key); state.setError(openSpecErrorMessage(reason));
        });
      }, [snapshot?.sessionId, change?.id, stage, defaultArtifact]);

      const runAction = async (input, successText = result => result.statusRu) => {
        const target = activeTarget.current;
        setBusy(true); state.setError(null); setNotice('');
        try {
          const result = await state.action(input);
          if (target !== activeTarget.current) return result;
          setNotice(successText(result) ?? 'Сохранено.');
          await state.load({ silent: true });
          if (input.action === 'workflow') {
            globalThis.document?.dispatchEvent?.(new Event('dsh1c-quality-changed'));
            if (input.workflow === 'propose') {
              if (result.workflow === 'explore') setExplored(true);
              else { setCreating(false); setDescription(''); setExplored(false); }
            }
          }
          if (input.action === 'task' && artifactPath.endsWith('/tasks.md') && !dirty) await readArtifact(artifactPath);
          return result;
        } catch (reason) {
          const conflict = /REVISION_CONFLICT|VERSION_CONFLICT/.test(`${reason?.code || ''} ${reason?.message || ''}`);
          const message = conflict && input.action === 'ticket' ? 'Связь изменилась после чтения. Ваш ввод сохранён. Перечитайте связь и согласуйте правку.' : conflict ? 'Файл изменился на диске. Ваш черновик сохранён в панели; сравните изменения или перечитайте файл перед повторным сохранением.' : openSpecErrorMessage(reason);
          if (target === activeTarget.current) state.setError(message);
          // R197 OS-8: после конфликта сохранения блок «сравнить» появляется сразу, без «Перечитать файлы».
          if (target === activeTarget.current && conflict && input.action === 'write' && input.path === artifactPath) void readArtifact(artifactPath).then(() => state.setError(message));
          return null;
        } finally { setBusy(false); }
      };
      const loadTickets = async (mode = 'url') => {
        setTicketListBusy(true); setTicketListError('');
        try {
          let persistedSource = sourceConfig;
          if (sourceDraft) {
            persistedSource = await state.action({ action: 'ticket-source', url: sourceConfig.url || '', jql: sourceConfig.jql || '', server: ticketServer, cloudId: ticketSite, expectedRevision: sourceConfig.revision ?? null });
          }
          const result = await state.action({ action: 'tickets-list', mode, url: sourceConfig.url || '', jql: sourceConfig.jql || '', server: ticketServer || undefined, cloudId: ticketSite || undefined });
          setTicketList(result); setTicketSelected([]);
          if (result.server && result.server !== ticketServer || result.cloudId && result.cloudId !== ticketSite) setSourceDraft({ ...persistedSource, ...(result.server ? { server: result.server } : {}), ...(result.cloudId ? { cloudId: result.cloudId } : {}) });
          else setSourceDraft(null);
          await state.load({ silent: true });
        } catch (reason) { setTicketListError(openSpecErrorMessage(reason)); }
        finally { setTicketListBusy(false); }
      };
      const createTickets = async (tickets, source, allLoaded = false) => {
        const result = await runAction({ action: 'tickets-create', tickets, ...(source ? { source } : {}), ...(allLoaded ? { allLoaded: true } : {}) });
        if (result?.sent) setTicketSelected([]);
      };
      const linkTicket = ticket => runAction({ action: 'ticket', target: linkTarget, ticket, expectedRevision: snapshot?.tickets?.revision ?? null });
      const navigate = async (nextStage, path, nextTab) => {
        // An absent requirements document is an empty tab, not a request for proposal.md.
        if (nextStage === 'requirements' && nextTab === 'requirements' && !path) {
          readGeneration.current += 1; setDocumentTab('requirements'); setArtifactPath(''); setPage(null); setSelection(''); selectionRef.current = null; return;
        }
        const nextPath = path || artifactChoices.find(item => item.stage === nextStage && item.available)?.path || null;
        const result = await runAction({ action: 'stage', change: change.id, stage: nextStage, path: nextPath, selection: '' }, () => '');
        if (!result) return;
        setStage(nextStage); setTaskView('list'); setSelection('');
        selectionRef.current = null;
        if (nextStage === 'requirements') {
          const requirement = requirementDocuments.find(item => item.path === nextPath);
          setDocumentTab(requirement ? 'requirements' : 'proposal');
          if (requirement) setRequirementsPath(requirement.path);
        }
      };
      const requestStage = (nextStage, event) => {
        const order = ['requirements', 'design', 'development', 'archive'];
        const missing = order.indexOf(nextStage) > order.indexOf(stage)
          ? ['requirements', 'design'].filter(key => order.indexOf(key) < order.indexOf(nextStage) && !audit[key]?.approvedAt) : [];
        if (!missing.length) { void navigate(nextStage); return; }
        transitionTrigger.current = event?.currentTarget || globalThis.document?.activeElement;
        setTransition({ stage: nextStage, missing }); state.setError(null);
      };
      const keepTransitionFocus = event => {
        if (event.key !== 'Tab') return;
        const dialog = event.currentTarget;
        const controls = Array.from(dialog.querySelectorAll('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'))
          .filter(element => !element.disabled && element.tabIndex >= 0 && element.getClientRects().length > 0);
        const active = dialog.ownerDocument.activeElement;
        if (!controls.length) { event.preventDefault(); dialog.focus(); return; }
        if (event.shiftKey ? active === controls[0] || !controls.includes(active) : active === controls[controls.length - 1] || !controls.includes(active)) {
          event.preventDefault(); (event.shiftKey ? controls[controls.length - 1] : controls[0]).focus();
        }
      };
      const saveChangeDrafts = async () => {
        for (const [path, value] of Object.entries(drafts).filter(([path]) => path.startsWith(`changes/${change.id}/`))) {
          const result = await runAction({ action: 'write', path, content: value.text, expectedVersion: value.version }, () => 'Документ сохранён.');
          if (!result) return false;
          setDrafts(current => { const next = { ...current }; delete next[path]; return next; });
          if (path === artifactPath) setPage(result);
        }
        return true;
      };
      const approveTransition = async () => {
        if (!await saveChangeDrafts()) return;
        const result = await runAction({ action: 'approve', change: change.id, stage: transition.missing.length > 1 ? 'all' : transition.missing[0] });
        if (result) { const nextStage = transition.stage; setTransition(null); await navigate(nextStage); }
      };
      const approveAndNext = async () => {
        if (!await saveChangeDrafts()) return;
        const result = await runAction({ action: 'approve', change: change.id, stage });
        if (result) await navigate(stage === 'requirements' ? 'design' : 'development');
      };
      // R197 OS-4/OS-11: подтверждения во внутреннем диалоге панели (тот же dialog, что и переход этапов).
      const askConfirm = confirm => {
        const active = globalThis.document?.activeElement;
        transitionTrigger.current = active?.closest?.('details')?.querySelector?.('summary') || active;
        setTransition({ confirm }); state.setError(null);
      };
      const confirmTransition = async () => { const run = transition.confirm.run; setTransition(null); await run(); };
      const confirmArchive = () => askConfirm({ title: 'Архивировать спецификацию?', text: `Агент текущего чата проверит готовность «${change.id}» и перенесёт её в архив командой /opsx-archive. Тип задачи — «Полный цикл»; режим доступа сохранится.`, label: 'Перенести в архив', icon: 'archive', run: () => runAction({ action: 'workflow', workflow: 'archive', change: change.id }) });
      const beginNew = async () => {
        const previous = change?.id || '';
        const result = await runAction({ action: 'select', change: null }, () => '');
        if (!result) return;
        previousChange.current = previous;
        readGeneration.current += 1; setCreating(true); setDescription(''); setNewTicket(''); setReadDescription(true); setPane('specs'); setExplored(false); setResearchFirst(exploreEnabled); setExploreTopic(''); setExploreOpen(false);
        setArtifactPath(''); setPage(null); setSelection(''); selectionRef.current = null; setAiOpenPath(''); setTransition(null); setDocumentTab('proposal'); setRequirementsPath(''); setNotice(''); setStage('requirements'); setTaskView('list');
        // Черновики отбрасываются только после подтверждения; поле ввода чата не очищается.
        if (previous) { setDrafts({}); setAiDrafts({}); }
      };
      const startNew = async () => {
        setPane('specs');
        // Повторный клик при открытой форме не стирает введённое описание.
        if (creating) { globalThis.document?.getElementById?.('dsh1c-openspec-description')?.focus?.(); return; }
        const pending = [...Object.keys(drafts), ...Object.entries(aiDrafts).filter(([, item]) => item?.instruction?.trim() && !item.delivered).map(([path]) => `неотправленная ИИ-правка ${path.replace(/^changes\//, '')}`)];
        if (change && pending.length) {
          askConfirm({ title: 'Отбросить несохранённые правки?', text: `Не сохранено: ${pending.map(path => path.replace(/^changes\//, '')).join(', ')}. Новая спецификация очистит выбор и эти черновики. Файлы на диске, текущий чат и поле ввода не изменятся.`, label: 'Отбросить и создать', icon: 'plus', run: beginNew });
          return;
        }
        await beginNew();
      };
      // «Закрыть» формы создания возвращает прежнюю выбранную спецификацию.
      const closeNew = async () => {
        const previous = previousChange.current;
        previousChange.current = ''; setCreating(false);
        if (previous && changes.some(item => item.id === previous)) await runAction({ action: 'select', change: previous }, () => '');
      };
      const closeAiEdit = () => {
        setAiOpenPath('');
        // R197 OS-18: фокус возвращается к кнопке «ИИ-правка», а не на <body>.
        const target = aiTrigger.current && !aiTrigger.current.disabled ? aiTrigger.current : editorRef.current;
        target?.focus?.();
      };
      const refresh = async () => {
        await state.load({ silent: true });
        if (artifactPath) await readArtifact(artifactPath);
        if (dirty) setNotice('Файл перечитан. Несохранённый черновик оставлен в редакторе; сохранение проверит исходную версию.');
      };
      const saveDocument = async (useCurrentVersion = false) => {
        const result = await runAction({ action: 'write', path: artifactPath, content: documentText, expectedVersion: useCurrentVersion ? page?.version ?? page?.revision : draft?.version ?? page?.version ?? page?.revision }, () => 'Документ сохранён.');
        if (result) { setDrafts(current => { const next = { ...current }; delete next[artifactPath]; return next; }); await readArtifact(artifactPath); }
        return result;
      };
      const captureSelection = (event, allowEmpty = true) => {
        const editor = event?.currentTarget;
        if (!editor || typeof editor.value !== 'string') return;
        const start = editor.selectionStart, end = editor.selectionEnd;
        if (!Number.isInteger(start) || !Number.isInteger(end)) return;
        if (end > start || allowEmpty || selectionRef.current?.path !== artifactPath) {
          const text = editor.value.slice(start, end);
          selectionRef.current = { path: artifactPath, start, end, text }; setSelection(text);
        }
      };
      const openAiEdit = () => {
        const position = selectionRef.current?.path === artifactPath ? selectionRef.current : null;
        const fragment = position?.text ? position : null;
        const cursorOffset = position?.start ?? 0;
        const line = documentText.replace(/\r\n?/g, '\n').slice(0, cursorOffset).split('\n').length;
        setAiDrafts(current => ({ ...current, [artifactPath]: { ...current[artifactPath], scope: fragment ? 'selection' : 'file', fragment, cursorOffset, line, instruction: current[artifactPath]?.instruction || '', error: '', delivered: false } }));
        setAiOpenPath(artifactPath);
      };
      const updateAiDraft = patch => setAiDrafts(current => ({ ...current, [artifactPath]: { ...current[artifactPath], ...patch } }));
      const sendAiEdit = async event => {
        event.preventDefault();
        const request = aiDrafts[artifactPath];
        if (!request?.instruction?.trim()) return;
        const normalizedText = documentText.replace(/\r\n?/g, '\n');
        if (request.scope === 'selection' && (!request.fragment || request.fragment.text.length > 8192 || normalizedText.slice(request.fragment.start, request.fragment.end) !== request.fragment.text)) {
          updateAiDraft({ error: 'Фрагмент изменился или превышает 8192 символа. Выделите нужный текст заново и откройте ИИ-правку.' }); return;
        }
        setBusy(true); updateAiDraft({ error: '', delivered: false });
        try {
          let version = draft?.version ?? page?.version ?? page?.revision;
          if (dirty) {
            const saved = await state.action({ action: 'write', path: artifactPath, content: documentText, expectedVersion: version });
            version = saved.version ?? saved.revision;
            setDrafts(current => { const next = { ...current }; delete next[artifactPath]; return next; });
            setPage(saved);
          }
          const result = await state.action({ action: 'ai-edit', change: change.id, path: artifactPath, expectedVersion: version, instruction: request.instruction.trim(), scope: request.scope, cursorOffset: request.cursorOffset,
            ...(request.scope === 'selection' ? { selectionStart: request.fragment.start, selectionEnd: request.fragment.end } : {}) });
          if (!result.sent) throw new Error(result.statusRu || 'Не удалось передать правку в текущий чат.');
          // R197 OS-14: одно уведомление панели; отправленная форма закрывается.
          updateAiDraft({ delivered: true, instruction: '' }); closeAiEdit();
          setNotice(result.statusRu || 'Запрос на правку передан в текущий чат. Дождитесь ответа агента.');
        } catch (reason) {
          updateAiDraft({ error: /REVISION_CONFLICT|VERSION_CONFLICT/.test(`${reason?.code || ''} ${reason?.message || ''}`) ? 'Документ изменился на диске. Правка не отправлена; ваш текст сохранён. Перечитайте документ и выберите актуальный фрагмент.' : openSpecErrorMessage(reason) });
        } finally { setBusy(false); }
      };
      const renderError = message => h('div', { className: 'dsh1c-spec-feedback', role: 'alert' }, icon('notice'), h('span', null, openSpecErrorMessage(message)));
      const messages = h(React.Fragment, null,
        state.error ? renderError(state.error) : null,
        notice ? h('p', { className: 'dsh1c-status', role: 'status' }, notice) : null);
      if (state.loading && !snapshot) return h('section', { className: 'dsh1c-panel', 'aria-busy': true }, h('p', null, 'Читаю спецификации проекта…'));
      if (snapshot?.enabled === false) return h('section', { className: 'dsh1c-panel' }, h('h2', null, 'OpenSpec'), h('p', null, 'Плагин OpenSpec отключён для этого чата. Включите его в настройках проекта и начните новый чат.'));
      if (!snapshot) return h('section', { className: 'dsh1c-panel' }, messages, button('Повторить загрузку', 'refresh', () => state.load()));
      const stageLabels = [['requirements', 'Постановка'], ['design', 'Технические детали'], ['development', 'Разработка'], ['archive', 'Архив']];
      const tasks = change?.taskItems || Object.values(change?.board?.columns || {}).flat().sort((a, b) => String(a.id).localeCompare(String(b.id), 'ru', { numeric: true }));
      const statusLabels = { pending: 'Ожидает', 'in-progress': 'В работе', done: 'Выполнено', blocked: 'Заблокировано', cancelled: 'Отменено' };
      const setTaskStatus = (task, status) => runAction({ action: 'task', change: change.id, taskId: task.id, status, revision: change.tasksRevision, manual: true });
      const closeMenu = action => event => { event.currentTarget.closest?.('details')?.removeAttribute('open'); void action(); };
      const renderTask = task => h('li', { className: 'dsh1c-spec-task', 'data-status': task.status, key: task.id },
        h('span', { className: 'dsh1c-spec-task-mark', 'aria-hidden': true }, icon(task.status === 'done' ? 'check' : task.status === 'cancelled' ? 'close' : task.status === 'in-progress' ? 'play' : 'file')),
        h('div', { className: 'dsh1c-spec-task-content' }, h('span', { className: 'dsh1c-spec-task-title' }, `${task.id} ${task.title}`),
          h('span', { className: 'dsh1c-status' }, statusLabels[task.status] || task.status, task.manual ? ' · вручную' : ''),
          task.evidence ? h('p', { className: 'dsh1c-status' }, `Проверка: ${task.evidence}`) : null),
        h('details', { className: 'dsh1c-spec-menu' }, h('summary', { 'aria-label': `Действия задачи ${task.id}`, title: 'Изменить статус вручную' }, icon('more')),
          h('div', { className: 'dsh1c-spec-menu-items' },
            task.status !== 'done' ? button('Выполнено вручную', 'check', closeMenu(() => setTaskStatus(task, 'done'))) : null,
            task.status !== 'cancelled' ? button('Отменить задачу', 'close', closeMenu(() => setTaskStatus(task, 'cancelled'))) : null,
            task.status !== 'pending' ? button('Вернуть в ожидание', 'refresh', closeMenu(() => setTaskStatus(task, 'pending'))) : null,
            task.requirement?.path ? button('Открыть требование', 'file', closeMenu(() => navigate('requirements', task.requirement.path))) : null)));
      const showEditor = change && !compact && stage !== 'archive' && (stage !== 'development' || taskView === 'text');
      const auditLine = (key, label) => {
        const item = audit[key];
        if (!item?.reviewedAt && !item?.approvedAt) return h('p', { key, className: 'dsh1c-status' }, `${label}: ещё не утверждено`);
        const stamp = (who, when) => `${who || 'Пользователь'} · ${new Date(when).toLocaleString('ru-RU')}`;
        return h('p', { key, className: 'dsh1c-status' }, label, ': ', item.reviewedAt ? `просмотрено ${stamp(item.reviewedBy, item.reviewedAt)}` : '', item.approvedAt ? `; утверждено ${stamp(item.approvedBy, item.approvedAt)}` : '; ещё не утверждено');
      };
      const targetPicker = h('div', { className: 'dsh1c-field' },
        h('label', { htmlFor: 'dsh1c-openspec-ticket-target' }, 'Спецификация для привязки'),
        h('select', { id: 'dsh1c-openspec-ticket-target', value: linkTarget, disabled: busy, onChange: event => setTicketTarget(event.target.value) }, h('option', { value: '', disabled: true }, 'Выберите спецификацию для привязки…'), ...ticketChoices.map(item => h('option', { key: item.target, value: item.target }, item.label))),
        h('p', { className: 'dsh1c-status' }, linkedTicket ? 'Текущая связь: ' + linkedTicket : linkTarget ? 'У выбранной спецификации пока нет тикета.' : 'Выберите изменение или основную спецификацию.'));
      return h('section', { className: 'dsh1c-panel dsh1c-openspec-panel', 'aria-label': 'Спецификации OpenSpec', 'aria-busy': busy },
        h('div', { className: 'dsh1c-openspec-heading' }, h('h2', null, 'OpenSpec'), button('Создать новую', 'plus', startNew, { 'aria-expanded': creating })),
        h('div', { className: 'dsh1c-spec-tabs', role: 'tablist', 'aria-label': 'Раздел OpenSpec' }, ...[['specs', 'Спецификации']].map(([key, label]) => button(label, key === 'specs' ? 'file' : 'list', () => setPane(key), {
          id: 'dsh1c-tab-' + key, key, role: 'tab', style: pane === key ? { fontWeight: 650, boxShadow: 'inset 0 -2px currentColor' } : undefined, 'aria-selected': pane === key, 'aria-controls': key === 'specs' ? 'dsh1c-spec-pane' : 'dsh1c-ticket-pane', tabIndex: pane === key ? 0 : -1,
          onKeyDown: event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); setPane('specs'); globalThis.document?.getElementById?.('dsh1c-tab-specs')?.focus?.(); }
        }))),
        pane === 'tickets' ? h('section', { id: 'dsh1c-ticket-pane', role: 'tabpanel', 'aria-labelledby': 'dsh1c-tab-tickets', className: 'dsh1c-field' },
          h('p', { className: 'dsh1c-status' }, 'Источник списка для этого проекта. Загрузка тикетов — только по кнопке.'),
          h('label', { htmlFor: 'dsh1c-ticket-source-url' }, 'Ссылка на список или фильтр тикетов'),
          h('input', { id: 'dsh1c-ticket-source-url', type: 'text', value: sourceConfig.url || '', maxLength: 2048, placeholder: 'https://team.atlassian.net/issues/?filter=123', onChange: event => editSource({ url: event.target.value }) }),
          h('p', { className: 'dsh1c-status' }, 'Общая настройка тикет-системы проекта. URL любой системы читается текущей моделью без Atlassian MCP. JQL нужен только для отдельной загрузки через Jira MCP.'),
          h('label', { htmlFor: 'dsh1c-ticket-jql' }, 'Фильтр Jira (JQL, необязательно)'),
          h('textarea', { id: 'dsh1c-ticket-jql', value: sourceConfig.jql || '', maxLength: 2048, rows: 2, placeholder: 'Из ссылки; без ссылки — statusCategory != Done ORDER BY updated DESC', onChange: event => editSource({ jql: event.target.value }) }),
          h('p', { className: 'dsh1c-status' }, 'Для «Через Jira MCP»: явный JQL или Jira-фильтр из ссылки. Настройки подключения и авторизации — в Atlassian/MCP.'),
          h('label', { htmlFor: 'dsh1c-ticket-server' }, 'MCP-сервер'),
          h('select', { id: 'dsh1c-ticket-server', value: ticketServer, onChange: event => editSource({ server: event.target.value, cloudId: '' }) }, h('option', { value: '' }, 'Определить при загрузке'), ...Array.from(new Set([ticketServer, ...(ticketList?.providers || []).map(item => item.server)].filter(Boolean))).map(server => h('option', { key: server, value: server }, server))),
          ticketSite || ticketList?.sites?.length ? h(React.Fragment, null, h('label', { htmlFor: 'dsh1c-ticket-site' }, 'Сайт Jira'),
            h('select', { id: 'dsh1c-ticket-site', value: ticketSite, onChange: event => editSource({ cloudId: event.target.value }) }, h('option', { value: '' }, 'Определить при загрузке'), ...(ticketSite && !(ticketList?.sites || []).some(site => site.id === ticketSite) ? [h('option', { key: ticketSite, value: ticketSite }, ticketSite)] : []), ...(ticketList?.sites || []).map(site => h('option', { key: site.id, value: site.id }, site.name)))) : null,
          snapshot?.ticketSource?.invalid ? renderError(snapshot.ticketSource.warningRu) : null,
          h('div', { className: 'dsh1c-actions' },
            button('Сохранить источник', 'save', async () => { const result = await runAction({ action: 'ticket-source', url: sourceConfig.url || '', jql: sourceConfig.jql || '', server: ticketServer, cloudId: ticketSite, expectedRevision: sourceConfig.revision ?? null }); if (result) setSourceDraft(null); }, { disabled: busy || !!snapshot?.ticketSource?.invalid }),
            sourceDraft ? button('Перечитать источник', 'refresh', () => { setSourceDraft(null); void state.load({ silent: true }); }) : null,
            button(listPending ? 'Модель читает список…' : 'Загрузить тикеты по ссылке', 'refresh', () => loadTickets('url'), { disabled: busy || listPending || !sourceConfig.url?.trim() }),
            button('Через Jira MCP', 'refresh', () => loadTickets('mcp'), { disabled: busy || listPending }),
            listPending ? button('Отменить загрузку', 'close', async () => { await state.action({ action: 'tickets-cancel', requestId: ticketList?.requestId }); setTicketList(null); }) : null),
          h('p', { className: 'dsh1c-status', role: 'status' }, 'До 50 тикетов за запрос · до 10 выбранных за запуск, либо все загруженные (до 50).'),
          ticketListError ? h('p', { className: 'dsh1c-spec-feedback', role: 'alert' }, ticketListError) : null,
          ticketList?.statusRu ? h('p', { className: 'dsh1c-status', role: 'status' }, ticketList.statusRu) : null,
          ticketList?.truncated ? h('p', { className: 'dsh1c-status', role: 'status' }, 'Полнота списка не подтверждена либо получена часть результатов. «Все загруженные» охватывает только показанные строки.') : null,
          ticketRows.length ? h(React.Fragment, null,
            h('p', { className: 'dsh1c-status' }, ticketList.mode === 'url' ? 'Источник: ' + ticketList.sourceUrl : 'Загружено по JQL: ' + (ticketList.jql || 'указанному фильтру')),
            h('ul', { className: 'dsh1c-spec-ticket-list' }, ...ticketRows.map(issue => h('li', { key: issue.ticket },
              h('label', null, h('input', { type: 'checkbox', checked: ticketSelected.includes(issue.ticket), disabled: busy || ticketListBusy || !ticketSelected.includes(issue.ticket) && ticketSelected.length >= 10,
                onChange: event => setTicketSelected(current => event.target.checked ? [...current, issue.ticket] : current.filter(value => value !== issue.ticket)) }),
                h('span', null, h('strong', null, issue.key), ' · ' + issue.summary, issue.status ? ' · ' + issue.status : '', issue.linkedTargets?.length ? h('small', null, 'Уже связан: ' + issue.linkedTargets.join(', ') + '. При создании будет пропущен.') : null))))),
            h('div', { className: 'dsh1c-actions' },
              button('Создать выбранные (' + ticketSelected.length + ')', 'plus', () => createTickets(ticketSelected, ticketList.server ? { server: ticketList.server, ...(ticketList.cloudId ? { cloudId: ticketList.cloudId } : {}) } : null), { disabled: busy || !ticketSelected.length || ticketListBusy || !!ticketListError }),
              button('Создать по всем загруженным (' + ticketRows.length + ')', 'plus', () => createTickets(ticketRows.map(issue => issue.ticket), ticketList.server ? { server: ticketList.server, ...(ticketList.cloudId ? { cloudId: ticketList.cloudId } : {}) } : null, true), { disabled: busy || ticketListBusy || !!ticketListError })),
            h('details', { className: 'dsh1c-spec-extra' }, h('summary', null, 'Привязать к существующей спецификации'), targetPicker,
              button('Привязать выбранный', 'check', () => linkTicket(ticketSelected[0]), { disabled: busy || ticketSelected.length !== 1 || !linkTarget || !!snapshot?.tickets?.invalid, title: 'Выберите один тикет и спецификацию для привязки' }))) : null,
          messages) : null,
        pane === 'specs' ? h('div', { id: 'dsh1c-spec-pane', role: 'tabpanel', 'aria-labelledby': 'dsh1c-tab-specs' },
        exploreOpen && change ? h('form', { id: 'dsh1c-spec-explore-form', className: 'dsh1c-spec-create dsh1c-field', onSubmit: async event => { event.preventDefault(); const result = await runAction({ action: 'workflow', workflow: 'explore', description: exploreTopic, ...(change ? { change: change.id } : {}) }); if (result) { setExploreOpen(false); setExploreTopic(''); } } },
          h('strong', null, 'Исследовать вопрос по спецификации'),
          h('p', { className: 'dsh1c-status' }, `Спецификация: ${change.id} · ${stageLabels.find(([key]) => key === stage)?.[1] || 'Текущий этап'}`),
          h('label', { htmlFor: 'dsh1c-openspec-explore' }, 'Что нужно исследовать?'),
          h('textarea', { id: 'dsh1c-openspec-explore', value: exploreTopic, required: true, maxLength: 4000, rows: 2, autoFocus: true, placeholder: 'Идея, вопрос или требование для уточнения', onChange: event => setExploreTopic(event.target.value), 'aria-describedby': 'dsh1c-spec-explore-help' }),
          h('p', { id: 'dsh1c-spec-explore-help', className: 'dsh1c-status' }, 'Уточните требования или техническое решение в текущем чате. Исследование не меняет и не утверждает документы; выбранная спецификация и этап сохраняются.'),
          h('div', { className: 'dsh1c-actions' }, button('Начать исследование', 'search', undefined, { type: 'submit', disabled: busy || !exploreTopic.trim() }), button('Закрыть исследование', 'close', () => setExploreOpen(false)))) : null,
        creating ? h('form', { id: 'dsh1c-spec-create-form', className: 'dsh1c-spec-create dsh1c-field', onSubmit: async event => { event.preventDefault(); const research = researchFirst && !explored; const result = await runAction({ action: 'workflow', workflow: research ? 'explore' : 'propose', description, ticket: newTicket, readDescription, ...(ticketList?.mode === 'mcp' && ticketList.server ? { source: { server: ticketList.server, ...(ticketList.cloudId ? { cloudId: ticketList.cloudId } : {}) } } : {}), skipExplore: true }); if (research && result) setExplored(true); } },
          h('label', { htmlFor: 'dsh1c-new-ticket' }, 'Ссылка на тикет (необязательно)'),
          h('input', { id: 'dsh1c-new-ticket', type: 'text', value: newTicket, maxLength: 2048, placeholder: 'Полная ссылка или номер из загруженного списка', onChange: event => setNewTicket(event.target.value) }),
          newTicket.trim() ? h('label', { htmlFor: 'dsh1c-ticket-read-description' }, h('input', { id: 'dsh1c-ticket-read-description', type: 'checkbox', checked: readDescription, onChange: event => setReadDescription(event.target.checked) }), ' Получить описание из тикета') : null,
          h('label', { htmlFor: 'dsh1c-openspec-description' }, newTicket.trim() && readDescription ? 'Дополнительные указания (необязательно)' : 'Что нужно изменить?'),
          h('textarea', { id: 'dsh1c-openspec-description', value: description, required: !newTicket.trim() || !readDescription, maxLength: 4000, rows: 4, autoFocus: true, placeholder: 'Задача и ожидаемый результат', onChange: event => setDescription(event.target.value) }),
          h('p', { id: 'dsh1c-openspec-ticket-help', className: 'dsh1c-status' }, readDescription && newTicket.trim() ? 'Агент сначала прочитает полный тикет; если доступ закрыт, попросит содержание. Список тикетов не заменяет полное описание.' : 'Ручное описание используется без чтения тикета. Указанная ссылка будет сохранена в спецификации.'),
          !explored ? h(React.Fragment, null, h('label', { htmlFor: 'dsh1c-openspec-start-mode' }, 'С чего начать'),
            h('select', { id: 'dsh1c-openspec-start-mode', value: researchFirst ? 'explore' : 'propose', disabled: busy, onChange: event => setResearchFirst(event.target.value === 'explore') },
              h('option', { value: 'propose' }, 'Сразу подготовить постановку'), h('option', { value: 'explore' }, 'Сначала исследовать идею'))) : null,
          h('p', { className: 'dsh1c-status' }, explored ? 'Исследование отправлено в текущий чат. После обсуждения нажмите «Подготовить постановку»; автоматически она не создаётся.' : researchFirst ? 'Сначала обсудите идею в текущем чате без создания документов. После исследования можно подготовить постановку.' : 'Подготовим постановку в текущем чате. Тип задачи — «Спецификация».'),
          h('div', { className: 'dsh1c-actions' }, button(explored ? 'Подготовить постановку' : researchFirst ? 'Исследовать идею' : 'Создать спецификацию', explored || !researchFirst ? 'file' : 'search', undefined, { type: 'submit', className: 'dsh1c-button dsh1c-primary', disabled: busy || !(description.trim() || newTicket.trim() && readDescription) }), button('Закрыть', 'close', () => void closeNew()))) : null,
        !creating ? h('div', { className: 'dsh1c-field' }, h('label', { htmlFor: 'dsh1c-openspec-change' }, 'Спецификация'),
          h('select', { id: 'dsh1c-openspec-change', value: change?.id || '', disabled: busy || !changes.length, onChange: event => { if (event.target.value) void runAction({ action: 'select', change: event.target.value }); } },
            h('option', { value: '', disabled: true }, changes.length ? 'Выберите спецификацию…' : 'Активных спецификаций нет'), ...changes.map(item => h('option', { key: item.id, value: item.id }, item.id + (snapshot.tickets?.links?.['changes/' + item.id] ? ' · ' + snapshot.tickets.links['changes/' + item.id] : ''))))) : null,
        !creating && ticketChoices.length ? h('details', { className: 'dsh1c-spec-extra' },
          h('summary', null, icon('file'), 'Связь с тикетом', linkedTicket ? ' · ' + linkedTicket : ''),
          targetPicker,
          h('form', { id: 'dsh1c-spec-ticket-form', className: 'dsh1c-field', onSubmit: async event => {
            event.preventDefault();
            const result = await runAction({ action: 'ticket', target: linkTarget, ticket: linkDraft?.value ?? linkedTicket, expectedRevision: linkDraft ? linkDraft.revision : snapshot?.tickets?.revision ?? null });
            if (result) setTicketEdits(current => { const next = { ...current }; delete next[linkTarget]; return next; });
          } },
            h('label', { htmlFor: 'dsh1c-openspec-ticket-link' }, 'Тикет (пустое поле удаляет связь)'),
            h('input', { id: 'dsh1c-openspec-ticket-link', type: 'text', value: linkDraft?.value ?? linkedTicket, maxLength: 2048, placeholder: 'ABC-123 или ссылка', onChange: event => { const value = event.target.value; setTicketEdits(current => ({ ...current, [linkTarget]: { value, revision: current[linkTarget] ? current[linkTarget].revision : snapshot?.tickets?.revision ?? null } })); } }),
            /^https?:\/\//u.test(linkedTicket) ? h('a', { href: linkedTicket, target: '_blank', rel: 'noopener noreferrer' }, 'Открыть тикет') : null,
            snapshot?.tickets?.invalid ? h('p', { role: 'alert', className: 'dsh1c-status' }, snapshot.tickets.warningRu) : null,
            button('Сохранить связь', 'check', undefined, { type: 'submit', disabled: busy || !linkTarget || !!snapshot?.tickets?.invalid }),
            linkDraft ? button('Перечитать связь', 'refresh', () => { setTicketEdits(current => { const next = { ...current }; delete next[linkTarget]; return next; }); void state.load({ silent: true }); }) : null)) : null,
        change ? h(React.Fragment, null,
          h('div', { className: 'dsh1c-spec-primary-actions', role: 'group', 'aria-label': 'Действия спецификации' },
            button('Разработать', 'play', () => runAction({ action: 'workflow', workflow: 'apply', change: change.id }), { className: 'dsh1c-button dsh1c-primary', disabled: busy || unsavedChange, title: unsavedChange ? 'Сначала сохраните правки документов' : 'Запустить /opsx-apply в текущем чате без утверждения документов. Утвердить и разработать — в «Ещё». Тип задачи — Полный цикл.' }),
            button('Архивировать', 'archive', confirmArchive, { disabled: busy || unsavedChange }),
            h('details', { className: 'dsh1c-spec-menu' }, h('summary', { title: 'Дополнительные действия' }, icon('more'), 'Ещё'),
              h('div', { className: 'dsh1c-spec-menu-items' },
                button('Исследовать вопрос', 'search', closeMenu(() => setExploreOpen(true)), { 'aria-expanded': exploreOpen, 'aria-controls': 'dsh1c-spec-explore-form' }),
                button('Утвердить всё и разработать', 'check', closeMenu(async () => { if (await saveChangeDrafts()) await runAction({ action: 'workflow', workflow: 'apply', change: change.id, approveAll: true }); }), { disabled: busy, title: unsavedChange ? 'Сначала сохранить черновики с проверкой версии, затем утвердить постановку и технические детали и запустить /opsx-apply' : 'Утвердить постановку и технические детали, затем запустить /opsx-apply в текущем чате' }),
                button('Разработать все спецификации', 'list', closeMenu(() => askConfirm({ title: 'Разработать все спецификации?', text: `Агент текущего чата последовательно разработает все активные спецификации (${changes.length}): ${changes.map(item => item.id).join(', ')}. Тип задачи — «Полный цикл»; новые чаты не создаются, архивирование не запускается.`, label: 'Разработать все', icon: 'list', run: () => runAction({ action: 'workflow', workflow: 'apply-all' }) })), { disabled: busy || Object.keys(drafts).length > 0 }),
                button('Проверить структуру', 'check', closeMenu(() => runAction({ action: 'validate', change: change.id }, result => result.valid ? 'Структура документов корректна. Проверка кода не запускалась.' : result.state === 'timeout' ? 'Проверка структуры не завершилась вовремя. Повторите её позже.' : `В документах найдены ошибки структуры${(String(result.output || '').match(/\[(?:ERROR|WARNING)\]/g) || []).length ? ` (замечаний: ${String(result.output || '').match(/\[(?:ERROR|WARNING)\]/g).length})` : ''}. Полный вывод проверки — в «Сведения о спецификации» внизу панели.`))),
                button('Перечитать файлы', 'refresh', closeMenu(refresh))))),
          unsavedChange ? h('p', { className: 'dsh1c-status', role: 'status' }, 'Не сохранено: ', Object.keys(drafts).filter(path => path.startsWith(`changes/${change.id}/`)).map(path => path.replace(`changes/${change.id}/`, '')).join(', ')) : null,
          h('nav', { className: 'dsh1c-spec-stages', 'aria-label': 'Этапы спецификации' }, ...stageLabels.flatMap(([key, label], index) => [
            index ? h('span', { key: `arrow-${key}`, className: 'dsh1c-spec-stage-arrow' }, icon('arrow')) : null,
            h('button', { type: 'button', key, className: 'dsh1c-spec-stage', 'aria-current': stage === key ? 'step' : undefined, 'data-complete': !!audit[key]?.approvedAt, disabled: busy, onClick: event => requestStage(key, event), title: 'Открыть этап' },
              h('span', { className: 'dsh1c-spec-stage-number' }, audit[key]?.approvedAt ? icon('check') : index + 1), h('span', null, label))])),
          ['requirements', 'design'].includes(stage) ? h('div', { className: 'dsh1c-spec-approval dsh1c-spec-approval-top' },
            h('p', { className: 'dsh1c-status' }, audit[stage]?.approvedAt ? 'Утверждено. Первый просмотр и утверждение сохранены.' : stage === 'requirements' ? 'Общее описание и требования утверждаются вместе; после утверждения откроются технические детали.' : 'Технические детали ожидают утверждения; после утверждения откроется этап «Разработка», запуск — кнопкой «Разработать».'),
            button(stage === 'requirements' ? audit.requirements?.approvedAt ? 'К техническим деталям' : 'Утвердить постановку' : audit.design?.approvedAt ? 'К разработке' : 'Утвердить технические детали', 'check', audit[stage]?.approvedAt ? () => navigate(stage === 'requirements' ? 'design' : 'development') : approveAndNext,
              { className: `dsh1c-button ${audit[stage]?.approvedAt ? 'dsh1c-secondary' : 'dsh1c-spec-approve-button'}`, disabled: busy || !defaultArtifact || (!audit[stage]?.approvedAt && change.workflow?.invalid), title: unsavedChange ? 'Сначала сохранить черновики с проверкой версии, затем утвердить' : undefined })) : null,
          stage === 'development' ? h('p', { className: 'dsh1c-status dsh1c-spec-context' }, 'Текущий чат · ', `${change.tasks?.done || 0}/${change.tasks?.total || 0} задач выполнено`, change.tasks?.cancelled ? ` · ${change.tasks.cancelled} отменено` : '') : null,
          // R197 OS-6: предупреждение с путём — только у спецификации с повреждённой историей этапов.
          change.workflow?.invalid ? h('div', { className: 'dsh1c-spec-feedback', role: 'alert' }, icon('notice'), h('span', null, change.workflow.warningRu)) : null,
          messages,
          stage === 'development' ? h('div', { className: 'dsh1c-spec-tabs', role: 'group', 'aria-label': 'Представление задач' }, button('Список задач', 'list', () => setTaskView('list'), { 'aria-pressed': taskView === 'list' }), button('Текст tasks.md', 'file', () => setTaskView('text'), { 'aria-pressed': taskView === 'text' })) : null,
          stage === 'requirements' ? h(React.Fragment, null,
            h('div', { className: 'dsh1c-spec-tabs', role: 'tablist', 'aria-label': 'Документы постановки' }, ...[['proposal', 'Общее описание'], ['requirements', 'Требования']].map(([tab, label]) =>
              button(label, 'file', () => { if (!busy) void navigate('requirements', tab === 'proposal' ? `changes/${change.id}/proposal.md` : (requirementDocuments.find(item => item.path === requirementsPath) || requirementDocuments[0])?.path, tab); },
                { key: tab, role: 'tab', id: `dsh1c-spec-tab-${tab}`, disabled: false, 'aria-disabled': busy, 'aria-selected': documentTab === tab, 'aria-pressed': documentTab === tab, 'aria-controls': 'dsh1c-spec-document-panel', tabIndex: focusedDocumentTab === tab ? 0 : -1, onFocus: () => setFocusedDocumentTab(tab),
                  onKeyDown: event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const wanted = event.key === 'Home' ? 'proposal' : event.key === 'End' ? 'requirements' : tab === 'proposal' ? 'requirements' : 'proposal'; setFocusedDocumentTab(wanted); event.currentTarget.parentElement?.querySelector?.(`#dsh1c-spec-tab-${wanted}`)?.focus(); } } }))),
            documentTab === 'requirements' && requirementDocuments.length > 1 ? h('div', { className: 'dsh1c-spec-documents dsh1c-field' }, h('label', { htmlFor: 'dsh1c-openspec-requirement' }, 'Файл требований'),
              h('select', { id: 'dsh1c-openspec-requirement', value: artifactPath || requirementsPath, disabled: busy, onChange: event => navigate('requirements', event.target.value) }, ...requirementDocuments.map(item => h('option', { key: item.id, value: item.path }, item.label)))) : null) : null,
          !compact && stage === 'development' && taskView === 'list' ? tasks.length ? h('ul', { className: 'dsh1c-spec-tasks', 'aria-label': 'Задачи спецификации' }, ...tasks.map(renderTask)) : h('p', { className: 'dsh1c-spec-empty' }, 'Задач пока нет. Попросите агента подготовить tasks.md в текущем чате.') : null,
          stage === 'archive' ? h('div', { className: 'dsh1c-spec-empty' }, icon('archive'), h('p', null, 'Архивирование завершает работу над спецификацией. Команда проверит готовность и перенесёт её в архив.'), button('Архивировать спецификацию', 'archive', confirmArchive)) : null,
          showEditor ? page && !page.missing ? h('div', { className: 'dsh1c-spec-editor', id: 'dsh1c-spec-document-panel', role: stage === 'requirements' ? 'tabpanel' : undefined, 'aria-labelledby': stage === 'requirements' ? `dsh1c-spec-tab-${documentTab}` : undefined, tabIndex: 0 },
            h('div', { className: 'dsh1c-spec-editor-heading' }, h('span', { className: 'dsh1c-path', title: `openspec/${artifactPath}` }, artifactPath.replace(`changes/${change.id}/`, '')), h('span', { className: 'dsh1c-status' }, dirty ? 'Не сохранено' : 'Сохранено'),
              button('ИИ-правка', 'chat', openAiEdit, { ref: aiTrigger, disabled: busy || !editable, 'aria-expanded': aiOpenPath === artifactPath, 'aria-controls': 'dsh1c-spec-ai-form', onPointerDown: () => captureSelection({ currentTarget: editorRef.current }, false), title: selection ? 'Изменить выделенный фрагмент с ИИ' : 'Описать ИИ правку этого документа' })),
            aiOpenPath === artifactPath && aiDraft ? h('form', { className: 'dsh1c-spec-ai-form dsh1c-field', id: 'dsh1c-spec-ai-form', onSubmit: sendAiEdit, onKeyDown: event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeAiEdit(); } } },
              h('div', { className: 'dsh1c-spec-ai-heading' }, h('strong', null, aiDraft.scope === 'selection' ? 'Изменить выделенный фрагмент' : 'Правка по строке'), button('Закрыть', 'close', closeAiEdit, { 'aria-label': 'Закрыть ИИ-правку' })),
              h('p', { className: 'dsh1c-path' }, `openspec/${artifactPath}`),
              aiDraft.scope === 'selection' ? h('blockquote', { className: 'dsh1c-spec-ai-quote' }, aiDraft.fragment.text.slice(0, 700), aiDraft.fragment.text.length > 700 ? '…' : '') : h('p', { className: 'dsh1c-status' }, `Строка ${aiDraft.line}`),
              h('label', { htmlFor: 'dsh1c-spec-ai-instruction' }, 'Что изменить'), h('textarea', { id: 'dsh1c-spec-ai-instruction', value: aiDraft.instruction, autoFocus: true, rows: 3, maxLength: 4000, disabled: busy, placeholder: 'Например: уточни поведение при пустом списке', onChange: event => updateAiDraft({ instruction: event.target.value, delivered: false }) }),
              aiDraft.error ? renderError(aiDraft.error) : null,
              aiDraft.delivered ? h('p', { className: 'dsh1c-status dsh1c-ok', role: 'status' }, 'Правка передана в текущий чат. Файл обновится после ответа агента; перечитайте документ.') : null,
              h('div', { className: 'dsh1c-actions' }, button('Отмена', 'close', closeAiEdit), button(dirty ? 'Сохранить и отправить' : 'Отправить правку', 'chat', undefined, { type: 'submit', className: 'dsh1c-button dsh1c-primary', disabled: busy || !aiDraft.instruction.trim() || aiDraft.delivered }))) : null,
            h('textarea', { ref: editorRef, className: 'dsh1c-spec-markdown', 'aria-label': `Редактор ${artifactPath}`, value: documentText, readOnly: !editable || busy, spellCheck: false, rows: 16, onChange: event => { const text = event.target.value; captureSelection({ currentTarget: event.target }); setDrafts(current => { const next = { ...current }; if (text === page.text) delete next[artifactPath]; else next[artifactPath] = { text, version: current[artifactPath]?.version ?? page.version ?? page.revision }; return next; }); }, onSelect: event => captureSelection(event, false), onMouseUp: captureSelection, onKeyUp: captureSelection, onBlur: event => captureSelection(event, false) }),
            !editable ? h('p', { className: 'dsh1c-status' }, 'Для редактирования загрузите документ полностью.') : null,
            draft && draft.version !== (page.version ?? page.revision) ? h('details', { className: 'dsh1c-spec-conflict' }, h('summary', null, 'Файл изменился на диске — сравнить'), h('pre', null, page.text), button('Сохранить мой вариант поверх этой версии', 'save', () => saveDocument(true), { disabled: busy || !editable })) : null,
            h('div', { className: 'dsh1c-spec-editor-actions' }, button('Сохранить', 'save', () => saveDocument(), { disabled: busy || !editable || !dirty }),
              dirty ? button('Отменить правки', 'refresh', () => { setDrafts(current => { const next = { ...current }; delete next[artifactPath]; return next; }); void readArtifact(artifactPath); }) : null,
              page.nextOffsetBytes != null ? button('Загрузить продолжение', 'file', () => readArtifact(artifactPath, true)) : null)) : h('p', { className: 'dsh1c-spec-empty' }, busy ? 'Читаю документ…' : stage === 'requirements' && documentTab === 'requirements' ? 'Файлы требований ещё не созданы. Попросите агента дополнить требования этой спецификации в текущем чате.' : 'Документ ещё не подготовлен. Напишите задачу в текущем чате — агент дополнит этот этап.') : null,
          transition ? h('dialog', { ref: transitionRef, className: 'dsh1c-spec-transition', tabIndex: -1, 'aria-labelledby': 'dsh1c-spec-transition-title', 'aria-describedby': 'dsh1c-spec-transition-description', onKeyDown: event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!busy) setTransition(null); } else keepTransitionFocus(event); }, onCancel: event => { event.preventDefault(); event.stopPropagation(); if (!busy) setTransition(null); }, onClick: event => { if (!busy && event.target === event.currentTarget) setTransition(null); } },
            h('div', { className: 'dsh1c-spec-transition-body' },
              h('div', { className: 'dsh1c-spec-ai-heading' }, h('h3', { id: 'dsh1c-spec-transition-title' }, transition.confirm ? transition.confirm.title : 'Утвердить перед переходом?'), button('Закрыть', 'close', () => setTransition(null), { 'aria-label': transition.confirm ? 'Закрыть подтверждение' : 'Закрыть подтверждение перехода' })),
              h('p', { id: 'dsh1c-spec-transition-description' }, transition.confirm ? transition.confirm.text : `Не утверждено: ${transition.missing.map(key => key === 'requirements' ? 'постановка (общее описание и требования)' : 'технические детали').join(', ')}. Кнопка «Утвердить и перейти» утвердит ${transition.missing.length > 1 ? 'обе части' : 'эту часть'} и откроет этап «${stageLabels.find(([key]) => key === transition.stage)?.[1]}».`),
              // R197 OS-10: пояснение зависит от этапа; переход сам ничего не запускает.
              transition.confirm ? null : h('p', { className: 'dsh1c-status' }, unsavedChange ? 'При утверждении несохранённые документы сначала сохранятся с проверкой версии. ' : 'Можно открыть этап без утверждения. ', transition.stage === 'archive' ? 'Архивирование автоматически не запускается: на этапе «Архив» нажмите «Архивировать спецификацию».' : transition.stage === 'development' ? 'Разработка автоматически не запускается: после перехода нажмите «Разработать».' : 'Разработка автоматически не запускается.'),
              state.error ? renderError(state.error) : null,
              h('div', { className: 'dsh1c-spec-transition-actions' }, ...(transition.confirm
                ? [button(transition.confirm.label, transition.confirm.icon || 'check', confirmTransition, { key: 'confirm', className: 'dsh1c-button dsh1c-primary' }), button('Отмена', 'close', () => setTransition(null), { key: 'cancel', 'data-initial-focus': true })]
                : [button('Утвердить и перейти', 'check', approveTransition, { key: 'approve', className: 'dsh1c-button dsh1c-spec-approve-button', autoFocus: true, 'data-initial-focus': true }), button('Открыть без утверждения', 'arrow', () => { const nextStage = transition.stage; setTransition(null); void navigate(nextStage); }, { key: 'open' }), button('Отмена', 'close', () => setTransition(null), { key: 'cancel' })])))) : null) : !creating ? h('p', { className: 'dsh1c-spec-empty' }, changes.length ? 'Выберите спецификацию или создайте новую.' : 'Создайте первую спецификацию — от постановки до готовой реализации.') : null,
        !change ? messages : null,
        h('details', { className: 'dsh1c-spec-extra' }, h('summary', null, icon('file'), 'Сведения о спецификации'),
          change ? h(React.Fragment, null, auditLine('requirements', 'Постановка'), auditLine('design', 'Технические детали'), h('p', { className: 'dsh1c-status' }, `Структура: ${change.validation?.valid === true ? 'проверена' : change.validation?.valid === false ? 'есть ошибки' : 'ещё не проверена'}. Проверка структуры не запускает тесты кода.`),
            // R197 OS-2: полный вывод CLI — только здесь, свёрнутым.
            change.validation?.output ? h('details', { className: 'dsh1c-spec-conflict' }, h('summary', null, 'Вывод последней проверки структуры'), h('pre', null, change.validation.output)) : null) : button('Перечитать файлы', 'refresh', refresh),
          snapshot.git ? h('p', { className: 'dsh1c-status' }, snapshot.git.statusRu) : null)) : null);
    }

    // OpenSpec panel end.
    function OpenSpecActivity() {
      const { snapshot, error, loading } = useOpenSpecWorkspace();
      const changes = snapshot?.changes || [];
      // R197 OS-16: без выбора счётчик не подставляет первую по алфавиту спецификацию.
      const selected = changes.find((change) => change.id === snapshot?.selectedChange);
      if (snapshot?.enabled === false) return null;
      const label = loading && !snapshot ? "План OpenSpec…" : selected ? `План OpenSpec ${selected.tasks?.done || 0}/${selected.tasks?.total || 0}` : "Изменения OpenSpec";
      return h("button", { type: "button", className: "dsh1c-context-hud", title: error ? `OpenSpec: ${error}` : snapshot?.statusRu || "Открыть спецификации проекта", "aria-label": "Открыть изменения OpenSpec", onClick: openOpenSpecWorkspace }, label);
    }


    const css = '\n.dsh1c-workspace-panel{min-height:0;overflow:auto;padding:14px;box-sizing:border-box;container-type:inline-size}\n.dsh1c-panel{display:flex;flex-direction:column;gap:14px;min-width:0;color:var(--dsw-alias-label-primary)}.dsh1c-panel h2{margin:0}.dsh1c-panel p{margin:0;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-secondary)}\n.dsh1c-field{display:flex;flex-direction:column;gap:6px}.dsh1c-field input,.dsh1c-field select,.dsh1c-field textarea{box-sizing:border-box;min-width:0;width:100%;padding:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit}.dsh1c-field input[type=checkbox]{width:auto}.dsh1c-actions{display:flex;align-items:center;flex-wrap:wrap;gap:8px}.dsh1c-button{padding:8px 12px;border:0;border-radius:6px;cursor:pointer;font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-module-platform)}.dsh1c-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}.dsh1c-button:disabled{opacity:.5;cursor:default}.dsh1c-status{font-size:12px!important}.dsh1c-path{font-family:ui-monospace,monospace;overflow-wrap:anywhere}.dsh1c-context-hud{font:inherit;font-size:12px;padding:4px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer}\n      .dsh1c-openspec-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.dsh1c-openspec-heading h2{margin:0}.dsh1c-spec-header-actions{display:flex;gap:6px;flex-wrap:wrap}.dsh1c-spec-feedback{display:flex;align-items:flex-start;gap:9px;margin:0;padding:11px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:color-mix(in srgb,currentColor 4%,transparent);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5;overflow-wrap:anywhere}.dsh1c-spec-feedback svg{margin-top:2px}.dsh1c-openspec-selection{padding:12px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}.dsh1c-openspec-selection h3{margin:0;overflow-wrap:anywhere;font-size:16px}.dsh1c-openspec-panel .dsh1c-task{display:flex;flex-direction:column;align-items:stretch}.dsh1c-task-completion{width:100%}.dsh1c-openspec-panel .dsh1c-task .dsh1c-button{height:auto;min-height:34px;white-space:normal;line-height:1.3;padding-top:7px;padding-bottom:7px}.dsh1c-openspec-panel input,.dsh1c-openspec-panel select,.dsh1c-openspec-panel textarea{width:100%;box-sizing:border-box}.dsh1c-openspec-panel button:focus-visible,.dsh1c-openspec-panel select:focus-visible,.dsh1c-openspec-panel textarea:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:2px}\n      .dsh1c-spec-ticket-actions{padding:12px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}.dsh1c-spec-ticket-actions h3{margin:0 0 8px;font-size:15px}.dsh1c-spec-ticket-list{list-style:none;padding:0;margin:10px 0;max-height:320px;overflow:auto}.dsh1c-spec-ticket-list li{padding:8px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}.dsh1c-spec-ticket-list label{display:flex;align-items:flex-start;gap:8px!important}.dsh1c-spec-ticket-list input{width:auto!important;margin-top:3px}.dsh1c-spec-ticket-list span{overflow-wrap:anywhere;line-height:1.45}.dsh1c-spec-ticket-list small{display:block;margin-top:4px}.dsh1c-openspec-panel{gap:12px;min-width:0}.dsh1c-openspec-panel h2{font-size:18px;letter-spacing:-.02em}.dsh1c-openspec-panel .dsh1c-button{border-radius:7px;display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:36px;height:auto;line-height:1.3;padding:8px 12px;white-space:normal;transition:background-color 160ms,color 160ms}.dsh1c-openspec-panel svg{flex:none}.dsh1c-openspec-panel .dsh1c-button:disabled{opacity:.5;cursor:not-allowed}.dsh1c-openspec-panel .dsh1c-button:active:not(:disabled){transform:translateY(1px)}.dsh1c-openspec-panel .dsh1c-primary{font-weight:650}.dsh1c-openspec-panel .dsh1c-field label{font-size:12px}.dsh1c-openspec-panel .dsh1c-field select{min-height:38px;font-weight:550}.dsh1c-spec-primary-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.dsh1c-spec-primary-actions>.dsh1c-spec-menu{margin-left:auto}.dsh1c-spec-context{margin:0!important}.dsh1c-spec-stages{display:grid;grid-template-columns:minmax(0,1fr) 12px minmax(0,1fr) 12px minmax(0,1fr) 12px minmax(0,1fr);align-items:start;gap:3px;padding:10px 0 14px;border-bottom:1px solid var(--dsw-alias-border-l2)}.dsh1c-spec-stage{display:flex;flex-direction:column;align-items:center;gap:6px;min-height:68px;padding:7px 3px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:16px;cursor:pointer;overflow-wrap:normal;word-break:normal;transition:background-color 160ms}.dsh1c-spec-stage:hover,.dsh1c-spec-stage[aria-current=step]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}.dsh1c-spec-stage[aria-current=step]{box-shadow:inset 0 -2px currentColor;font-weight:650}.dsh1c-spec-stage-number{display:inline-flex;align-items:center;justify-content:center;width:25px;height:25px;border:1px solid var(--dsw-alias-border-l2);border-radius:50%;font-size:12px}.dsh1c-spec-stage[aria-current=step] .dsh1c-spec-stage-number{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-1)}.dsh1c-spec-stage[data-complete=true]:not([aria-current=step]) .dsh1c-spec-stage-number{border-color:currentColor}.dsh1c-spec-stage-arrow{display:flex;justify-content:center;color:var(--dsw-alias-label-secondary);padding-top:12px}.dsh1c-spec-stage-arrow svg{width:12px}.dsh1c-spec-tabs{display:flex;gap:4px;border-bottom:1px solid var(--dsw-alias-border-l2)}.dsh1c-spec-tabs .dsh1c-button{border:0;border-radius:4px 4px 0 0;background:transparent;box-shadow:none}.dsh1c-spec-tabs [aria-pressed=true]{font-weight:650;box-shadow:inset 0 -2px currentColor!important}.dsh1c-spec-documents{margin-top:2px}.dsh1c-spec-menu{position:relative;flex:none}.dsh1c-spec-menu>summary,.dsh1c-spec-extra>summary{display:flex;align-items:center;gap:6px;list-style:none;cursor:pointer;min-height:36px;padding:6px 9px;box-sizing:border-box;font-size:12px;border-radius:6px;color:var(--dsw-alias-label-secondary)}.dsh1c-spec-menu>summary::-webkit-details-marker,.dsh1c-spec-extra>summary::-webkit-details-marker{display:none}.dsh1c-spec-menu>summary:hover,.dsh1c-spec-menu[open]>summary{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}.dsh1c-spec-menu-items{position:absolute;top:calc(100% + 4px);right:0;z-index:4;display:flex;flex-direction:column;gap:2px;width:max-content;max-width:min(300px,calc(100vw - 64px));padding:6px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 8px 24px #0002}.dsh1c-spec-menu-items .dsh1c-button{justify-content:flex-start;border:0;background:transparent;text-align:left;font-size:12px}.dsh1c-spec-menu-items .dsh1c-button:hover:not(:disabled){background:var(--dsw-alias-bg-module-platform)}.dsh1c-spec-menu>summary:focus-visible,.dsh1c-spec-extra>summary:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:2px}.dsh1c-spec-tasks{list-style:none;margin:0;padding:0}.dsh1c-spec-task{display:grid;grid-template-columns:18px minmax(0,1fr) 32px;align-items:start;gap:10px;padding:12px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}.dsh1c-spec-task-mark{display:flex;align-items:center;min-height:22px;color:var(--dsw-alias-label-secondary)}.dsh1c-spec-task-content{display:flex;flex-direction:column;gap:3px;min-width:0}.dsh1c-spec-task-title{font-size:13px;line-height:20px;overflow-wrap:anywhere}.dsh1c-spec-task-content .dsh1c-status{margin:0;line-height:17px}.dsh1c-spec-task[data-status=done] .dsh1c-spec-task-title,.dsh1c-spec-task[data-status=cancelled] .dsh1c-spec-task-title{color:var(--dsw-alias-label-secondary)}.dsh1c-spec-task[data-status=cancelled] .dsh1c-spec-task-title{text-decoration:line-through}.dsh1c-spec-task[data-status=in-progress] .dsh1c-spec-task-mark{color:var(--dsw-alias-label-primary)}.dsh1c-spec-task .dsh1c-spec-menu>summary{padding:3px;justify-content:center;min-height:30px}.dsh1c-spec-editor{overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}.dsh1c-spec-editor-heading{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:9px 12px;border-bottom:1px solid var(--dsw-alias-border-l2)}.dsh1c-spec-editor-heading>.dsh1c-path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin:0;min-width:0}.dsh1c-spec-editor-heading>.dsh1c-status{margin:0;flex:none}.dsh1c-openspec-panel .dsh1c-spec-markdown{display:block;width:100%;box-sizing:border-box;min-height:260px;max-height:70dvh;resize:vertical;border:0;border-radius:0;padding:14px;font:13px/1.65 Consolas,\'Cascadia Code\',monospace;color:var(--dsw-alias-label-primary);background:transparent;tab-size:2}.dsh1c-openspec-panel .dsh1c-spec-markdown:focus-visible{outline-offset:-2px}.dsh1c-spec-editor-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;border-top:1px solid var(--dsw-alias-border-l2);padding:8px}.dsh1c-spec-editor-actions .dsh1c-button{font-size:12px;min-height:32px;padding:6px 8px}.dsh1c-spec-approval{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:4px 0 8px}.dsh1c-spec-approval .dsh1c-status{margin:0;flex:1 1 160px}.dsh1c-spec-approval>.dsh1c-button{border-color:var(--dsw-alias-label-secondary)}.dsh1c-spec-empty{padding:18px 12px;color:var(--dsw-alias-label-secondary);line-height:1.6;font-size:13px;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;margin:0}.dsh1c-spec-create{padding:14px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px}.dsh1c-spec-extra{border-top:1px solid var(--dsw-alias-border-l2);padding-top:4px}.dsh1c-spec-extra>summary{padding-left:0}.dsh1c-spec-extra[open]>summary{margin-bottom:8px}.dsh1c-spec-extra textarea,.dsh1c-spec-create textarea{resize:vertical;min-height:76px;font-family:inherit;font-size:13px;line-height:1.5}.dsh1c-spec-extra .dsh1c-field{margin:0 0 16px}.dsh1c-spec-extra .dsh1c-field>.dsh1c-button{align-self:flex-start}@container(max-width:360px){.dsh1c-spec-stage{font-size:11px}.dsh1c-spec-primary-actions>.dsh1c-spec-menu{margin-left:0}.dsh1c-spec-stages{gap:0;grid-template-columns:repeat(4,minmax(0,1fr))}.dsh1c-spec-stage-arrow{display:none}.dsh1c-spec-primary-actions>.dsh1c-button{flex:1 1 100px}}@container(max-width:250px){.dsh1c-spec-stage{overflow-wrap:anywhere}}@media(prefers-reduced-motion:reduce){.dsh1c-openspec-panel *{transition:none!important}}\n      .dsh1c-spec-conflict{padding:10px 12px;border-top:1px solid var(--dsw-alias-border-l2);font-size:12px}.dsh1c-spec-conflict>summary{cursor:pointer;padding:5px 0}.dsh1c-spec-conflict pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:200px;overflow:auto;padding:10px;background:var(--dsw-alias-bg-module-platform)}\n      .dsh1c-openspec-panel .dsh1c-spec-approval-top{padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);align-items:center}.dsh1c-spec-approval-top>.dsh1c-status{flex:1 1 160px}.dsh1c-openspec-panel .dsh1c-spec-approve-button{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);border:1px solid transparent;font-weight:650}.dsh1c-openspec-panel .dsh1c-spec-approve-button:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);border-color:transparent}.dsh1c-openspec-panel:has(.dsh1c-spec-approve-button:not(:disabled)) .dsh1c-spec-primary-actions>.dsh1c-primary{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary)}.dsh1c-spec-editor-heading .dsh1c-button{flex:none;font-size:12px;padding:6px 9px;min-height:32px}.dsh1c-spec-editor-heading>.dsh1c-path{flex:1}.dsh1c-spec-ai-form{padding:12px;border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);gap:9px}.dsh1c-spec-ai-heading{display:flex;align-items:center;justify-content:space-between;gap:12px}.dsh1c-spec-ai-heading>strong{font-size:13px}.dsh1c-spec-ai-heading>.dsh1c-button{padding:4px 7px;font-size:12px;min-height:30px}.dsh1c-spec-ai-scope{display:flex;flex-wrap:wrap;gap:4px}.dsh1c-spec-ai-scope>.dsh1c-button{font-size:12px;min-height:30px;padding:5px 8px}.dsh1c-spec-ai-scope>[aria-pressed=true]{box-shadow:inset 0 -2px currentColor;font-weight:650}.dsh1c-spec-ai-quote{margin:0;padding:9px 10px;border-left:3px solid var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);white-space:pre-wrap;font:12px/1.5 Consolas,\'Cascadia Code\',monospace;max-height:150px;overflow:auto;overflow-wrap:anywhere}.dsh1c-spec-ai-form .dsh1c-actions{flex-wrap:wrap}.dsh1c-spec-ai-form textarea{font-family:inherit;font-size:13px}.dsh1c-spec-transition{box-sizing:border-box;width:min(480px,calc(100vw - 32px));max-height:calc(100dvh - 48px);overflow:auto;padding:0;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 20px 80px #0005}.dsh1c-spec-transition::backdrop{background:#0007}.dsh1c-spec-transition-body{padding:20px;display:flex;flex-direction:column;gap:14px}.dsh1c-spec-transition h3{font-size:17px;line-height:24px;margin:0}.dsh1c-spec-transition p{line-height:1.6}.dsh1c-spec-transition-actions{display:flex;align-items:stretch;flex-wrap:wrap;gap:8px}.dsh1c-spec-transition-actions>.dsh1c-button{flex:1 1 180px;min-height:40px}.dsh1c-spec-transition-actions>.dsh1c-button:last-child{flex:0 0 auto}.dsh1c-spec-tabs [role=tab]:focus-visible{outline-offset:-3px}@container(max-width:400px){.dsh1c-spec-approval-top>.dsh1c-button{width:100%}.dsh1c-spec-editor-heading{flex-wrap:wrap}.dsh1c-spec-editor-heading>.dsh1c-path{flex-basis:45%}}\n      .dsh1c-openspec-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.dsh1c-openspec-toolbar select{min-width:220px}.dsh1c-markdown{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:14px;max-height:480px;overflow:auto;background:var(--dsw-alias-bg-layer-1)}.dsh1c-markdown h1,.dsh1c-markdown h2,.dsh1c-markdown h3{margin:10px 0 6px}.dsh1c-markdown p{white-space:pre-wrap;color:var(--dsw-alias-label-primary)}.dsh1c-markdown pre{overflow:auto;padding:10px;border-radius:8px;background:var(--dsw-alias-bg-module-platform)}.dsh1c-task{display:grid;grid-template-columns:auto 1fr auto;gap:8px;align-items:center}.dsh1c-task[data-status="blocked"]{border-left:4px solid var(--dsw-alias-state-error-primary)}.dsh1c-task-title{font-size:12px;line-height:18px}.dsh1c-openspec-activity{display:flex;gap:6px;align-items:center;font-size:12px}.dsh1c-openspec-overlay{position:fixed;inset:0;z-index:1090;background:var(--dsw-alias-bg-mask-1);display:flex;align-items:center;justify-content:center;padding:24px}.dsh1c-openspec-overlay>.dsh1c-dialog{width:min(960px,100%)}.dsh1c-board{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}.dsh1c-board h3{font-size:12px;margin:0 0 8px}.dsh1c-board-col{min-height:80px}.dsh1c-task-actions{display:flex;gap:6px;flex-wrap:wrap}';

    const inject = ["slots"];
    function apply(ctx) {
      ctx.effect(() => {
        const tag = document.createElement("style"); tag.dataset.pluginCss = "dsh-openspec-workflow"; tag.textContent = css; document.head.appendChild(tag); return () => tag.remove();
      });
      ctx.inject(["sessions"], ready => ready.effect(() => {
        workspacePanelsContext = ready;
        document.addEventListener("dsh1c-open-openspec", openOpenSpecWorkspace);
        globalThis.addEventListener?.("onec:openspec-propose-ticket", queueOpenSpecTicket);
        globalThis.addEventListener?.("dsh-openspec:ticket-settings", openOpenSpecWorkspace);
        return () => { if (workspacePanelsContext === ready) workspacePanelsContext = null; document.removeEventListener("dsh1c-open-openspec", openOpenSpecWorkspace); globalThis.removeEventListener?.("onec:openspec-propose-ticket", queueOpenSpecTicket); globalThis.removeEventListener?.("dsh-openspec:ticket-settings", openOpenSpecWorkspace); };
      }));
      ctx.inject(["sidebarRight", "sidebarRightTabs"], ready => {
        const sidebar = ready.get("sidebarRight"); nativeWorkspaceSidebar = sidebar;
        ready.effect(() => () => { if (nativeWorkspaceSidebar === sidebar) nativeWorkspaceSidebar = null; });
        const id = "dsh-openspec-workflow/onec-openspec";
        ready.effect(() => ready.get("sidebarRightTabs").register({ id, kind: "onec-openspec", title: () => "Изменения OpenSpec", icon: OpenSpecIcon, guide: [{ order: 25, title: () => "Изменения OpenSpec", icon: OpenSpecIcon }] }));
        ready.effect(() => ready.slots.inject("sidebar.right.pane.tab", () => ready.slots.register({ name: "sidebar.right.pane.tab", key: id }, ({ sessionId }) => h("div", { className: "dsh1c-workspace-panel" }, h(OpenSpecPanel, { key: sessionId, sessionId })))));
      });
      ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({ name: "conversation.session.header.utilities", id: "openspec-activity", order: 70 }, OpenSpecActivity));
      // Atlassian/Jira integration is excluded; plain ticket links remain on changes.
    }
    return { apply, inject, projectDraftKey, rememberProjectDrafts, readProjectDrafts, TicketSystemSettingsSection };
  }
});
