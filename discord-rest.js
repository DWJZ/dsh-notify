/**
 * Discord REST calls this plugin makes as the bot.
 *
 * The webhook channel in `notify.js` posts plain text; these are the calls that need a
 * bot identity: a message that can carry components, one that can be edited later, and
 * the interaction acknowledgement that closes a button press.
 */

/** Discord API root. */
const API = 'https://discord.com/api/v10'

/** Discord message flag that keeps a message quiet: delivered, unread, no notification. */
const SILENT_FLAG = 1 << 12

/** Post one message as the bot, so it can carry components and be edited later. */
/**
 * Post one message as the bot.
 *
 * `silent` sets Discord's `SUPPRESS_NOTIFICATIONS` flag: the message still lands in
 * the channel and still marks it unread, but it does not raise a push or desktop
 * notification. Completion notices use it — one per turn is a running commentary,
 * not something to interrupt a person for — while approvals and questions keep
 * notifying, because those are the ones waiting on an answer.
 * @param options - bot token, channel, text, optional controls, and the silent flag.
 * @returns the created message id, or the failure.
 */
export async function postAsBot({ token, channelId, text, components, silent = false, fetchImpl = fetch }) {
  try {
    const payload = components === undefined ? { content: text } : { content: text, components }
    if (silent) payload.flags = SILENT_FLAG
    const response = await fetchImpl(`${API}/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { authorization: `Bot ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) {
      return { ok: false, error: `HTTP ${String(response.status)} ${(await response.text()).slice(0, 200)}` }
    }
    const body = await response.json()
    return { ok: true, id: typeof body?.id === 'string' ? body.id : undefined }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
}

/** Replace the text and controls of a message the bot posted. */
export async function editAsBot({ token, channelId, messageId, text, components, fetchImpl = fetch }) {
  try {
    const body = components === undefined ? { content: text } : { content: text, components }
    const response = await fetchImpl(`${API}/channels/${channelId}/messages/${messageId}`, {
      method: 'PATCH',
      headers: { authorization: `Bot ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })
    return response.ok ? { ok: true } : { ok: false, error: `HTTP ${String(response.status)}` }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
}

/**
 * Answer one interaction, replacing the message it came from.
 * Discord shows a failure to the human when a callback does not arrive quickly, so the
 * caller must send this before doing anything slow.
 *
 * @param options - the callback.
 * @param options.interaction - the interaction being answered.
 * @param options.body - the callback payload.
 * @returns the outcome, never a rejection.
 */
export async function answerInteraction({ interaction, body, fetchImpl = fetch }) {
  try {
    const response = await fetchImpl(
      `${API}/interactions/${String(interaction.id)}/${String(interaction.token)}/callback`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      },
    )
    return response.ok ? { ok: true } : { ok: false, error: `HTTP ${String(response.status)}` }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
}
