/**
 * Formatting, de-duplication, and delivery for human-attention notifications.
 *
 * Formatting is pure: every function takes the facts it needs and returns text.
 * Delivery is a list of channels; each channel is a small object with one
 * `deliver(text)` method, built from explicit config so nothing is read from
 * ambient state. iMessage shells out to `osascript` (the only local way to send)
 * and Discord posts to a channel webhook.
 *
 * @module dsh-notify/notify
 */
import { spawn } from 'node:child_process'

/** AppleScript run once per message; `argv` carries the recipient and the body. */
const SEND_SCRIPT = [
  'on run argv',
  '  set target to item 1 of argv',
  '  set body to item 2 of argv',
  '  tell application "Messages"',
  '    set theBuddy to buddy target',
  '    send body to theBuddy',
  '  end tell',
  'end run',
  '',
].join('\n')

/** One-line cap for any quoted detail, in characters. */
export const DETAIL_LIMIT = 240

/**
 * Collapse whitespace and cut one detail string to its display limit.
 * @param value - the raw detail.
 * @returns the single-line detail, or the empty string.
 */
export function condense(value) {
  if (typeof value !== 'string') return ''
  const flat = value.replaceAll(/\s+/g, ' ').trim()
  return flat.length <= DETAIL_LIMIT ? flat : `${flat.slice(0, DETAIL_LIMIT - 1)}…`
}

/**
 * The Session facts every notification names.
 * @param session - an Agent's Session, as the request events carry it.
 * @returns the short id, project name, and title to show.
 */
export function sessionFacts(session) {
  const id = typeof session?.id === 'string' ? session.id : ''
  const header = session?.header ?? {}
  const cwd = typeof header.cwd === 'string' ? header.cwd : ''
  const project = cwd === '' ? '' : cwd.split('/').filter(Boolean).at(-1) ?? ''
  const title = typeof header.title === 'string' && header.title !== '' ? header.title : ''
  return {
    shortId: id.length > 20 ? `${id.slice(0, 20)}…` : id,
    project,
    title,
  }
}

/**
 * Render the notification for a pending approval.
 * @param facts - the request facts.
 * @param facts.session - the Session awaiting the decision.
 * @param facts.toolName - the tool whose operation needs a decision.
 * @param facts.reason - the asker's own reason, when it supplied one.
 * @param facts.displayReason - localized presentation text, when supplied.
 * @param facts.label - the sender tag shown first, so the message is never mistaken
 *   for something the human typed.
 * @param facts.sessionLabel - pre-rendered session identity; falls back to the log header.
 * @returns the message body.
 */
export function formatApproval({ session, toolName, reason, displayReason, label = 'DSH', sessionLabel }) {
  const { shortId, project, title } = sessionFacts(session)
  const localized = displayReason?.zh ?? displayReason?.en
  const detail = condense(localized ?? reason ?? '')
  return [
    `【${label}】需要你确认`,
    `会话：${sessionLabel ?? (title === '' ? `${project === '' ? '' : `${project} · `}${shortId}` : `${title}${project === '' ? '' : `（${project}）`}`)}`,
    `事项：${toolName === '' ? '待确认的操作' : toolName}`,
    ...detail === '' ? [] : [`详情：${detail}`],
  ].join('\n')
}

/**
 * Render the notification for pending questions.
 * @param facts - the request facts.
 * @param facts.session - the Session awaiting the answers.
 * @param facts.questions - the questions to display.
 * @param facts.label - the sender tag shown first.
 * @param facts.sessionLabel - pre-rendered session identity; falls back to the log header.
 * @returns the message body.
 */
export function formatQuestions({ session, questions, label = 'DSH', sessionLabel }) {
  const { shortId, project, title } = sessionFacts(session)
  const list = Array.isArray(questions) ? questions : []
  const lines = list.slice(0, 3).map((item, position) => {
    const asked = condense(item?.question ?? '')
    const heading = condense(item?.header ?? '')
    const headingLabel = heading === '' ? `问题 ${String(position + 1)}` : heading
    return `${headingLabel}：${asked === '' ? '（无正文）' : asked}`
  })
  return [
    `【${label}】在等你选择`,
    `会话：${sessionLabel ?? (title === '' ? `${project === '' ? '' : `${project} · `}${shortId}` : `${title}${project === '' ? '' : `（${project}）`}`)}`,
    ...list.length > 3 ? [`共 ${String(list.length)} 个问题，前三个：`] : [],
    ...lines,
  ].join('\n')
}

/**
 * Build the stateful pieces delivery needs.
 *
 * The return value owns the only mutable state in this module: which keys were
 * already announced and when the last message left. Both exist to keep one
 * pending decision from producing a burst of messages.
 *
 * @param options - the policy.
 * @param options.ttlMs - how long one announced key stays suppressed.
 * @param options.minGapMs - minimum spacing between two messages.
 * @param options.now - clock, injectable for tests.
 * @returns the de-duplication decision function.
 */
export function createAnnouncer({ ttlMs = 300_000, minGapMs = 2_000, now = Date.now } = {}) {
  const announced = new Map()
  let lastSentAt = Number.NEGATIVE_INFINITY

  /**
   * Decide whether one request still needs a message.
   * @param key - the request's identity, stable across repeats of one decision.
   * @returns true when the caller should send, false when it is a repeat.
   */
  return function shouldAnnounce(key) {
    const at = now()
    for (const [seen, when] of announced) {
      if (at - when > ttlMs) announced.delete(seen)
    }
    if (announced.has(key)) return false
    if (at - lastSentAt < minGapMs) return false
    announced.set(key, at)
    lastSentAt = at
    return true
  }
}

/**
 * Send one iMessage through the Messages application.
 *
 * The promise always settles: a notification is best effort, and a failure must
 * never reach the approval flow that triggered it.
 *
 * @param options - what to send.
 * @param options.recipient - the buddy handle: a phone number or Apple ID.
 * @param options.text - the message body.
 * @param options.timeoutMs - how long to wait before killing the send.
 * @returns the outcome, never a rejection.
 */
export function sendIMessage({ recipient, text, timeoutMs = 15_000 }) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (outcome) => {
      if (settled) return
      settled = true
      resolve(outcome)
    }
    let child
    try {
      child = spawn('osascript', ['-', recipient, text], { stdio: ['pipe', 'ignore', 'pipe'] })
    } catch (error) {
      finish({ ok: false, error: String(error) })
      return
    }
    const guard = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ ok: false, error: `osascript timed out after ${String(timeoutMs)} ms` })
    }, timeoutMs)
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', (error) => {
      clearTimeout(guard)
      finish({ ok: false, error: String(error) })
    })
    child.on('close', (code) => {
      clearTimeout(guard)
      finish(code === 0 ? { ok: true } : { ok: false, error: stderr.trim() || `exit ${String(code)}` })
    })
    child.stdin.on('error', () => {})
    child.stdin.end(SEND_SCRIPT)
  })
}

/**
 * Post one message to a Discord channel webhook.
 * @param options - what to send.
 * @param options.webhookUrl - the channel webhook URL.
 * @param options.text - the message body.
 * @param options.timeoutMs - request timeout.
 * @returns the outcome, never a rejection.
 */
export async function sendDiscord({ webhookUrl, text, timeoutMs = 15_000 }) {
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: text }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (response.ok) return { ok: true }
    const body = await response.text().catch(() => '')
    return { ok: false, error: `HTTP ${String(response.status)} ${body.slice(0, 200)}` }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
}

/**
 * Build the delivery channels named by the configuration.
 * @param config - resolved settings.
 * @param config.discordWebhookUrl - Discord webhook URL, when configured.
 * @param config.imessageRecipient - iMessage handle, when configured.
 * @returns one channel per configured destination, each with `deliver(text)`.
 */
export function createChannels({ discordWebhookUrl, imessageRecipient }) {
  const channels = []
  if (typeof discordWebhookUrl === 'string' && discordWebhookUrl !== '') {
    channels.push({
      name: 'discord',
      deliver: (text) => sendDiscord({ webhookUrl: discordWebhookUrl, text }),
    })
  }
  if (typeof imessageRecipient === 'string' && imessageRecipient !== '') {
    channels.push({
      name: 'imessage',
      deliver: (text) => sendIMessage({ recipient: imessageRecipient, text }),
    })
  }
  return channels
}
