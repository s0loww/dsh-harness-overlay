import { randomInt } from 'node:crypto';
import { TelegramApiError } from './client.js';
import { escapeHtml } from './format.js';
import { richBody, TelegramTranscript } from './transcript.js';
const LONG_PREVIEW = 'Полный ответ будет показан после завершения задачи.';
function previewText(text, overflow) {
    return overflow ? LONG_PREVIEW
        : /<\/?(?:details|summary)\b/i.test(text) ? 'Содержимое будет показано после завершения задачи.'
            : text;
}
/**
 * One turn's disposable preview. Events mutate bounded state synchronously; a
 * coalescer sends only the latest snapshot through the bridge's delivery queue.
 * No tool arguments or result bodies are copied into the preview.
 */
export class TelegramProgress {
    client;
    chatId;
    enqueue;
    warn;
    draftId = randomInt(1, 2 ** 31);
    started = Date.now();
    abort = new AbortController();
    signal;
    timer;
    attempt;
    revision = -1;
    text = '';
    committedPreview = '';
    committedOverflow = false;
    previewOverflow = false;
    phase = 'Обдумывание';
    activeTools = new Set();
    transcript;
    paused = false;
    waitingForUser = false;
    disposed = false;
    stoppedByUser = false;
    scheduled = false;
    epoch = 0;
    dirty = true;
    nextSend = 0;
    lastSent = 0;
    constructor(client, chatId, signal, enqueue, warn) {
        this.client = client;
        this.chatId = chatId;
        this.enqueue = enqueue;
        this.warn = warn;
        this.transcript = new TelegramTranscript();
        this.signal = AbortSignal.any([signal, this.abort.signal]);
        this.timer = setInterval(() => this.schedule(), 1200);
        this.schedule();
    }
    /** Reject old attempts and revisions, including late chunks after a retry. */
    stream(frame) {
        if (this.disposed || frame.revision <= this.revision)
            return;
        this.revision = frame.revision;
        if (frame.type === 'start') {
            this.attempt = frame.attemptId;
            this.text = '';
            this.previewOverflow = false;
            this.phase = 'Обдумывание';
            this.changed();
        }
        else if (frame.attemptId === this.attempt && frame.type === 'chunk') {
            if (frame.chunk.type === 'text-delta') {
                // Never truncate rich syntax: a missing closing tag/fence can leave an
                // unusable disclosure. Stop previewing this attempt once it is too long.
                if (!this.previewOverflow) {
                    if (this.text.length + frame.chunk.text.length > 16000) {
                        this.previewOverflow = true;
                        this.text = '';
                    }
                    else
                        this.text += frame.chunk.text;
                }
                this.phase = 'Подготовка ответа';
            }
            else if (frame.chunk.type === 'reasoning-delta') {
                this.phase = 'Обдумывание';
            }
            else if (frame.chunk.type === 'tool-call-delta') {
                this.phase = 'Подготовка инструмента';
            }
            else
                return;
            this.changed();
        }
        else if (frame.attemptId === this.attempt && frame.type === 'end'
            && (frame.outcome.kind === 'abandoned' || frame.outcome.eventType === 'assistant/attempt')) {
            this.text = '';
            this.previewOverflow = false;
            this.phase = 'Ожидание повторной попытки';
            this.changed();
        }
    }
    event(event) {
        if (this.disposed)
            return;
        this.transcript.event(event);
        if (event.type === 'assistant/message') {
            if (event.surfaceOp !== undefined && event.surfaceOp !== 'append')
                return;
            // Transfer the authoritative message into the preview history exactly
            // once. Status changes and new attempts must not erase completed steps.
            const text = event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('');
            const body = richBody(previewText(text, text.length > 16000));
            const combined = [this.committedPreview, body].filter(part => part.trim()).join('\n\n---\n\n');
            if (!this.committedOverflow) {
                if (combined.length > 16000)
                    this.committedOverflow = true;
                else
                    this.committedPreview = combined;
            }
            this.text = '';
            this.previewOverflow = false;
            this.attempt = undefined;
            this.changed();
        }
        else if (event.type === 'tool/call') {
            this.activeTools.add(event.data.callId);
            this.phase = 'Выполнение инструмента';
            this.changed();
        }
        else if (event.type === 'tool/result') {
            this.activeTools.delete(event.data.message.toolCallId);
            this.phase = this.activeTools.size ? 'Выполнение инструмента' : 'Обработка результата инструмента';
            this.changed();
        }
        else if (event.type === 'step/start') {
            this.text = '';
            this.previewOverflow = false;
            this.phase = `Обдумывание · шаг ${event.data.step}`;
            this.changed();
        }
    }
    changed() {
        this.paused = this.waitingForUser;
        this.dirty = true;
        this.schedule();
    }
    /** Invalidate queued previews before a persisted assistant message or user question. */
    pause() {
        this.paused = true;
        this.epoch++;
    }
    suspend() {
        this.waitingForUser = true;
        this.pause();
    }
    resume() {
        this.waitingForUser = false;
        if (!this.disposed)
            this.changed();
    }
    dispose() {
        this.disposed = true;
        this.pause();
        clearInterval(this.timer);
        this.abort.abort();
    }
    stopByUser() {
        this.stoppedByUser = true;
        this.dispose();
    }
    /** A terminal message clears a tool-only/failed draft even without an assistant answer. */
    terminalNotice(reason) {
        if (this.stoppedByUser)
            return undefined;
        if (reason === 'completed')
            return this.transcript.answer.trim() ? undefined : '✅ **Задача завершена**';
        if (reason === 'aborted' || reason === 'interrupted')
            return '⏹ **Задача остановлена**';
        if (reason === 'error')
            return '⚠️ **Ошибка выполнения задачи**，См. журнал DSH.';
        if (reason === 'blocked')
            return '⚠️ **Задача временно не может продолжаться**';
        if (reason === 'max-tokens')
            return '⚠️ **Достигнут предел длины ответа**';
        return 'ℹ️ **Задача завершена**';
    }
    /**
     * The complete turn as one rich message: folded intermediate messages, then
     * the answer (or `notice` when the turn produced none). Includes late tool
     * results and reasoning-only turns; `undefined` when nothing was recorded.
     */
    finalMessage(notice) {
        if (this.stoppedByUser || !this.transcript.hasEntries)
            return undefined;
        const answer = notice ?? this.transcript.answer;
        const markdown = [this.transcript.render(answer), answer].filter(part => part.trim()).join('\n\n');
        return markdown || undefined;
    }
    status() {
        return `${this.phase} · ${Math.floor((Date.now() - this.started) / 1000)} с`;
    }
    schedule() {
        if (this.disposed || this.paused || this.scheduled || Date.now() < this.nextSend
            || (!this.dirty && Date.now() - this.lastSent < 12000))
            return;
        this.scheduled = true;
        const epoch = this.epoch;
        void this.enqueue(async () => {
            try {
                if (this.disposed || this.paused || epoch !== this.epoch || this.signal.aborted)
                    return;
                this.dirty = false;
                await this.send();
                this.lastSent = Date.now();
                this.nextSend = Date.now() + 1200;
            }
            catch (error) {
                if (this.signal.aborted)
                    return;
                this.dirty = true;
                if (error instanceof TelegramApiError && error.code === 429) {
                    const delay = Number.isFinite(error.retryAfter) ? Math.max(1, error.retryAfter) : 5;
                    this.nextSend = Date.now() + delay * 1000;
                }
                else if (/not modified/i.test(String(error))) {
                    this.nextSend = Date.now() + 1200;
                }
                else {
                    this.nextSend = Date.now() + 5000;
                    this.warn(error);
                }
            }
            finally {
                this.scheduled = false;
            }
        });
    }
    async send() {
        const status = this.status();
        // One stable draft per turn: replacing its ID makes Telegram remove and
        // recreate the preview on every update.
        // Partial disclosures may have only a summary (or an unfinished body).
        // Leave them to committed delivery, where the complete source is available.
        let current = previewText(this.text, this.previewOverflow);
        if (this.committedOverflow || this.committedPreview.length + current.length > 16000)
            current = LONG_PREVIEW;
        const preview = [
            this.committedPreview.trim() ? `### Ход работы\n\n${this.committedPreview}` : '',
            current.trim() ? `### Формирование ответа\n\n${richBody(current)}` : '',
        ].filter(Boolean).join('\n\n---\n\n');
        await this.client.sendRichMessageDraft(this.chatId, this.draftId, `<tg-thinking>${escapeHtml(status)}</tg-thinking>\n\n${preview}`, this.signal);
    }
}

