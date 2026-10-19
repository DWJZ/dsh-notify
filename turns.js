/**
 * The turn notice: what a finished turn says, and which turns deserve saying it.
 *
 * The text is composed here once and used twice — the Discord message and the browser
 * notice both carry these two lines — so this module is the only place that decides what
 * a completion says.
 */

import {
  formatTurnNotice, isGoalRound, messageText, oneLine, TURN_REPLY_LIMIT, TURN_REQUEST_LIMIT,
} from './notify.js'

/**
 * Announce every turn the person started, and skip the ones a goal round drove.
 *
 * @param options - the plugin context and the collaborators the notice needs.
 * @param options.ctx - the plugin context; only event subscription and the logger are used.
 * @param options.turnChannels - where the Discord notice goes.
 * @param options.deliverTo - posts one body to a channel list.
 * @param options.labels - the Session and Workspace namers.
 * @param options.publishNotice - hands the same two lines to the browser half.
 */
export function watchTurns({ ctx, turnChannels, deliverTo, labels, publishNotice }) {
  /** Last observed request per Session, for the next completion notice. */
  const asked = new Map()
  /** Last observed reply per Session. */
  const answered = new Map()
  /**
   * Whether the turn running in a Session was started by a goal continuation.
   *
   * The round driver admits its own prompt, marked `<goal_round>…</goal_round>`
   * (`packages/goal/goal-round-driver/src/prompt.ts`), and those rounds can run one
   * after another unattended. Announcing each one would bury the notices that matter,
   * so they stay silent; a turn the person actually started still speaks.
   */
  const selfDriven = new Map()

  ctx.on('session/event', (session, event) => {
    const id = session?.id
    if (typeof id !== 'string') return
    if (event?.type === 'user/message') {
      const text = oneLine(messageText(event.data), TURN_REQUEST_LIMIT)
      if (text !== '') asked.set(id, text)
      selfDriven.set(id, isGoalRound(text))
      return
    }
    if (event?.type === 'assistant/message') {
      const text = oneLine(messageText(event.data), TURN_REPLY_LIMIT)
      if (text !== '') answered.set(id, text)
      return
    }
    if (event?.type !== 'turn/end') return
    if (selfDriven.get(id) === true) return
    try {
      const notice = formatTurnNotice({
        session,
        reason: event.data?.reason,
        sessionLabel: labels.sessionName(session),
        workspaceLabel: labels.workspaceLabel(session),
        asked: asked.get(id) ?? '',
        answered: answered.get(id) ?? '',
      })
      deliverTo(turnChannels, `${notice.title}\n${notice.body}`, 'the turn result')
      // The browser shows the same two lines; it must not compose them itself.
      publishNotice(session, notice)
    } catch (failure) {
      ctx.logger.warn(`dsh-notify: turn notification failed: ${String(failure)}`)
    }
  })
}
