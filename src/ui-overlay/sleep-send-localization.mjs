const NS = 'dsh-sleep-send'

const EN = Object.freeze({
  'weekday.0': 'Sunday',
  'weekday.1': 'Monday',
  'weekday.2': 'Tuesday',
  'weekday.3': 'Wednesday',
  'weekday.4': 'Thursday',
  'weekday.5': 'Friday',
  'weekday.6': 'Saturday',
  today: 'Today',
  tomorrow: 'Tomorrow',
  'date.full': '{month}/{day} {weekday}',
  'duration.hoursMinutes': '{hours} h {minutes} min',
  'duration.minutesSeconds': '{minutes} min {seconds} sec',
  'duration.seconds': '{seconds} sec',
  'channel.unavailableExecution': 'The send channel is unavailable; the scheduled message was not sent.',
  'draft.changedCancelled': 'The draft changed; this scheduled message was cancelled.',
  'channel.unavailableRefresh': 'The send channel is unavailable. Refresh the page and try again.',
  'schedule.countNext': '{count} scheduled · next {next}',
  'schedule.send': 'Schedule send',
  'schedule.enterMessage': 'Enter a message first',
  'schedule.short': 'Timer',
  'schedule.settings': 'Scheduled-send settings',
  'schedule.cancelAll': 'Cancel all scheduled messages',
  'schedule.sent': 'Sent',
  'schedule.notSent': 'Not sent',
  'mode.smart': 'Smart window',
  'mode.custom': 'Custom time',
  'window.available': 'Available send windows',
  'window.overnight': ' – next day ',
  'window.hint': 'Automatically picks the nearest time in either window',
  'day.afterTomorrow': 'Day after tomorrow',
  'send.time': 'Send time',
  'send.after': 'in about {duration}',
  'preview.title': 'Message preview',
  'preview.empty': 'Enter the message to send first',
  'schedule.count': '{count} scheduled',
  'schedule.delete': 'Delete this scheduled message',
  'schedule.confirmHint': 'The input clears after confirmation; changing the draft before send cancels this item.',
  'schedule.addAt': 'Add · send at {time}',
  'schedule.dialog': 'Scheduled send',
})

const ZH = Object.freeze({
  'weekday.0': '周日',
  'weekday.1': '周一',
  'weekday.2': '周二',
  'weekday.3': '周三',
  'weekday.4': '周四',
  'weekday.5': '周五',
  'weekday.6': '周六',
  today: '今天',
  tomorrow: '明天',
  'date.full': '{month}月{day}日 {weekday}',
  'duration.hoursMinutes': '{hours} 小时 {minutes} 分',
  'duration.minutesSeconds': '{minutes} 分 {seconds} 秒',
  'duration.seconds': '{seconds} 秒',
  'channel.unavailableExecution': '发送通道不可用，定时发送未执行',
  'draft.changedCancelled': '输入框内容已变更，本次定时发送已取消',
  'channel.unavailableRefresh': '发送通道不可用，请刷新页面后重试',
  'schedule.countNext': '已设定 {count} 个定时任务 · 下次 {next}',
  'schedule.send': '定时发送',
  'schedule.enterMessage': '请先输入消息内容',
  'schedule.short': '定时',
  'schedule.settings': '定时发送配置',
  'schedule.cancelAll': '取消全部定时任务',
  'schedule.sent': '已发送',
  'schedule.notSent': '未发送',
  'mode.smart': '智能时段',
  'mode.custom': '自定义时间',
  'window.available': '可用发送时段',
  'window.overnight': ' – 次日 ',
  'window.hint': '自动选取两个时段内最近的可发送时间',
  'day.afterTomorrow': '后天',
  'send.time': '发送时间',
  'send.after': '约 {duration} 后',
  'preview.title': '消息预览',
  'preview.empty': '请先输入要发送的消息',
  'schedule.count': '已设定 {count} 个定时任务',
  'schedule.delete': '删除此任务',
  'schedule.confirmHint': '确认后输入框将清空；发送前若修改了草稿，该任务会自动取消',
  'schedule.addAt': '加入 · {time} 发送',
  'schedule.dialog': '定时发送',
})

function exact(source, before, after, label) {
  const first = source.indexOf(before)
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`SLEEP_SEND_LOCALIZATION_SOURCE_MISMATCH: ${label}`)
  }
  return `${source.slice(0, first)}${after}${source.slice(first + before.length)}`
}

function dictionaryBlock() {
  return `
    const LOCALE_NS = ${JSON.stringify(NS)};
    const en = ${JSON.stringify(EN)};
    const zh = ${JSON.stringify(ZH)};
    let translate = (key, params = {}) => {
      const template = zh[key] || en[key] || key;
      return template.replace(/\\{([A-Za-z0-9_]+)\\}/g, (_, name) => String(params[name] ?? ""));
    };
    const t = (key, params) => translate(key, params);
`
}

export function localizeSleepSendClient(raw) {
  let source = String(raw)
  source = exact(source, '    const DAY_NAMES = ["\u5468\u65e5", "\u5468\u4e00", "\u5468\u4e8c", "\u5468\u4e09", "\u5468\u56db", "\u5468\u4e94", "\u5468\u516d"];', '    const DAY_NAMES = ["weekday.0", "weekday.1", "weekday.2", "weekday.3", "weekday.4", "weekday.5", "weekday.6"];', 'weekdays')
  source = exact(source, '      const day = kd === kt ? "\u4eca\u5929" : kd === ktm ? "\u660e\u5929" : (d.getMonth() + 1) + "\u6708" + d.getDate() + "\u65e5 " + DAY_NAMES[d.getDay()];', '      const day = kd === kt ? t("today") : kd === ktm ? t("tomorrow") : t("date.full", { month: String(d.getMonth() + 1), day: String(d.getDate()), weekday: t(DAY_NAMES[d.getDay()]) });', 'date-format')
  source = exact(source, '      if (h > 0) return h + " \u5c0f\u65f6 " + m + " \u5206";\n      if (m > 0) return m + " \u5206 " + x + " \u79d2";\n      return x + " \u79d2";', '      if (h > 0) return t("duration.hoursMinutes", { hours: String(h), minutes: String(m) });\n      if (m > 0) return t("duration.minutesSeconds", { minutes: String(m), seconds: String(x) });\n      return t("duration.seconds", { seconds: String(x) });', 'duration-format')
  source = exact(source, '    const inject = ["slots"];', '    const inject = ["slots", "locale"];', 'locale-inject')
  source = exact(source, '    function apply(ctx) {\n      const slots = ctx.get("slots");', '    function apply(ctx) {\n      ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), "dsh-sleep-send: copy dictionaries");\n      translate = ctx.locale.bind(LOCALE_NS);\n      const slots = ctx.get("slots");', 'locale-bind')

  const replacements = [
    ['"\u53d1\u9001\u901a\u9053\u4e0d\u53ef\u7528\uff0c\u5b9a\u65f6\u53d1\u9001\u672a\u6267\u884c"', 't("channel.unavailableExecution")', 'unavailable-execution'],
    ['"\u8f93\u5165\u6846\u5185\u5bb9\u5df2\u53d8\u66f4\uff0c\u672c\u6b21\u5b9a\u65f6\u53d1\u9001\u5df2\u53d6\u6d88"', 't("draft.changedCancelled")', 'draft-cancelled'],
    ['"\u53d1\u9001\u901a\u9053\u4e0d\u53ef\u7528\uff0c\u8bf7\u5237\u65b0\u9875\u9762\u540e\u91cd\u8bd5"', 't("channel.unavailableRefresh")', 'unavailable-refresh'],
    ['"\u5df2\u8bbe\u5b9a " + list.length + " \u4e2a\u5b9a\u65f6\u4efb\u52a1 \u00b7 \u4e0b\u6b21 " + fmtWhen(next.target)', 't("schedule.countNext", { count: String(list.length), next: fmtWhen(next.target) })', 'count-next'],
    ['(canArm ? "\u5b9a\u65f6\u53d1\u9001" : "\u8bf7\u5148\u8f93\u5165\u6d88\u606f\u5185\u5bb9")', '(canArm ? t("schedule.send") : t("schedule.enterMessage"))', 'schedule-send'],
    ['"\u5b9a\u65f6"', 't("schedule.short")', 'short'],
    ['"\u53d6\u6d88\u5168\u90e8\u5b9a\u65f6\u4efb\u52a1"', 't("schedule.cancelAll")', 'cancel-all'],
    ['"\u2713 \u5df2\u53d1\u9001"', '"\u2713 " + t("schedule.sent")', 'sent'],
    ['"\u2715 \u672a\u53d1\u9001"', '"\u2715 " + t("schedule.notSent")', 'not-sent'],
    ['"\u667a\u80fd\u65f6\u6bb5"', 't("mode.smart")', 'mode-smart'],
    ['"\u81ea\u5b9a\u4e49\u65f6\u95f4"', 't("mode.custom")', 'mode-custom'],
    ['"\u53ef\u7528\u53d1\u9001\u65f6\u6bb5"', 't("window.available")', 'window-available'],
    ['" \u2013 \u6b21\u65e5 "', 't("window.overnight")', 'overnight'],
    ['"\u81ea\u52a8\u9009\u53d6\u4e24\u4e2a\u65f6\u6bb5\u5185\u6700\u8fd1\u7684\u53ef\u53d1\u9001\u65f6\u95f4"', 't("window.hint")', 'window-hint'],
    ['"\u4eca\u5929"', 't("today")', 'today-button'],
    ['"\u660e\u5929"', 't("tomorrow")', 'tomorrow-button'],
    ['"\u540e\u5929"', 't("day.afterTomorrow")', 'day-after-tomorrow'],
    ['"\u53d1\u9001\u65f6\u95f4"', 't("send.time")', 'send-time'],
    ['"\u7ea6 " + fmtLeft(target - Date.now()) + " \u540e"', 't("send.after", { duration: fmtLeft(target - Date.now()) })', 'send-after'],
    ['"\u6d88\u606f\u9884\u89c8"', 't("preview.title")', 'preview-title'],
    ['"\u8bf7\u5148\u8f93\u5165\u8981\u53d1\u9001\u7684\u6d88\u606f"', 't("preview.empty")', 'preview-empty'],
    ['"\u5df2\u8bbe\u5b9a " + list.length + " \u4e2a\u5b9a\u65f6\u4efb\u52a1"', 't("schedule.count", { count: String(list.length) })', 'schedule-count'],
    ['"\u5220\u9664\u6b64\u4efb\u52a1"', 't("schedule.delete")', 'delete-task'],
    ['"\u786e\u8ba4\u540e\u8f93\u5165\u6846\u5c06\u6e05\u7a7a\uff1b\u53d1\u9001\u524d\u82e5\u4fee\u6539\u4e86\u8349\u7a3f\uff0c\u8be5\u4efb\u52a1\u4f1a\u81ea\u52a8\u53d6\u6d88"', 't("schedule.confirmHint")', 'confirm-hint'],
    ['"\u52a0\u5165 \u00b7 " + fmtHM(target) + " \u53d1\u9001"', 't("schedule.addAt", { time: fmtHM(target) })', 'add-at'],
  ]
  for (const [before, after, label] of replacements) source = exact(source, before, after, label)

  // The remaining two occurrences are the dialog aria/title and the two slot labels.
  source = source.replaceAll('"\u5b9a\u65f6\u53d1\u9001"', 't("schedule.dialog")')
  source = source.replaceAll('"\u5b9a\u65f6\u53d1\u9001\u914d\u7f6e"', 't("schedule.settings")')
  source = exact(source, '    const createElement = react.createElement;\n', `    const createElement = react.createElement;\n${dictionaryBlock()}`, 'dictionary-anchor')
  if (!source.includes('ctx.locale.bind(LOCALE_NS)') || !source.includes('ctx.locale.register(LOCALE_NS, { zh, en })')) {
    throw new Error('SLEEP_SEND_LOCALIZATION_ADAPTER_INCOMPLETE')
  }
  return source
}

export const sleepSendLocalization = Object.freeze({
  id: 'dsh-sleep-send-official-locale-adapter',
  namespace: NS,
  sourceLanguage: 'zh',
  fallbackLanguage: 'en',
  mechanism: '@deepseek-ai/dsh-client-locale register/bind',
})
