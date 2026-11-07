/**
 * Telegram→DSH bridge: owns the long-polling loop, the chat→session binding,
 * slash commands and menus, and delivery of each turn back to Telegram.
 * Sessions are created, resumed and configured through the Session
 * Controller, so Telegram and Web share sessions, models and presets.
 * @module telegram/bridge
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { randomUUID } from 'node:crypto';
import { mkdir, open, realpath } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative } from 'node:path';
import { TelegramClient } from './client.js';
import { escapeHtml } from './format.js';
import { TelegramProgress } from './progress.js';
import { TelegramResultCache } from './result-cache.js';
const COLLECTION_ACTIONS = '/send — отправить; /followup — в очередь; /discard — отменить сбор.';
const FOLLOWUP_HELP = '/followup <текст> ставит сообщение после текущей задачи. В режиме /collect команда без текста отправляет собранные сообщения.';
const HELP_TEXT = 'DSH Telegram\n\n/menu — рабочие области и сессии; /status — состояние; /stop — остановить ход; /disconnect — отвязать сессию.\nТекст отправляется выбранной сессии DSH. /followup ставит сообщение в очередь.\nПодтверждения и вопросы приходят кнопками: Разрешить один раз / Отклонить.\n/telegram connect в DSH подключает текущую сессию. /telegram off в DSH полностью отключает Telegram.\n/new — новая сессия; /archive — архив; /collect, /send, /discard — сбор сообщений; /resend — повтор ответа.';
/** Slash-command list registered with Telegram via setMyCommands. */
const MY_COMMANDS = [
    { command: 'status', description: 'Состояние подключения' },
    { command: 'stop', description: 'Остановить текущую задачу' },
    { command: 'disconnect', description: 'Отвязать сессию от Telegram' },
    { command: 'menu', description: 'Открыть меню' },
    { command: 'start', description: 'Проверить подключение' },
    { command: 'new', description: 'Создать сессию в выбранной рабочей области' },
    { command: 'archive', description: 'Архивировать сессию, сохранив историю' },
    { command: 'collect', description: 'Собрать текст, изображения и файлы' },
    { command: 'send', description: 'Отправить собранные сообщения' },
    { command: 'discard', description: 'Отменить сбор' },
    { command: 'followup', description: 'Поставить сообщение после текущей задачи' },
    { command: 'resend', description: 'Повторить последний полный ответ' },
    { command: 'help', description: 'Справка' },
];
// Floor between polls so an instant-empty transport cannot hot-loop the
// event loop; real long polling already blocks for the polling timeout.
const POLL_CADENCE_MS = 50;
const MENU_PAGE_SIZE = 8;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const DOWNLOAD_DIRECTORY = 'telegram-downloads';
const MAX_QUOTED_TEXT_LENGTH = 4096;
const APPROVE_ONCE = 'Разрешить один раз';
const REJECT = 'Отклонить';
const TELEGRAM_CHANNEL_PROMPT = 'Пользователь работает через Telegram в той же сессии DSH. Отвечай по-русски. Сохраняй ASK/PLAN/BUILD и штатные подтверждения. Формат ответа — Markdown, краткие абзацы; локальные пути не являются публичными ссылками. Для вопросов используй штатный ask_user_question.';
const IMAGE_EXTENSIONS = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
};
/** Playful online acknowledgements from a reluctant but dependable assistant. */
const START_MESSAGES = ['DSH подключён.'];
/** A stable message string for logging, whatever the thrown shape. */
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
/** DSH restores record-shaped `UserQuestionError`s, so the optional package need not load at runtime. */
function userQuestionError(message, code, cause) {
    const error = new Error(message, cause === undefined ? undefined : { cause });
    error.name = 'UserQuestionError';
    error.code = code;
    return error;
}
function errorCode(error) {
    const code = error?.code;
    return typeof code === 'string' ? code : undefined;
}
/** True when Telegram rejected an edit only because the content is unchanged. */
function isNotModified(error) {
    return /not modified/i.test(messageOf(error));
}
/** True when an edit/delete target is known not to exist anymore. */
function isMissingMessage(error) {
    return /message to (?:edit|delete) not found|message can't be (?:edited|deleted)/i.test(messageOf(error));
}
/** Cut text without leaving a dangling high surrogate. */
function truncateText(text, maxLength) {
    if (text.length <= maxLength)
        return text;
    let end = Math.max(0, maxLength - 1);
    if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end]))
        end -= 1;
    return `${text.slice(0, end)}…`;
}
/** Keep button text readable without risking an oversized keyboard label. */
function buttonLabel(text) {
    const characters = [...text];
    return characters.length <= 56 ? text : `${characters.slice(0, 55).join('')}…`;
}
/** Quote runtime labels as literal inline HTML, never as executable rich markup. */
function richLiteral(value) {
    return `<code>${escapeHtml(value)}</code>`;
}
/** Use a delimiter longer than any backtick run in the literal value. */
function inlineCode(value) {
    const delimiter = '`'.repeat(Math.max(0, ...(value.match(/`+/g) ?? []).map(run => run.length)) + 1);
    return `${delimiter} ${value.replace(/[\r\n]+/g, ' ')} ${delimiter}`;
}
/** Literal diagnostic/identifier blocks remain safe even with embedded markup. */
function richCodeBlock(value) {
    return `<pre><code class="language-text">${escapeHtml(value)}</code></pre>`;
}
/** Text-bearing Telegram messages use `text`; media messages use `caption`. */
function telegramText(message) {
    return message.text ?? message.caption;
}
/** Parse a leading Telegram slash command while preserving the unsplit argument text. */
function telegramCommand(text) {
    if (text === undefined || !text.trimStart().startsWith('/'))
        return undefined;
    const trimmed = text.trim();
    const separator = trimmed.search(/\s/);
    const raw = separator < 0 ? trimmed : trimmed.slice(0, separator);
    return {
        command: (raw.split('@')[0] ?? '').toLowerCase(),
        argsText: separator < 0 ? '' : trimmed.slice(separator).trim(),
    };
}
/** Verify the actual raster container instead of trusting Telegram MIME metadata. */
function detectImageMediaType(data) {
    const ascii = (start, end) => String.fromCharCode(...data.slice(start, end));
    if (data.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => data[index] === byte)) {
        return 'image/png';
    }
    if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff)
        return 'image/jpeg';
    if (data.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP')
        return 'image/webp';
    if (data.length >= 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a'))
        return 'image/gif';
    return undefined;
}
/** Pick Telegram's largest advertised photo rendition. */
function largestPhoto(photo) {
    return [...photo].sort((left, right) => (right.file_size ?? 0) - (left.file_size ?? 0) || right.width * right.height - left.width * left.height)[0];
}
/** Keep a user-facing filename while removing paths, controls, and shell-hostile punctuation. */
function safeFileStem(name) {
    const leaf = basename(name.replaceAll('\\', '/')).normalize('NFC');
    const safe = leaf.slice(0, Math.max(0, leaf.length - extname(leaf).length))
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .replace(/[^\p{L}\p{N}._-]+/gu, '-')
        .replace(/^[-_.]+|[-_.]+$/g, '')
        .slice(0, 96);
    return safe || 'image';
}
/** Stable Telegram identities contain punctuation unsuitable for a filename. */
function safeId(value) {
    return value.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'file';
}
/** Reject paths that escape the canonical root. */
function pathInside(root, candidate) {
    const path = relative(root, candidate);
    return path === '' || (path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(path));
}
/** Clearly delimit repeated material as a quote, not a fresh instruction. */
function quotedTextBlock(message, hasImage) {
    const author = message.from?.username !== undefined ? `@${message.from.username}` : message.from?.first_name;
    const header = `[Цитата Telegram #${message.message_id}${author === undefined ? '' : ` от ${author}`}; далее только цитата]`;
    const original = telegramText(message)?.trim();
    const body = original === undefined || original === ''
        ? hasImage ? '(изображение из цитаты)' : '(в цитате нет доступного текста)'
        : truncateText(original, MAX_QUOTED_TEXT_LENGTH).split('\n').map(line => `> ${line}`).join('\n');
    return `${header}\n${body}`;
}
/** A 12-hex-digit token binding callback buttons to the message that showed them. */
function callbackToken() {
    return randomUUID().replaceAll('-', '').slice(0, 12);
}
/** Normalize an optional projected title for display. */
function displayTitle(value) {
    return typeof value === 'string' && value.trim() !== '' ? value.replace(/\s+/g, ' ').trim() : undefined;
}
/**
 * Bridge between Telegram private chats and DSH sessions. One session per
 * chat; incoming content becomes a user message, and each turn is delivered
 * back as one native rich Telegram message. Agents belong to DSH, so
 * {@link TelegramBridge.stop} only releases Telegram state.
 */
export class TelegramBridge {
    onBindingChanged;
    onConnectionState;
    ctx;
    client;
    allowedUserIds;
    allowAllUsers;
    preset;
    sleep;
    resultCache;
    chats = new Map();
    chatsBySession = new Map();
    collections = new Map();
    /** Human-input requests keyed by Telegram chat id; at most one per chat. */
    pendingQuestions = new Map();
    menus = new Map();
    abortController = new AbortController();
    disposers = [];
    offset;
    started = false;
    stopped = false;
    pollTask;
    commandTask;
    stopTask;
    /**
     * @param ctx - Cordis context providing the services the plugin injects.
     * @param options - bridge options.
     */
    constructor(ctx, options) {
        if (options.pollingTimeoutSec !== undefined
            && (!Number.isSafeInteger(options.pollingTimeoutSec) || options.pollingTimeoutSec < 1)) {
            throw new RangeError('telegram: pollingTimeoutSec must be a positive integer');
        }
        const allowedUserIds = options.allowedUserIds ?? [];
        if (allowedUserIds.some(id => !Number.isSafeInteger(id) || id <= 0)) {
            throw new RangeError('telegram: allowedUserIds must contain only positive safe integers');
        }
        this.onBindingChanged = options.onBindingChanged;
        this.onConnectionState = options.onConnectionState;
        this.ctx = ctx;
        this.client = options.client ?? new TelegramClient(options.token, {
            ...(options.pollingTimeoutSec === undefined ? {} : { pollingTimeoutSec: options.pollingTimeoutSec }),
            ...(options.apiBaseUrl === undefined ? {} : { baseUrl: options.apiBaseUrl }),
        });
        this.allowedUserIds = new Set(allowedUserIds);
        this.allowAllUsers = options.allowAllUsers ?? false;
        this.preset = options.preset?.trim() || undefined;
        this.resultCache = new TelegramResultCache(options.token, options.resultCacheDirectory);
        this.sleep = options.sleep ?? ((ms, signal) => new Promise((resolve) => {
            const timer = setTimeout(resolve, ms);
            signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
        }));
    }
    /** Register DSH listeners, publish the command list, and start polling. */
    start() {
        if (this.started || this.stopped)
            return;
        this.started = true;
        const ctx = this.ctx;
        this.disposers.push(ctx.on('session/event', (session, event) => this.handleSessionEvent(session, event)), ctx.on('agent/assistant-stream', ({ agent, frame }) => this.boundChat(agent)?.progress?.stream(frame)), ctx.on('user-questions/request', (request, next) => {
            const chat = request.agent === undefined ? undefined : this.boundChat(request.agent);
            return chat === undefined ? next() : this.askThroughTelegram(chat, request);
        }, { prepend: true }), ctx.on('approval/request', (request, next) => {
            const chat = this.boundChat(request.agent);
            return chat === undefined ? next() : this.approveThroughTelegram(chat, request);
        }, { prepend: true }), ctx.systemPrompt.context({
            name: 'telegram:channel',
            order: 900,
            text: ({ agent }) => agent !== undefined && this.boundChat(agent) !== undefined ? TELEGRAM_CHANNEL_PROMPT : '',
        }));
        this.commandTask = this.registerCommands();
        this.pollTask = this.pollLoop();
    }
    /** Stop polling and release Telegram state; DSH sessions and Agents keep running. */
    stop() {
        this.stopTask ??= this.stopImpl();
        return this.stopTask;
    }
    async stopImpl() {
        this.stopped = true;
        for (const pending of [...this.pendingQuestions.values()]) {
            this.rejectPendingQuestion(pending, userQuestionError('ask_user_question was aborted because the Telegram bridge stopped', 'ASK_ABORTED'));
        }
        this.abortController.abort();
        for (const dispose of this.disposers.splice(0))
            dispose();
        const entries = [...this.chatsBySession.values()];
        for (const entry of entries) {
            this.stopTyping(entry);
            entry.progress?.dispose();
        }
        await Promise.allSettled([this.pollTask, this.commandTask, ...entries.map(entry => entry.queue)]);
        this.chats.clear();
        this.chatsBySession.clear();
        this.collections.clear();
        this.menus.clear();
    }
    /** Publish the slash-command list so Telegram's `/` menu matches the bot. */
    async registerCommands() {
        try {
            await this.client.setMyCommands(MY_COMMANDS, this.abortController.signal);
        }
        catch (error) {
            if (!this.stopped)
                this.ctx.logger.warn('[telegram] setMyCommands failed: %s', messageOf(error));
        }
    }
    async pollLoop() {
        let errorCount = 0;
        while (!this.stopped) {
            let updates;
            try {
                updates = await this.client.getUpdates(this.offset, this.abortController.signal);
                errorCount = 0;
                if (!this.stopped) this.onConnectionState?.('running');
            }
            catch (error) {
                if (this.stopped)
                    return;
                errorCount += 1;
                this.onConnectionState?.('error', typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'number' ? error.code : undefined);
                this.ctx.logger.warn('[telegram] polling error (attempt %d): %s', errorCount, messageOf(error));
                await this.sleep(Math.min(1000 * errorCount, 10000), this.abortController.signal);
                continue;
            }
            for (const update of updates) {
                if (this.stopped)
                    return;
                this.offset = update.update_id + 1;
                try {
                    await this.handleUpdate(update);
                }
                catch (error) {
                    if (!this.stopped)
                        this.ctx.logger.error('[telegram] update %d failed: %s', update.update_id, messageOf(error));
                }
            }
            if (updates.length === 0 && !this.stopped)
                await this.sleep(POLL_CADENCE_MS, this.abortController.signal);
        }
    }
    authorizedUser(user) {
        return this.allowAllUsers || (user !== undefined && this.allowedUserIds.has(user.id));
    }
    async handleUpdate(update) {
        const stopped = update.stopped_message_generation;
        if (stopped !== undefined) {
            // Native Stop is a chat-level request; the draft id does not gate cancellation.
            if (stopped.chat.type === 'private' && stopped.message_thread_id === undefined
                && (this.allowAllUsers || this.allowedUserIds.has(stopped.chat.id))) {
                await this.stopCurrentTask(stopped.chat.id);
            }
            return;
        }
        if (update.callback_query !== undefined) {
            await this.handleCallbackQuery(update.callback_query);
            return;
        }
        const message = update.message;
        // Group semantics (mentions, topics, shared visibility) are out of scope;
        // ignoring groups keeps an allowed user from forwarding one to a private agent.
        if (message === undefined || message.chat.type !== 'private')
            return;
        if (!this.authorizedUser(message.from)) {
            await this.safeSend(message.chat.id, '⛔ **Доступ запрещён**');
            return;
        }
        const chatId = message.chat.id;
        const parsed = telegramCommand(telegramText(message));
        const pending = this.pendingQuestions.get(chatId);
        if (pending !== undefined && await this.handleQuestionInput(pending, message, parsed?.command))
            return;
        if (parsed !== undefined && parsed.command !== '/followup') {
            await this.handleCommand(chatId, parsed.command, parsed.argsText);
            return;
        }
        const active = this.chats.get(chatId)?.active;
        if (active === undefined) {
            await this.safeSend(chatId, '⚠️ **Сессия не выбрана**\n\nОтправьте /menu и выберите рабочую область и существующую сессию, либо выполните /telegram connect в нужном чате DSH.');
            return;
        }
        if (parsed?.command === '/followup') {
            await this.handleFollowupMessage(active, message, parsed.argsText);
            return;
        }
        const collection = this.collectionFor(active);
        if (collection !== undefined) {
            await this.addToCollection(active, collection, message);
            return;
        }
        if (message.text === undefined && message.document === undefined && message.photo === undefined
            && message.reply_to_message === undefined)
            return;
        await this.submitTelegramMessage(active, message, 'default');
    }
    /** Route chat input to a waiting question; returns false when the message is an ordinary command. */
    async handleQuestionInput(pending, message, command) {
        const chatId = message.chat.id;
        if (command === '/skip') {
            this.trackQuestionMessage(pending, message.message_id);
            await this.submitQuestionAnswer(pending, { id: this.currentQuestion(pending).id, selected: [] });
            return true;
        }
        if (command === '/cancel') {
            this.trackQuestionMessage(pending, message.message_id);
            const noticeId = await this.safeSend(chatId, pending.approval ? '🚫 **Запрос разрешения отменён**' : '🚫 **Вопрос отменён**');
            if (noticeId !== undefined)
                this.trackQuestionMessage(pending, noticeId);
            this.rejectPendingQuestion(pending, userQuestionError('ask_user_question was cancelled by the Telegram user', 'ASK_CANCELLED'));
            return true;
        }
        if (command !== undefined)
            return false;
        if (pending.approval) {
            await this.safeSend(chatId, `🔐 **Ожидается подтверждение**\n\nНажмите «${APPROVE_ONCE}» или «${REJECT}». /cancel отменяет запрос.`);
            return true;
        }
        if (message.text === undefined) {
            await this.safeSend(chatId, '❓ **Ожидается ответ**\n\nИспользуйте кнопки или отправьте текст. Изображения и файлы не подходят для этого ответа.');
            return true;
        }
        this.trackQuestionMessage(pending, message.message_id);
        await this.submitQuestionAnswer(pending, {
            id: this.currentQuestion(pending).id,
            selected: this.selectedLabels(pending),
            custom: message.text,
        });
        return true;
    }

  /** Bundle adapter: bind the exact current Desktop session; no new runtime. */
  async connectCurrent(chatId, sessionId)  {
    const workspace = this.ctx.workspaceRegistry.list().find(item => item.sessionIds.includes(sessionId))
    if (!workspace) throw new Error('Сессия должна принадлежать рабочей области DSH.')
    await this.restoreBinding(chatId, { workspaceId: workspace.id, sessionId })
  }

  verifyBot() {
    return this.client.getMe(this.abortController.signal)
  }

  /** Restore only the saved pair, before polling; never pick or unarchive a session. */
  async restoreBinding(chatId, binding) {
    const workspace = this.ctx.workspaceRegistry.list().find(item => item.id === binding.workspaceId)
    if (!workspace || !workspace.sessionIds.includes(binding.sessionId)
      || this.ctx.workspaceRegistry.archivedSessionIds.includes(binding.sessionId)
      || await workspace.status() !== 'ok') throw new Error('Saved Telegram session is unavailable')
    await this.resolveAgent(binding.sessionId)
    await this.bind(chatId, workspace, binding.sessionId)
  }

  async disconnectCurrent(chatId) {
    await this.onBindingChanged?.(chatId, null)
    await this.releaseActive(this.stateFor(chatId))
    this.menus.delete(chatId)
  }

  connectionStatus(chatId)  {
    const active = this.chats.get(chatId)?.active
    return active ? `Сессия: ${active.sessionId}. ${this.ctx.agents.get(active.sessionId)?.status === 'running' ? 'Выполняется.' : 'Ожидание.'}` : 'Сессия не привязана. /menu — выбрать, либо /telegram connect в DSH.'
  }

    async handleCommand(chatId, command, argsText) {
        switch (command) {
            case '/start':
        await this.safeSend(chatId, 'DSH подключён. /menu — выбрать существующую сессию; /status — состояние; /help — помощь. Токен в этот чат не отправляйте.');
                return;
            case '/status':
        await this.safeSend(chatId, this.connectionStatus(chatId)); return
      case '/stop':
        await this.stopCurrentTask(chatId); return
      case '/disconnect':
        await this.disconnectCurrent(chatId)
        await this.safeSend(chatId, 'Сессия отвязана от Telegram и сохранена в DSH. /menu — выбрать снова. /telegram off в DSH — полностью отключить связь.'); return
      case '/help':
                await this.safeSend(chatId, HELP_TEXT);
                return;
            case '/menu':
                await this.showMenu(chatId);
                return;
            case '/resend':
                try {
                    const sent = await this.resultCache.resend(chatId, text => this.client.sendRichMessage(chatId, text, this.abortController.signal));
                    if (!sent)
                        await this.safeSend(chatId, 'ℹ️ **Нет сохранённого ответа**\n\nПолный ответ ещё не сохранён.');
                }
                catch (error) {
                    this.ctx.logger.error('[telegram] cached result delivery failed: %s', messageOf(error));
                    await this.safeSend(chatId, '⚠️ **Не удалось повторить ответ**\n\nОтвет сохранён. Повторите /resend позже.');
                }
                return;
            case '/new': {
                const workspace = this.chats.get(chatId)?.workspace;
                if (workspace === undefined) {
                    await this.safeSend(chatId, '⚠️ **Рабочая область не выбрана**\n\nСначала выберите рабочую область и сессию через /menu.');
                    return;
                }
                try {
                    const active = await this.createSession(chatId, workspace);
                    await this.safeSend(chatId, `✅ **Новая сессия создана**\n\n**Рабочая область**：${richLiteral(workspace.title)}\n\n**ID сессии**\n\n${richCodeBlock(active.sessionId)}`);
                }
                catch (error) {
                    await this.safeSend(chatId, `⚠️ **Не удалось создать сессию**\n\n${richCodeBlock(messageOf(error))}`);
                }
                return;
            }
            case '/archive':
                try {
                    const archived = await this.archiveCurrent(chatId);
                    await this.safeSend(chatId, archived === undefined
                        ? 'ℹ️ **Нет сессии для архивации**'
                        : `📦 **Сессия архивирована**\n\n${richCodeBlock(archived)}\n\n---\n\nИстория сохранена. /new создаёт новую сессию, /menu позволяет открыть существующую.`);
                }
                catch (error) {
                    await this.safeSend(chatId, `⚠️ **Не удалось архивировать сессию**\n\n${richCodeBlock(messageOf(error))}`);
                }
                return;
            case '/collect': {
                const active = this.chats.get(chatId)?.active;
                if (active === undefined) {
                    await this.safeSend(chatId, '⚠️ **Сессия не выбрана**\n\nСначала выберите сессию через /menu или /telegram connect в DSH.');
                    return;
                }
                const existing = this.collectionFor(active);
                if (existing !== undefined) {
                    await this.sendCollectionStatus(existing, this.collectionStatus(existing, 'Сбор сообщений уже включён'));
                    return;
                }
                const collection = { chatId, sessionId: active.sessionId, parts: [] };
                this.collections.set(chatId, collection);
                await this.sendCollectionStatus(collection, `📥 **Сбор сообщений включён**\n\nОтправляйте текст, изображения и файлы в нужном порядке.\n\n---\n\n${COLLECTION_ACTIONS}`);
                return;
            }
            case '/send': {
                const active = this.chats.get(chatId)?.active;
                const collection = active === undefined ? undefined : this.collectionFor(active);
                if (active === undefined || collection === undefined) {
                    await this.safeSend(chatId, 'ℹ️ **Нет собранных сообщений**\n\nНачните сбор командой /collect.');
                    return;
                }
                if (argsText !== '')
                    collection.parts.push({ type: 'text', text: argsText });
                await this.submitCollection(active, collection, 'default');
                return;
            }
            case '/discard': {
                const collection = this.collections.get(chatId);
                if (collection === undefined) {
                    await this.safeSend(chatId, 'ℹ️ **Нет собранных сообщений**');
                    return;
                }
                this.collections.delete(chatId);
                await this.sendCollectionStatus(collection, `🗑 **Сбор отменён**\n\nСкачанные изображения остаются в каталоге \`${DOWNLOAD_DIRECTORY}\` рабочей области.`);
                return;
            }
            case '/followup':
                await this.safeSend(chatId, FOLLOWUP_HELP);
                return;
            default:
                await this.safeSend(chatId, `❔ **Неизвестная команда**\n\n${richLiteral(command)}\n\n/help — список команд.`);
        }
    }
    /** Native Stop: cancel the running turn and any question it is waiting on. */
    async stopCurrentTask(chatId) {
        const active = this.chats.get(chatId)?.active;
        const pending = this.pendingQuestions.get(chatId);
        const agent = active === undefined ? undefined : this.ctx.agents.get(active.sessionId);
        const running = agent?.status === 'running';
        if (active === undefined || (!running && pending === undefined)) {
            await this.safeSend(chatId, 'ℹ️ **Сейчас нет выполняющейся задачи**');
            return;
        }
        // Kill the typing heartbeat first so Telegram's indicator expires instead of renewing.
        this.stopTyping(active);
        active.progress?.stopByUser();
        if (pending !== undefined) {
            this.rejectPendingQuestion(pending, userQuestionError('ask_user_question was aborted by the Telegram user', 'ASK_ABORTED'));
        }
        // Queued follow-ups are discarded too; the aborted turn never delivers its partial answer.
        if (running)
            agent.cancel({ kind: 'user' });
        await this.enqueue(active, async () => { await this.safeSend(chatId, '⏹ **Текущая задача остановлена**'); });
    }
    // --- Menu ------------------------------------------------------------------
    /** Bind callbacks to the state shown, so an old button cannot act on a newer selection. */
    menuFingerprint(chatId) {
        const state = this.chats.get(chatId);
        return JSON.stringify([state?.workspace?.id, state?.active?.sessionId]);
    }
    async handleMenuCallback(callback, chatId, messageId) {
        const match = /^menu:([a-f0-9]{12}):(\d+)$/.exec(callback.data);
        const menu = this.menus.get(chatId);
        const action = match !== null && menu?.token === match[1] && menu.messageId === messageId
            ? menu.actions[Number(match[2])] : undefined;
        if (menu === undefined || action === undefined) {
            await this.safeAnswerCallback(callback.id, 'Меню устарело. Повторите /menu.');
            return;
        }
        // Consume before awaiting anything: repeated taps cannot repeat a mutation.
        this.menus.delete(chatId);
        await this.safeAnswerCallback(callback.id);
        try {
            if (menu.fingerprint !== this.menuFingerprint(chatId)) {
                await this.showMenu(chatId, 'home', 0, undefined, 'Выбор изменился. Меню обновлено, повторите действие.', menu.messageId);
                return;
            }
            await action();
        }
        catch (error) {
            await this.showMenu(chatId, 'home', 0, undefined, `Не удалось выполнить действие: ${messageOf(error)}`, menu.messageId);
        }
    }
    /** Render one menu page; callbacks capture stable ids, never live catalog positions. */
    async showMenu(chatId, view = 'home', page = 0, workspaceId, notice, messageId) {
        try {
            const state = this.stateFor(chatId);
            const active = state.active;
            const [catalog, models, status] = await Promise.all([
                this.loadCatalog(),
                this.ctx.sessionController.modelCatalog(),
                active === undefined ? undefined : this.sessionStatus(active.sessionId),
            ]);
            const selection = status?.selection ?? models.default;
            const token = callbackToken();
            const actions = [];
            const rows = [];
            const button = (text, action) => {
                const index = actions.push(action) - 1;
                return { text: buttonLabel(text), callback_data: `menu:${token}:${index}` };
            };
            const navigate = (next, nextPage = 0, id, message) => this.showMenu(chatId, next, nextPage, id, message, messageId);
            const running = active !== undefined && this.ctx.agents.get(active.sessionId)?.status === 'running';
            const idle = () => {
                if (active !== undefined && this.ctx.agents.get(active.sessionId)?.status === 'running') {
                    throw new Error('Задача выполняется. Дождитесь завершения или отправьте /stop.');
                }
            };
            const model = this.findModel(models, selection);
            const effort = selection.reasoningEffort ?? model?.reasoning?.defaultEffort;
            const effortName = model?.reasoning?.efforts.find(candidate => candidate.id === effort)?.name ?? effort
                ?? (model?.reasoning === undefined ? 'Не поддерживается' : 'По умолчанию');
            const sessionLabel = active === undefined ? 'Не выбрано'
                : status?.title === undefined ? inlineCode(active.sessionId)
                    : `${richLiteral(status.title)}（${inlineCode(active.sessionId)}）`;
            const lines = [
                '# 🎛 Управление DSH',
                [
                    '## 🎯 Выбрано',
                    '',
                    `- **Рабочая область**：${state.workspace === undefined ? 'Не выбрано' : richLiteral(state.workspace.title)}`,
                    ...(state.workspace === undefined ? [] : [`  ${inlineCode(state.workspace.path)}`]),
                    `- **Сессия**：${sessionLabel}`,
                    `- **Модель**：${richLiteral(model?.name ?? `${selection.provider}/${selection.model}`)}`,
                    `- **Глубина рассуждения**：${richLiteral(effortName)}`,
                ].join('\n'),
                '---',
                '## 📊 Состояние',
                [
                    '| Проект | Состояние |',
                    '| --- | --- |',
                    `| Задача | ${running ? 'Выполняется' : active ? 'Ожидание' : 'Сессия не подключена'} |`,
                    `| Ожидается ответ | ${this.pendingQuestions.has(chatId) ? 'Да' : 'Нет'} |`,
                    `| Сбор сообщений | ${this.collections.has(chatId) ? `Собрано ${this.collections.get(chatId).parts.length} сообщений` : 'Выключено'} |`,
                    `| Рабочих областей / сессий | ${catalog.length} / ${catalog.reduce((sum, entry) => sum + entry.sessions.length, 0)} |`,
                ].join('\n'),
                '---',
            ];
            if (notice)
                lines.push(`**Подсказка**　${richLiteral(notice)}`);
            const paginate = (items, render) => {
                const pages = Math.max(1, Math.ceil(items.length / MENU_PAGE_SIZE));
                page = Math.max(0, Math.min(page, pages - 1));
                lines.push(`Страница ${page + 1} / ${pages}`);
                const start = lines.length;
                items.slice(page * MENU_PAGE_SIZE, (page + 1) * MENU_PAGE_SIZE).forEach(render);
                const entries = lines.splice(start);
                if (entries.length)
                    lines.push(entries.join('\n'));
                if (pages > 1) {
                    const navigation = [];
                    if (page > 0)
                        navigation.push(button('⬅️ Назад', () => navigate(view, page - 1, workspaceId)));
                    if (page + 1 < pages)
                        navigation.push(button('Вперёд ➡️', () => navigate(view, page + 1, workspaceId)));
                    rows.push(navigation);
                }
            };
            const changeModel = async (next) => {
                if (active === undefined)
                    throw new Error('Сначала выберите или создайте сессию.');
                idle();
                await this.ctx.sessionController.selectModel({ sessionId: active.sessionId, ...next });
                await navigate('home');
            };
            if (view === 'home') {
                lines.push('Выберите сессию или модель кнопками ниже.');
                rows.push([button('🗂 Рабочие области и сессии', () => navigate('workspaces')), button('🤖 Выбрать модель', () => navigate('models'))]);
                rows.push([button('🧠 Глубина рассуждения', () => navigate('reasoning'))]);
                rows.push([
                    button('➕ Новая сессия', async () => {
                        idle();
                        if (state.workspace === undefined)
                            return navigate('workspaces');
                        await this.createSession(chatId, state.workspace);
                        await navigate('home');
                    }),
                    button('📦 Архивировать сессию', async () => {
                        const archived = await this.archiveCurrent(chatId);
                        await navigate('home', 0, undefined, archived === undefined ? 'Нет сессии для архивации.' : 'Сессия архивирована, история сохранена. Открыть её снова можно в списке сессий.');
                    }),
                ]);
            }
            else if (view === 'workspaces') {
                lines.push('## 🗂 Рабочие области');
                if (!catalog.length)
                    lines.push('Сначала добавьте рабочую область в DSH Desktop.');
                paginate(catalog, (entry) => {
                    lines.push(`- **${richLiteral(entry.workspace.title)}** · ${entry.sessions.length} сессий\n  ${inlineCode(entry.workspace.path)}`);
                    rows.push([button(`${state.workspace?.id === entry.workspace.id ? '✓ ' : ''}${entry.workspace.title}`, () => navigate('sessions', 0, entry.workspace.id))]);
                });
            }
            else if (view === 'sessions') {
                const entry = catalog.find(item => item.workspace.id === workspaceId);
                if (entry === undefined)
                    throw new Error('Рабочая область удалена. Обновите меню.');
                lines.push(`## 💬 ${richLiteral(entry.workspace.title)} — сессии`);
                if (!entry.sessions.length)
                    lines.push('Сессий пока нет. Создайте сессию кнопкой ниже.');
                paginate(entry.sessions, (session) => {
                    const label = session.title ?? session.id;
                    const badges = `${session.running ? ' · Выполняется' : ''}${session.archived ? ' · В архиве' : ''}${active?.sessionId === session.id ? ' · Текущая' : ''}`;
                    lines.push(`- ${richLiteral(label)}${badges}\n  ${inlineCode(session.id)}`);
                    rows.push([button(`${label}${badges}`, async () => {
                            idle();
                            const result = await this.openSession(chatId, entry.workspace, session.id);
                            await navigate('home', 0, undefined, result);
                        })]);
                });
                rows.push([
                    button('➕ Новая сессия в этой рабочей области', async () => {
                        idle();
                        await this.createSession(chatId, entry.workspace);
                        await navigate('home');
                    }),
                    button('⬅️ Рабочая область', () => navigate('workspaces')),
                ]);
            }
            else if (view === 'models') {
                const choices = models.groups.flatMap(group => group.models.map(item => ({ ...item, provider: group.id })));
                lines.push('## 🤖 Доступные модели', 'После выбора модели применяется её обычная глубина рассуждения. Она также станет моделью по умолчанию для новых сессий.');
                if (active === undefined)
                    lines.push('Сначала выберите или создайте сессию.');
                for (const failure of models.failures)
                    lines.push(`⚠️ ${richLiteral(failure.name)} Не удалось получить модели：${richLiteral(failure.message)}`);
                paginate(choices, (choice) => {
                    const selected = choice.provider === selection.provider && choice.id === selection.model;
                    lines.push(`- ${richLiteral(choice.name)}${selected ? ' · **Текущая**' : ''}`);
                    rows.push([button(`${selected ? '✓ ' : ''}${choice.name}`, () => changeModel({ provider: choice.provider, model: choice.id }))]);
                });
            }
            else {
                const efforts = model?.reasoning?.efforts ?? [];
                lines.push('## 🧠 Доступная глубина рассуждения');
                if (active === undefined)
                    lines.push('Сначала выберите или создайте сессию.');
                if (!efforts.length)
                    lines.push('Модель не поддерживает выбор глубины рассуждения.');
                paginate(efforts, (choice) => {
                    lines.push(`- ${richLiteral(choice.name)}${choice.description ? ` — ${richLiteral(choice.description)}` : ''}`);
                    rows.push([button(`${effort === choice.id ? '✓ ' : ''}${choice.name}`, () => changeModel({ provider: selection.provider, model: selection.model, reasoningEffort: choice.id }))]);
                });
            }
            rows.push([button(view === 'home' ? '🔄 Обновить состояние' : '🏠 Обзор', () => navigate('home'))]);
            const markdown = lines.filter(Boolean).join('\n\n');
            const old = this.menus.get(chatId);
            const sent = messageId === undefined
                ? await this.client.sendRichMessage(chatId, markdown, this.abortController.signal, { inline_keyboard: rows })
                : await this.client.editRichMessage(chatId, messageId, markdown, this.abortController.signal, { inline_keyboard: rows });
            // Button actions read this binding, so later pages edit the panel in place.
            messageId = sent.message_id;
            this.menus.set(chatId, { token, messageId: sent.message_id, fingerprint: this.menuFingerprint(chatId), actions });
            if (old !== undefined && old.messageId !== sent.message_id) {
                try {
                    await this.client.editMessageReplyMarkup(chatId, old.messageId, { inline_keyboard: [] }, this.abortController.signal);
                }
                catch (error) {
                    this.ctx.logger.warn('[telegram] old menu cleanup failed: %s', messageOf(error));
                }
            }
        }
        catch (error) {
            await this.safeSend(chatId, `⚠️ **Меню временно недоступно**\n\n${richLiteral(messageOf(error))}\n\nПовторите /menu.`);
        }
    }
    findModel(catalog, selection) {
        return catalog.groups.find(group => group.id === selection.provider)?.models
            .find(model => model.id === selection.model);
    }
    /** Workspaces in registry order with their sessions' list metadata. */
    async loadCatalog() {
        const { items } = await this.ctx.sessionController.list({}, this.abortController.signal);
        const summaries = new Map(items.map(item => [item.sessionId, item]));
        const archived = new Set(this.ctx.workspaceRegistry.archivedSessionIds);
        return this.ctx.workspaceRegistry.list().map(workspace => ({
            workspace,
            sessions: workspace.sessionIds.map((id) => {
                const summary = summaries.get(id);
                return {
                    id,
                    title: displayTitle(summary?.projections?.values.title),
                    archived: archived.has(id),
                    running: summary?.running === true,
                };
            }),
        }));
    }
    /** Read one session's model route (falling back to the DSH default) and title. */
    async sessionStatus(sessionId) {
        const baseline = await this.ctx.sessionController.projections({ sessionId }, this.abortController.signal);
        const selection = baseline?.values.modelSelection?.next
            ?? (await this.ctx.sessionController.modelCatalog()).default;
        return { selection, title: displayTitle(baseline?.values.title) };
    }
    // --- Session binding -------------------------------------------------------
    stateFor(chatId) {
        let state = this.chats.get(chatId);
        if (state === undefined) {
            state = { chatId, workspace: undefined, active: undefined };
            this.chats.set(chatId, state);
        }
        return state;
    }
    /** The chat bound to an Agent's session, if any. */
    boundChat(agent) {
        return this.chatsBySession.get(agent.session.id);
    }
    /** Resolve the live Agent through the Session Controller, resuming a cold session. */
    async resolveAgent(sessionId) {
        const found = await this.ctx.sessionController.resolveAgent(sessionId);
        if ('error' in found)
            throw found.error;
        return found.agent;
    }
    /** Create a session in `workspace` exactly as Web does and bind this chat to it. */
    async createSession(chatId, workspace) {
        if (await workspace.status() !== 'ok')
            throw new Error(`Каталог рабочей области отсутствует: ${workspace.path}`);
        const { sessionId } = await this.ctx.sessionController.create({
            workspaceId: workspace.id,
            ...(this.preset === undefined ? {} : { agentPreset: this.preset }),
        });
        return this.bind(chatId, workspace, sessionId);
    }
    /** Bind this chat to an existing session, unarchiving it first when needed. */
    async openSession(chatId, workspace, sessionId) {
        const state = this.stateFor(chatId);
        if (state.active?.sessionId === sessionId) {
            state.workspace = workspace;
            return 'Эта сессия уже выбрана.';
        }
        const owner = this.chatsBySession.get(sessionId);
        if (owner !== undefined && owner.chatId !== chatId)
            throw new Error('Эта сессия уже связана с другим личным чатом Telegram');
        const archived = this.ctx.workspaceRegistry.archivedSessionIds.includes(sessionId);
        if (archived)
            await this.ctx.workspaceRegistry.unarchiveSession(sessionId);
        await this.resolveAgent(sessionId);
        await this.bind(chatId, workspace, sessionId);
        return archived ? 'Сессия восстановлена из архива и выбрана.' : 'Сессия выбрана.';
    }
    async bind(chatId, workspace, sessionId) {
        if (this.stopped)
            throw new Error('telegram bridge stopped during session binding');
        const state = this.stateFor(chatId);
        await this.releaseActive(state);
        await this.onBindingChanged?.(chatId, { workspaceId: workspace.id, workspaceTitle: workspace.title, sessionId });
        if (this.stopped) throw new Error('telegram bridge stopped during session binding');
        const active = {
            chatId,
            workspace,
            sessionId,
            transientMessageIds: new Set(),
            queue: Promise.resolve(),
            typingTimer: undefined,
            progress: undefined,
        };
        state.workspace = workspace;
        state.active = active;
        this.chatsBySession.set(sessionId, active);
        return active;
    }
    /** Forget the Telegram binding; the DSH session and its Agent are unaffected. */
    async releaseActive(state) {
        const active = state.active;
        if (active === undefined)
            return;
        this.collections.delete(state.chatId);
        const pending = this.pendingQuestions.get(state.chatId);
        if (pending?.sessionId === active.sessionId) {
            this.rejectPendingQuestion(pending, userQuestionError('ask_user_question was aborted because the Telegram session changed', 'ASK_ABORTED'));
        }
        state.active = undefined;
        this.chatsBySession.delete(active.sessionId);
        this.stopTyping(active);
        active.progress?.dispose();
        await active.queue;
        await this.deleteMessageIds(active.chatId, [...active.transientMessageIds]);
    }
    /** Archive through the Workspace registry, then release the Telegram selection. */
    async archiveCurrent(chatId) {
        const state = this.chats.get(chatId);
        const active = state?.active;
        if (state === undefined || active === undefined)
            return undefined;
        if (this.ctx.agents.get(active.sessionId)?.status === 'running') {
            throw new Error('Сначала дождитесь завершения задачи или отправьте /stop, затем архивируйте сессию.');
        }
        await this.ctx.workspaceRegistry.archiveSession(active.sessionId);
        await this.disconnectCurrent(chatId);
        return active.sessionId;
    }
    // --- Input collection and submission ---------------------------------------
    /** Return only a collection that still belongs to the active session. */
    collectionFor(active) {
        const collection = this.collections.get(active.chatId);
        if (collection === undefined || collection.sessionId === active.sessionId)
            return collection;
        this.collections.delete(active.chatId);
        return undefined;
    }
    /** Replace the previous collection notice only after its successor was sent. */
    async sendCollectionStatus(collection, text) {
        const messageId = await this.safeSend(collection.chatId, text);
        if (messageId === undefined)
            return;
        const previousId = collection.statusMessageId;
        collection.statusMessageId = messageId;
        if (previousId !== undefined && previousId !== messageId)
            await this.deleteMessageIds(collection.chatId, [previousId]);
    }
    collectionStatus(collection, prefix = 'Добавлено в сбор') {
        const count = (type) => collection.parts.filter(part => part.type === type).length;
        return `📥 **${prefix}**\n\n| Содержимое | Количество |\n| :--- | ---: |\n| Текст | ${count('text')} |\n| Изображения | ${count('image')} |\n| Файлы | ${count('file')} |\n\n---\n\n${COLLECTION_ACTIONS}`;
    }
    /** Explicit `/followup`: queue one message, or submit the active collection as a later turn. */
    async handleFollowupMessage(active, message, argsText) {
        const hasContent = argsText !== '' || message.document !== undefined || message.photo !== undefined
            || message.reply_to_message !== undefined;
        const collection = this.collectionFor(active);
        if (collection !== undefined) {
            if (hasContent && !await this.addToCollection(active, collection, message, argsText, false))
                return;
            await this.submitCollection(active, collection, 'followup');
        }
        else if (hasContent) {
            await this.submitTelegramMessage(active, message, 'followup', argsText);
        }
        else {
            await this.safeSend(message.chat.id, FOLLOWUP_HELP);
        }
    }
    /** Add one Telegram message and its reply context to an explicit collection. */
    async addToCollection(active, collection, message, overrideText, announce = true) {
        try {
            const parts = await this.telegramMessageParts(active, message, overrideText);
            if (parts.length === 0) {
                await this.safeSend(message.chat.id, 'ℹ️ **Нет содержимого для сбора**\n\nВ сообщении нет текста, изображений или файлов.');
                return false;
            }
            const images = [...collection.parts, ...parts].flatMap(part => part.type === 'image' ? [part.image] : []);
            const limits = this.ctx.attachments.imageLimits;
            if (images.length > limits.maxImagesPerMessage) {
                await this.safeSend(message.chat.id, `⚠️ **Слишком много изображений**\n\nМаксимум ${limits.maxImagesPerMessage}。`);
                return false;
            }
            if (images.reduce((sum, image) => sum + image.data.byteLength, 0) > limits.maxMessageImageBytes) {
                await this.safeSend(message.chat.id, '⚠️ **Общий размер изображений превышает ограничение DSH**');
                return false;
            }
            collection.parts.push(...parts);
            if (announce)
                await this.sendCollectionStatus(collection, this.collectionStatus(collection));
            return true;
        }
        catch (error) {
            await this.safeSend(message.chat.id, `⚠️ **Ошибка сбора**\n\n${richCodeBlock(messageOf(error))}`);
            return false;
        }
    }
    /** Submit and clear one collection only after DSH has accepted it. */
    async submitCollection(active, collection, mode) {
        if (collection.parts.length === 0) {
            await this.safeSend(active.chatId, 'ℹ️ **Сбор пуст**\n\nСначала отправьте текст, изображение или файл.');
            return;
        }
        try {
            await this.submitParts(active, collection.parts, mode);
            this.collections.delete(active.chatId);
            await this.sendCollectionStatus(collection, mode === 'followup' ? '🕒 **Добавлено в очередь следующей задачи**' : '✅ **Сообщения отправлены**');
        }
        catch (error) {
            await this.safeSend(active.chatId, `⚠️ **Не удалось отправить собранные сообщения**\n\n${richCodeBlock(messageOf(error))}\n\nСобранные сообщения сохранены.`);
        }
    }
    /** Build and submit one ordinary Telegram message. */
    async submitTelegramMessage(active, message, mode, overrideText) {
        try {
            const parts = await this.telegramMessageParts(active, message, overrideText);
            if (parts.length > 0)
                await this.submitParts(active, parts, mode);
        }
        catch (error) {
            await this.safeSend(message.chat.id, `⚠️ **Не удалось обработать сообщение**\n\n${richCodeBlock(messageOf(error))}`);
        }
    }
    /**
     * Preserve Telegram reply semantics inside the same user message: quoted
     * text is explicitly delimited and quoted media stays adjacent to it.
     */
    async telegramMessageParts(active, message, overrideText) {
        const parts = [];
        const reply = message.reply_to_message;
        if (reply !== undefined) {
            parts.push({ type: 'text', text: quotedTextBlock(reply, this.imageCandidate(reply) !== undefined) });
            parts.push(...await this.mediaParts(active, reply, '[Telegram Изображение из цитаты сохранено в рабочую область: '));
        }
        parts.push(...await this.mediaParts(active, message, '[Telegram Изображение сохранено в рабочую область: '));
        const text = (overrideText ?? telegramText(message) ?? '').trim();
        if (text !== '')
            parts.push({ type: 'text', text });
        else if (reply !== undefined && this.imageCandidate(message) === undefined) {
            parts.push({ type: 'text', text: 'Продолжите работу с процитированным в Telegram содержимым.' });
        }
        return parts;
    }
    /** Download the message's image into the workspace or its document into DSH attachments. */
    async mediaParts(active, message, imageLabel) {
        const candidate = this.imageCandidate(message);
        if (candidate !== undefined) {
            const image = await this.downloadWorkspaceImage(active, candidate);
            return [{ type: 'text', text: `${imageLabel}${image.relativePath}]` }, { type: 'image', image }];
        }
        const document = message.document;
        if (document === undefined)
            return [];
        const downloaded = await this.client.downloadFile(document.file_id, MAX_FILE_BYTES, this.abortController.signal);
        const attachment = await this.ctx.attachments.saveFile({
            data: downloaded.data,
            name: document.file_name ?? `telegram-file-${message.message_id}`,
        });
        return [{ type: 'file', attachment }];
    }
    /** Photos and declared raster documents go through the image pipeline. */
    imageCandidate(message) {
        const photo = message.photo === undefined ? undefined : largestPhoto(message.photo);
        if (photo !== undefined) {
            return {
                fileId: photo.file_id,
                fileUniqueId: photo.file_unique_id,
                fileSize: photo.file_size,
                suggestedName: `telegram-photo-${message.message_id}.jpg`,
                telegramMessageId: message.message_id,
            };
        }
        const document = message.document;
        if (document === undefined)
            return undefined;
        const mime = document.mime_type?.toLowerCase() ?? '';
        const extension = extname(document.file_name ?? '').toLowerCase();
        if (!(mime in IMAGE_EXTENSIONS) && !['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(extension))
            return undefined;
        return {
            fileId: document.file_id,
            fileUniqueId: document.file_unique_id,
            fileSize: document.file_size,
            suggestedName: document.file_name ?? `telegram-image-${message.message_id}`,
            telegramMessageId: message.message_id,
        };
    }
    /** Download, verify, and save one image beneath the selected workspace. */
    async downloadWorkspaceImage(active, candidate) {
        const limits = this.ctx.attachments.imageLimits;
        if (candidate.fileSize !== undefined && candidate.fileSize > limits.maxImageBytes) {
            throw new Error(`Изображение превышает лимит размера（${limits.maxImageBytes} байт）`);
        }
        const { data } = await this.client.downloadFile(candidate.fileId, limits.maxImageBytes, this.abortController.signal);
        const mediaType = detectImageMediaType(data);
        if (mediaType === undefined || !limits.mediaTypes.includes(mediaType)) {
            throw new Error('Файл не является поддерживаемым изображением PNG, JPEG, WebP или GIF');
        }
        const name = `${safeFileStem(candidate.suggestedName)}${IMAGE_EXTENSIONS[mediaType]}`;
        await this.ctx.attachments.validateImage({ data, mediaType, name });
        const relativePath = await this.saveWorkspaceFile(active.workspace, candidate, name, data);
        return { data, mediaType, name, relativePath };
    }
    /** Create an exclusive file under `<workspace>/telegram-downloads` without following an escaping directory link. */
    async saveWorkspaceFile(workspace, candidate, name, data) {
        const workspaceRoot = await realpath(workspace.path);
        const requestedRoot = join(workspaceRoot, DOWNLOAD_DIRECTORY);
        await mkdir(requestedRoot, { recursive: true });
        const root = await realpath(requestedRoot);
        if (!pathInside(workspaceRoot, root))
            throw new Error(`Каталог загрузки находится за пределами рабочей области: ${requestedRoot}`);
        const stem = safeFileStem(name);
        const identity = `${safeId(candidate.fileUniqueId)}-${candidate.telegramMessageId}`;
        for (let attempt = 0; attempt < 100; attempt += 1) {
            const absolutePath = join(root, `${identity}-${stem}${attempt === 0 ? '' : `-${attempt + 1}`}${extname(name)}`);
            let file;
            try {
                file = await open(absolutePath, 'wx', 0o600);
            }
            catch (error) {
                if (error.code === 'EEXIST')
                    continue;
                throw error;
            }
            try {
                await file.writeFile(data);
            }
            finally {
                await file.close();
            }
            return relative(workspaceRoot, absolutePath);
        }
        throw new Error('Не удалось создать уникальное имя для загрузки');
    }
    /** Admit collected images, preserve part order, then steer a running turn or queue a follow-up. */
    async submitParts(active, parts, mode) {
        if (this.ctx.workspaceRegistry.archivedSessionIds.includes(active.sessionId)) {
            throw new Error('Сессия архивирована. Откройте её через /menu или создайте новую через /new.');
        }
        const agent = await this.resolveAgent(active.sessionId);
        const images = parts.flatMap(part => part.type === 'image' ? [part.image] : []);
        if (images.length > 0) {
            const { selection } = await this.sessionStatus(active.sessionId);
            const info = await this.ctx.llm.resolveModelInfo(selection.provider, selection.model, this.abortController.signal);
            if (info.inputModalities !== undefined && !info.inputModalities.includes('image')) {
                throw new Error(`ТекущаяМодель ${info.name} не поддерживает изображения. Выберите подходящую модель через /menu.`);
            }
        }
        const refs = images.length === 0 ? [] : await this.ctx.attachments.saveImages(images.map(image => ({
            data: image.data,
            mediaType: image.mediaType,
            name: image.name,
        })));
        let imageIndex = 0;
        const content = parts.flatMap((part) => {
            if (part.type === 'text')
                return part.text.trim() === '' ? [] : [{ type: 'text', text: part.text }];
            if (part.type === 'file')
                return [{ type: 'file', attachment: part.attachment }];
            const attachment = refs[imageIndex++];
            return attachment === undefined ? [] : [{ type: 'image', attachment }];
        });
        if (content.length === 0)
            throw new Error('В сообщении нет содержимого для отправки');
        const input = createUserMessage({ content, source: { kind: 'user' } });
        if (mode === 'followup' || agent.status !== 'running')
            agent.followup(input);
        else
            agent.steer(input);
    }
    // --- Questions and approvals -----------------------------------------------
    /** Reuse question delivery and lifecycle, but grant only an explicit approval button. */
    async approveThroughTelegram(chat, request) {
        const reason = request.displayReason?.ru ?? request.displayReason?.en ?? request.displayReason?.zh ?? request.reason ?? 'Не указана';
        try {
            const answer = await this.askThroughTelegram(chat, {
                questions: [{
                        id: 'approval',
                        header: 'Подтверждение операции',
                        question: `Инструмент: ${richLiteral(request.toolName)}`,
                        detail: [
                            ...(request.callId === undefined ? [] : [`Вызов: ${richLiteral(request.callId)}`]),
                            `**Причина запроса**\n\n${richCodeBlock(reason)}`,
                            'Подтверждение действует только для этой операции. Права рабочей области не меняются.',
                        ].join('\n\n'),
                        options: [{ label: APPROVE_ONCE }, { label: REJECT }],
                    }],
                agent: request.agent,
                ...(request.signal === undefined ? {} : { signal: request.signal }),
            }, true);
            const selected = answer.answers[0]?.selected[0];
            return selected === APPROVE_ONCE ? 'allowed-once' : selected === REJECT ? 'rejected' : 'cancelled';
        }
        catch (error) {
            const code = errorCode(error);
            return code === 'ASK_ABORTED' || code === 'ASK_CANCELLED' ? 'cancelled' : 'unavailable';
        }
    }
    /** Claim one DSH user-question request for the chat bound to its session. */
    askThroughTelegram(chat, request, approval = false) {
        if (request.signal?.aborted === true || this.stopped) {
            return Promise.reject(userQuestionError('ask_user_question was aborted before the Telegram user answered', 'ASK_ABORTED'));
        }
        if (this.pendingQuestions.has(chat.chatId)) {
            return Promise.reject(userQuestionError('another ask_user_question request is already waiting in this Telegram chat', 'ASK_BUSY'));
        }
        return new Promise((resolve, reject) => {
            const pending = {
                approval,
                chatId: chat.chatId,
                sessionId: chat.sessionId,
                token: callbackToken(),
                questions: request.questions,
                answers: [],
                resolve,
                reject,
                signal: request.signal,
                timedCallId: request.wait?.timed === true ? request.wait.callId : undefined,
                messageIds: new Set(),
                index: 0,
                selectedIndices: new Set(),
                keyboardMessageId: undefined,
                onAbort: undefined,
                continued: false,
                settled: false,
            };
            pending.onAbort = () => {
                const reason = request.signal?.reason;
                if (pending.timedCallId !== undefined && errorCode(reason) === 'ASK_TIMED_OUT')
                    this.continueTimedQuestion(pending, reason);
                else
                    this.rejectPendingQuestion(pending, userQuestionError('ask_user_question was aborted before the Telegram user answered', 'ASK_ABORTED'));
            };
            request.signal?.addEventListener('abort', pending.onAbort, { once: true });
            this.pendingQuestions.set(chat.chatId, pending);
            chat.progress?.suspend();
            void this.presentQuestion(pending).catch((error) => {
                const aborted = request.signal?.aborted === true || this.stopped;
                this.rejectPendingQuestion(pending, userQuestionError(aborted ? 'ask_user_question was aborted before the Telegram user answered'
                    : `could not deliver ask_user_question to Telegram: ${messageOf(error)}`, aborted ? 'ASK_ABORTED' : 'ASK_DELIVERY_FAILED', error));
            });
        });
    }
    /**
     * A timed wait expired: the tool call returns "pending" and the Agent keeps
     * working, while the question stays answerable here. The finished answer is
     * steered in through `userQuestions.answer`.
     */
    continueTimedQuestion(pending, reason) {
        if (pending.settled || pending.continued)
            return;
        pending.continued = true;
        if (pending.onAbort !== undefined)
            pending.signal?.removeEventListener('abort', pending.onAbort);
        const active = this.chats.get(pending.chatId)?.active;
        if (active?.sessionId === pending.sessionId) {
            // The question outlives this turn, so its messages must survive turn cleanup.
            for (const id of pending.messageIds)
                active.transientMessageIds.delete(id);
            active.progress?.resume();
        }
        pending.reject(reason);
        void this.safeSend(pending.chatId, '⏳ **Время ожидания ответа истекло**\n\nАгент продолжил работу. Ответ будет отправлен как новое сообщение. /cancel отменяет ответ.');
    }
    /** Handle one inline-keyboard choice and always dismiss Telegram's callback spinner. */
    async handleCallbackQuery(callback) {
        const message = callback.message;
        if (message === undefined || message.chat.type !== 'private' || callback.data === undefined) {
            await this.safeAnswerCallback(callback.id, 'Кнопка недоступна.', true);
            return;
        }
        if (!this.authorizedUser(callback.from)) {
            await this.safeAnswerCallback(callback.id, '⛔ Доступ запрещён', true);
            return;
        }
        if (callback.data.startsWith('menu:')) {
            await this.handleMenuCallback(callback, message.chat.id, message.message_id);
            return;
        }
        const match = /^uq:([a-f0-9]{12}):(\d+):(o\d+|d|u|s|c)$/.exec(callback.data);
        const pending = this.pendingQuestions.get(message.chat.id);
        if (match === null || pending === undefined || match[1] !== pending.token
            || Number(match[2]) !== pending.index || message.message_id !== pending.keyboardMessageId) {
            await this.safeAnswerCallback(callback.id, 'Вопрос уже недействителен.');
            return;
        }
        const question = this.currentQuestion(pending);
        const action = match[3];
        if (pending.approval && action !== 'o0' && action !== 'o1') {
            await this.safeAnswerCallback(callback.id, 'Используйте кнопки подтверждения.');
            return;
        }
        if (action.startsWith('o')) {
            const optionIndex = Number(action.slice(1));
            const option = question.options?.[optionIndex];
            if (option === undefined) {
                await this.safeAnswerCallback(callback.id, 'Вариант уже недействителен.');
            }
            else if (question.multiSelect === true) {
                if (!pending.selectedIndices.delete(optionIndex))
                    pending.selectedIndices.add(optionIndex);
                await this.safeAnswerCallback(callback.id);
                await this.refreshQuestionKeyboard(pending);
            }
            else {
                await this.safeAnswerCallback(callback.id, `Выбрано: ${option.label}`);
                await this.submitQuestionAnswer(pending, { id: question.id, selected: [option.label] });
            }
        }
        else if (action === 'd') {
            const selected = this.selectedLabels(pending);
            if (question.multiSelect !== true) {
                await this.safeAnswerCallback(callback.id, 'Кнопка устарела.');
            }
            else if (selected.length === 0) {
                await this.safeAnswerCallback(callback.id, 'Выберите хотя бы один вариант или нажмите «Пропустить».');
            }
            else {
                await this.safeAnswerCallback(callback.id, 'Выбор отправлен.');
                await this.submitQuestionAnswer(pending, { id: question.id, selected });
            }
        }
        else if (action === 'u') {
            await this.safeAnswerCallback(callback.id);
            await this.requestCustomAnswer(pending);
        }
        else if (action === 's') {
            await this.safeAnswerCallback(callback.id, 'Пропущено.');
            await this.submitQuestionAnswer(pending, { id: question.id, selected: [] });
        }
        else {
            await this.safeAnswerCallback(callback.id, 'Вопрос отменён。');
            this.rejectPendingQuestion(pending, userQuestionError('ask_user_question was cancelled by the Telegram user', 'ASK_CANCELLED'));
        }
    }
    /** Send the current item with buttons, or with a ForceReply composer for free text. */
    async presentQuestion(pending) {
        if (pending.settled)
            return;
        const active = this.chats.get(pending.chatId)?.active;
        if (active?.sessionId !== pending.sessionId) {
            throw userQuestionError('the Telegram session changed before the question was shown', 'ASK_ABORTED');
        }
        this.stopTyping(active);
        const hasOptions = (this.currentQuestion(pending).options?.length ?? 0) > 0;
        const replyMarkup = hasOptions
            ? this.questionKeyboard(pending)
            : { force_reply: true, input_field_placeholder: 'Введите ответ или /skip для пропуска', selective: true };
        const sent = await this.client.sendRichMessage(pending.chatId, this.formatQuestion(pending), this.questionSignal(pending), replyMarkup);
        this.trackQuestionMessage(pending, sent.message_id);
        if (hasOptions) {
            pending.keyboardMessageId = sent.message_id;
            if (pending.settled)
                await this.clearQuestionKeyboard(pending);
        }
    }
    /** Render a question with all details visible even when button labels must be shortened. */
    formatQuestion(pending) {
        const question = this.currentQuestion(pending);
        const heading = question.header?.trim() || (question.intent?.kind === 'plan-review' ? 'Подтверждение плана' : 'Агенту нужен ваш ответ');
        const lines = [`❓ **${heading}**`, '', `Вопрос ${pending.index + 1} / ${pending.questions.length}`, '', question.question];
        if (question.detail?.trim())
            lines.push('', question.detail);
        if (pending.approval) {
            lines.push('', '---', '', `Выберите «${APPROVE_ONCE}» или «${REJECT}». /cancel отменяет запрос.`);
            return lines.join('\n');
        }
        const options = question.options ?? [];
        if (options.length > 0) {
            lines.push('', '---', '', '**Варианты**', '');
            options.forEach((option, index) => {
                lines.push(`**${index + 1}. ${option.label}**${option.description === undefined ? '' : `\n\n${option.description}`}`, '');
            });
            lines.push('---', '', question.multiSelect === true
                ? '💡 Выберите несколько вариантов и нажмите «Готово» или введите свой ответ.'
                : '💡 Выберите один вариант или введите свой ответ.');
        }
        else {
            lines.push('', '---', '', '💡 Ответьте текстом. /skip пропускает вопрос, /cancel отменяет запрос.');
        }
        return lines.join('\n');
    }
    /** Build the current keyboard; multi-select choices show their checked state. */
    questionKeyboard(pending) {
        const question = this.currentQuestion(pending);
        const data = (action) => `uq:${pending.token}:${pending.index}:${action}`;
        const rows = (question.options ?? []).map((option, index) => [{
                text: buttonLabel(`${pending.selectedIndices.has(index) ? '✓ ' : ''}${index + 1}. ${option.label}`),
                callback_data: data(`o${index}`),
            }]);
        if (pending.approval)
            return { inline_keyboard: rows };
        rows.push(question.multiSelect === true
            ? [{ text: 'Готово', callback_data: data('d') }, { text: '✍️ Свой ответ', callback_data: data('u') }]
            : [{ text: '✍️ Свой ответ', callback_data: data('u') }]);
        rows.push([{ text: 'Пропустить', callback_data: data('s') }, { text: 'Отменить вопрос', callback_data: data('c') }]);
        return { inline_keyboard: rows };
    }
    /** Enter free-text mode after the user explicitly presses the custom-answer button. */
    async requestCustomAnswer(pending) {
        if (pending.settled)
            return;
        await this.clearQuestionKeyboard(pending);
        try {
            const sent = await this.client.sendRichMessage(pending.chatId, '✍️ **Введите свой ответ**\n\nТекст будет добавлен к выбранным вариантам.', this.questionSignal(pending), { force_reply: true, input_field_placeholder: 'Введите свой ответ', selective: true });
            this.trackQuestionMessage(pending, sent.message_id);
        }
        catch (error) {
            this.rejectPendingQuestion(pending, userQuestionError(`could not request a custom Telegram answer: ${messageOf(error)}`, 'ASK_DELIVERY_FAILED', error));
        }
    }
    /** Store one answer, then present the next question or complete the batch. */
    async submitQuestionAnswer(pending, answer) {
        if (pending.settled || answer.id !== this.currentQuestion(pending).id)
            return;
        await this.clearQuestionKeyboard(pending);
        if (pending.settled)
            return;
        pending.answers.push(answer);
        pending.index += 1;
        pending.selectedIndices = new Set();
        if (pending.index >= pending.questions.length) {
            await this.resolvePendingQuestion(pending);
            return;
        }
        try {
            await this.presentQuestion(pending);
        }
        catch (error) {
            this.rejectPendingQuestion(pending, userQuestionError(`could not deliver ask_user_question to Telegram: ${messageOf(error)}`, pending.signal?.aborted === true ? 'ASK_ABORTED' : 'ASK_DELIVERY_FAILED', error));
        }
    }
    currentQuestion(pending) {
        const question = pending.questions[pending.index];
        if (question === undefined)
            throw new Error('telegram: pending question index is out of bounds');
        return question;
    }
    /** Abort question delivery when either the bridge or a still-open DSH request ends. */
    questionSignal(pending) {
        return pending.signal === undefined || pending.continued
            ? this.abortController.signal
            : AbortSignal.any([this.abortController.signal, pending.signal]);
    }
    selectedLabels(pending) {
        const options = this.currentQuestion(pending).options ?? [];
        return [...pending.selectedIndices].sort((left, right) => left - right)
            .flatMap(index => options[index] === undefined ? [] : [options[index].label]);
    }
    /** Update checkmarks after toggling a multi-select option. */
    async refreshQuestionKeyboard(pending) {
        if (pending.keyboardMessageId === undefined || pending.settled)
            return;
        await this.editKeyboard(pending.chatId, pending.keyboardMessageId, this.questionKeyboard(pending));
    }
    /** Remove an old keyboard so it cannot submit an answer twice. */
    async clearQuestionKeyboard(pending) {
        const messageId = pending.keyboardMessageId;
        pending.keyboardMessageId = undefined;
        if (messageId !== undefined)
            await this.editKeyboard(pending.chatId, messageId, undefined);
    }
    async editKeyboard(chatId, messageId, markup) {
        try {
            await this.client.editMessageReplyMarkup(chatId, messageId, markup, this.abortController.signal);
        }
        catch (error) {
            if (!this.stopped && !isNotModified(error) && !isMissingMessage(error)) {
                this.ctx.logger.warn('[telegram] question keyboard update failed: %s', messageOf(error));
            }
        }
    }
    async resolvePendingQuestion(pending) {
        if (!this.settlePendingQuestion(pending))
            return;
        const answer = { answers: pending.answers };
        if (!pending.continued) {
            const active = this.chats.get(pending.chatId)?.active;
            if (active?.sessionId === pending.sessionId && this.ctx.agents.get(active.sessionId)?.status === 'running') {
                void this.safeAction(pending.chatId, 'typing');
                this.startTyping(active);
                active.progress?.resume();
            }
            pending.resolve(answer);
            return;
        }
        try {
            const agent = await this.resolveAgent(pending.sessionId);
            const accepted = this.ctx.get('userQuestions')?.answer(agent, pending.timedCallId, answer) ?? false;
            await this.safeSend(pending.chatId, accepted ? '✅ **Ответ отправлен агенту**' : 'ℹ️ **На вопрос уже ответили в другом интерфейсе или он устарел**');
        }
        catch (error) {
            await this.safeSend(pending.chatId, `⚠️ **Не удалось отправить ответ**\n\n${richCodeBlock(messageOf(error))}`);
        }
    }
    rejectPendingQuestion(pending, error) {
        if (!this.settlePendingQuestion(pending))
            return;
        void this.clearQuestionKeyboard(pending);
        if (pending.continued)
            return;
        const active = this.chats.get(pending.chatId)?.active;
        if (active?.sessionId === pending.sessionId)
            active.progress?.resume();
        pending.reject(error);
    }
    /** Atomically remove a pending request and its abort listener. */
    settlePendingQuestion(pending) {
        if (pending.settled)
            return false;
        pending.settled = true;
        if (this.pendingQuestions.get(pending.chatId) === pending)
            this.pendingQuestions.delete(pending.chatId);
        if (pending.onAbort !== undefined)
            pending.signal?.removeEventListener('abort', pending.onAbort);
        return true;
    }
    /** Question/answer messages are removed with the turn, unless the question outlives it. */
    trackQuestionMessage(pending, messageId) {
        pending.messageIds.add(messageId);
        const active = this.chats.get(pending.chatId)?.active;
        if (!pending.continued && active?.sessionId === pending.sessionId)
            active.transientMessageIds.add(messageId);
    }
    // --- Turn delivery ---------------------------------------------------------
    handleSessionEvent(session, event) {
        const chat = this.chatsBySession.get(session.id);
        if (chat === undefined)
            return;
        if (event.type === 'turn/start') {
            chat.progress?.dispose();
            void this.safeAction(chat.chatId, 'typing');
            this.startTyping(chat);
            chat.progress = new TelegramProgress(this.client, chat.chatId, this.abortController.signal, task => this.enqueue(chat, task), error => this.ctx.logger.warn('[telegram] preview failed: %s', messageOf(error)));
        }
        else if (event.type === 'turn/end') {
            const progress = chat.progress;
            chat.progress = undefined;
            const reason = event.data.reason.kind;
            const notice = progress?.terminalNotice(reason);
            // An aborted turn never delivers its partial answer.
            const final = reason === 'aborted' ? notice : progress?.finalMessage(notice) ?? notice;
            progress?.dispose();
            void this.enqueue(chat, async () => {
                this.stopTyping(chat);
                if (final !== undefined && !await this.deliverResult(chat, final))
                    return;
                const messageIds = [...chat.transientMessageIds];
                chat.transientMessageIds.clear();
                await this.deleteMessageIds(chat.chatId, messageIds);
            });
        }
        else {
            chat.progress?.event(event);
        }
    }
    /** Cache, then send the complete turn; a failure leaves the cache for `/resend`. */
    async deliverResult(chat, markdown) {
        try {
            await this.resultCache.deliver(chat.chatId, markdown, text => this.client.sendRichMessage(chat.chatId, text, this.abortController.signal));
            return true;
        }
        catch (error) {
            if (this.stopped)
                return false;
            this.ctx.logger.error('[telegram] result delivery failed: %s', messageOf(error));
            await this.safeSend(chat.chatId, '⚠️ **Не удалось отправить результат**\n\nПолный ответ сохранён. Повторите /resend; подробности в журнале DSH.');
            return false;
        }
    }
    /** Serialize per-chat Telegram side effects; they never interleave. */
    enqueue(chat, task) {
        chat.queue = chat.queue.then(task).catch((error) => {
            if (!this.stopped)
                this.ctx.logger.error('[telegram] chat task failed: %s', messageOf(error));
        });
        return chat.queue;
    }
    /** Delete messages in Bot API batches. */
    async deleteMessageIds(chatId, messageIds) {
        const unique = [...new Set(messageIds)];
        for (let offset = 0; offset < unique.length; offset += 100) {
            try {
                await this.client.deleteMessages(chatId, unique.slice(offset, offset + 100), this.abortController.signal);
            }
            catch (error) {
                if (this.stopped)
                    return;
                if (!isMissingMessage(error))
                    this.ctx.logger.warn('[telegram] message cleanup failed: %s', messageOf(error));
            }
        }
    }
    /** Keep Telegram's typing indicator alive while a turn runs (the action expires after ~5s). */
    startTyping(chat) {
        this.stopTyping(chat);
        chat.typingTimer = setInterval(() => { void this.safeAction(chat.chatId, 'typing'); }, 4000);
    }
    stopTyping(chat) {
        clearInterval(chat.typingTimer);
        chat.typingTimer = undefined;
    }
    /** Callback acknowledgements are best-effort but never omitted. */
    async safeAnswerCallback(callbackId, text, showAlert) {
        try {
            await this.client.answerCallbackQuery(callbackId, text === undefined ? undefined : truncateText(text, 200), showAlert, this.abortController.signal);
        }
        catch (error) {
            if (!this.stopped)
                this.ctx.logger.warn('[telegram] callback acknowledgement failed: %s', messageOf(error));
        }
    }
    /** Fixed notices use the same native Rich Markdown transport as assistant replies. */
    async safeSend(chatId, text) {
        try {
            return (await this.client.sendRichMessage(chatId, text, this.abortController.signal)).message_id;
        }
        catch (error) {
            if (!this.stopped)
                this.ctx.logger.error('[telegram] delivery failed: %s', messageOf(error));
            return undefined;
        }
    }
    async safeAction(chatId, action) {
        try {
            await this.client.sendChatAction(chatId, action, this.abortController.signal);
        }
        catch (error) {
            if (!this.stopped)
                this.ctx.logger.warn('[telegram] chat action %s failed: %s', action, messageOf(error));
        }
    }
}

