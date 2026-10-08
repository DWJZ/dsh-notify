/**
 * Reading replies from a Discord channel.
 *
 * A webhook can only post, so replies need a bot: this module reads the channel
 * over the REST API on a short interval. Polling beats a Gateway websocket here —
 * no reconnection storm, no session resume, and a few seconds of latency is
 * irrelevant for an approval that is already waiting.
 *
 * Every function that decides something is pure; the poller owns only the cursor
 * (the last message id it has seen) and a timer.
 *
 * @module dsh-notify/discord
 */
const API = 'https://discord.com/api/v10'

/** Characters used for a correlation code, minus ones that look alike. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/**
 * Mint a short correlation code.
 * @param length - how many characters to produce.
 * @param random - source of randomness, injectable for tests.
 * @returns the code, upper case.
 */
export function makeCode(length = 4, random = Math.random) {
  let code = ''
  for (let index = 0; index < length; index += 1) {
    code += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)]
  }
  return code
}

/**
 * Read one reply addressed to a correlation code.
 *
 * The code must come first so several pending items can share one channel:
 * `A7F3 y`, `B2C9 1`, `C3D4 用预发环境`.
 *
 * @param content - the raw message text.
 * @param code - the code this reply must name.
 * @returns the body after the code, or null when this message is not for it.
 */
export function parseReply(content, code) {
  if (typeof content !== 'string') return null
  const trimmed = content.trim()
  if (trimmed === '') return null
  const match = /^([A-Za-z0-9]{4,8})\b[\s:：，,、]*(.*)$/su.exec(trimmed)
  if (match === null) return null
  if (match[1].toUpperCase() !== code.toUpperCase()) return null
  return match[2].trim()
}

/**
 * Turn a reply body into a yes/no decision for an approval.
 * @param body - the text after the code.
 * @returns the approval outcome, or null when the body is not a decision.
 */
export function approvalFromReply(body) {
  const normalized = body.trim().toLowerCase()
  if (['y', 'yes', 'allow', 'ok', '好', '可以', '允许', '是', '同意'].includes(normalized)) return 'allowed-once'
  if (['n', 'no', 'reject', 'deny', '不', '拒绝', '否', '不行'].includes(normalized)) return 'rejected'
  return null
}

/**
 * Turn a reply body into an answer for one question.
 *
 * Numbers select option labels; anything else becomes the free-text answer, which
 * is what a UI shows as "Other".
 *
 * @param question - the pending question.
 * @param body - the text after the code.
 * @returns the answer item, or null when there is nothing to answer.
 */
export function answerFromReply(question, body) {
  const trimmed = body.trim()
  if (trimmed === '') return null
  const options = Array.isArray(question?.options) ? question.options : []
  const selected = []
  let custom
  const numbers = [...trimmed.matchAll(/\d+/gu)].map(match => Number(match[0]))
  if (numbers.length > 0 && options.length > 0
    && numbers.every(number => number >= 1 && number <= options.length)) {
    for (const number of numbers) {
      const option = options[number - 1]
      const label = typeof option === 'string' ? option : option?.label
      if (typeof label === 'string' && label !== '' && !selected.includes(label)) selected.push(label)
    }
  } else {
    custom = trimmed
  }
  if (selected.length === 0 && custom === undefined) return null
  return {
    id: question.id,
    selected,
    ...custom === undefined ? {} : { custom },
  }
}

/**
 * Read messages the bot has not seen yet.
 * @param options - the read request.
 * @param options.token - bot token.
 * @param options.channelId - channel to read.
 * @param options.after - only messages after this id; omit to read the newest page.
 * @param options.limit - page size.
 * @param options.fetchImpl - fetch implementation, injectable for tests.
 * @returns the messages, oldest first, or a failure.
 */
export async function fetchMessages({ token, channelId, after, limit = 50, fetchImpl = fetch }) {
  const query = new URLSearchParams({ limit: String(limit) })
  if (after !== undefined) query.set('after', after)
  try {
    const response = await fetchImpl(`${API}/channels/${channelId}/messages?${query.toString()}`, {
      headers: { authorization: `Bot ${token}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) {
      return { ok: false, error: `HTTP ${String(response.status)} ${(await response.text()).slice(0, 200)}` }
    }
    const body = await response.json()
    const messages = Array.isArray(body) ? body : []
    messages.sort((left, right) => (BigInt(left.id) < BigInt(right.id) ? -1 : 1))
    return { ok: true, messages }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
}

/**
 * Watch a channel for replies addressed to this plugin.
 *
 * @param options - the watch configuration.
 * @param options.token - bot token.
 * @param options.channelId - channel to read.
 * @param options.allowedUserId - the only author whose replies are accepted.
 * @param options.intervalMs - poll interval.
 * @param options.onReply - called with `{ code, body, message }`; return true to consume.
 * @param options.log - receives warnings for read failures.
 * @param options.now - clock, injectable for tests.
 * @returns start/stop and one-shot poll for tests.
 */
export function createReplyPoller({
  token,
  channelId,
  allowedUserId,
  intervalMs = 3_000,
  onReply,
  log = () => {},
  fetchImpl = fetch,
}) {
  let cursor
  let timer
  let running = false

  /**
   * Read once and hand every fresh, accepted message to `onReply`.
   * @returns when this pass has finished; never throws.
   */
  async function pollOnce() {
    const page = await fetchMessages({
      token, channelId, limit: 50, fetchImpl,
      ...cursor === undefined ? {} : { after: cursor },
    })
    if (!page.ok) {
      log(`discord read failed: ${page.error}`)
      return
    }
    for (const message of page.messages) {
      if (cursor === undefined || BigInt(message.id) > BigInt(cursor)) cursor = message.id
      if (message.author?.id !== allowedUserId || message.author?.bot === true) continue
      onReply({ content: typeof message.content === 'string' ? message.content : '', message })
    }
  }

  /** Seed the cursor from the newest message, then poll on the interval. */
  async function start() {
    if (running) return
    running = true
    const newest = await fetchMessages({ token, channelId, limit: 1, fetchImpl })
    if (newest.ok && newest.messages.length > 0) cursor = newest.messages.at(-1).id
    else if (!newest.ok) log(`discord read failed while seeding: ${newest.error}`)
    timer = setInterval(() => { void pollOnce() }, intervalMs)
    if (typeof timer.unref === 'function') timer.unref()
  }

  /** Stop polling. */
  function stop() {
    running = false
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
  }

  return { start, stop, pollOnce, cursorOf: () => cursor }
}
