/**
 * `dsh-notify` — answer a Session's questions from Discord.
 *
 * Two seams matter, and this plugin is an observer on both: `approval/request` (the
 * agent needs permission) and `user-questions/request` (the agent needs a choice).
 * Both are waterfalls, and a waterfall is a chain: returning without `next()` silences
 * every inner listener, so this plugin always delegates first — the Mac keeps showing
 * its own card — and then races that answer against Discord.
 *
 * Discord gets clickable controls over a gateway connection (buttons for an approval,
 * buttons or a select for a choice, a form for a free-text answer), and a plain
 * `<code> <answer>` text reply stays as a fallback when the gateway is unavailable.
 *
 * @module dsh-notify
 */
import {
  approvalRows,
  answeredLine,
  modalPayload,
  parseInteraction,
  questionRows,
} from './components.js'
import { approvalFromReply, answerFromReply, createReplyPoller, makeCode, parseReply } from './discord.js'
import { answerInteraction, editAsBot, postAsBot } from './discord-rest.js'
import { createGateway } from './gateway.js'
import { resolveConfig } from './config.js'
import { mountNoticeRoute } from './web.js'
import { createAnnouncer, createChannels, formatApproval, formatQuestions, formatTurnNotice, isGoalRound, messageText, oneLine, sessionFacts, TURN_REPLY_LIMIT, TURN_REQUEST_LIMIT, UNGROUPED } from './notify.js'

/** Plugin name, as the Loader reports it. */
export const name = 'dsh-notify'

/**
 * Mount the plugin.
 * @param ctx - the plugin context; only event subscription and the logger are used.
 * @param raw - the Loader-supplied configuration.
 * @param deps - injectable collaborators for tests: `channels`, `startPoller`, `startGateway`.
 */

/** Whether a request came from this machine, same origin, with no proxy in front. */
function sameOriginLoopback(req) {
  const address = req.socket?.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  if (req.headers.forwarded !== undefined
    || req.headers['x-forwarded-for'] !== undefined
    || req.headers['x-real-ip'] !== undefined) return false
  const host = req.headers.host ?? ''
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin === '') return host !== ''
  try { return new URL(origin).host === host } catch { return false }
}

/**
 * Answer `/dsh-notify/notice?session=<id>` with the newest composed notice.
 *
 * The browser composes nothing: it asks for the text the Host already sent to Discord, so
 * both surfaces always show the same sentence.
 * @param notices - the per-Session notice store.
 * @returns a request handler that owns its response.
 */
function noticeHandler(notices) {
  return (req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405, { allow: 'GET' })
      res.end()
      return
    }
    if (!sameOriginLoopback(req)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('notices are limited to same-origin loopback requests')
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const notice = notices.get(url.searchParams.get('session') ?? '')
    if (notice === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('no notice for that session')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ title: notice.title, body: notice.body }))
  }
}

export function apply(ctx, raw, deps = {}) {
  const config = resolveConfig(raw)
  if (!config.enabled) {
    ctx.logger.info('dsh-notify: disabled by configuration')
    return
  }
  // With answering on, the bot posts the coded message itself; a webhook notice would
  // put a second, near-identical message in the same channel.
  const channels = deps.channels
    ?? createChannels({ ...config, discordWebhookUrl: config.answering ? '' : config.discordWebhookUrl })
  // Turn notices carry no controls, so they do not go through the bot's decision
  // path. With answering configured that path is the only one left — the webhook is
  // deliberately blanked above, and announcing through it would duplicate every
  // approval — so the notice gets its own bot delivery instead of sharing `channels`.
  const turnChannels = deps.turnChannels ?? (config.answering
    ? [{
        name: 'discord-bot',
        deliver: (text) => postAsBot({
          token: config.discordBotToken,
          channelId: config.discordChannelId,
          text,
          silent: true,
        }),
      }]
    : channels)
  const shouldAnnounce = createAnnouncer({ ttlMs: config.ttlMs, minGapMs: config.minGapMs })
  /** Pending decisions by correlation code; a question entry owns its own progress. */
  const pending = new Map()
  /** Newest composed notice per Session, read by the browser half. */
  const notices = new Map()
  let gatewayReady = false

  /** Post one body to every channel, reporting outcomes without failing the caller. */
  const deliverTo = (list, text, what) => {
    for (const channel of list) {
      let sent
      try {
        sent = channel.deliver(text)
      } catch (failure) {
        ctx.logger.warn(`dsh-notify: ${channel.name} could not send ${what}: ${String(failure)}`)
        continue
      }
      void Promise.resolve(sent).then((outcome) => {
        if (outcome?.ok === true) ctx.logger.info(`dsh-notify: sent ${what} via ${channel.name}`)
        else ctx.logger.warn(`dsh-notify: ${channel.name} could not send ${what}: ${String(outcome?.error)}`)
      }).catch((failure) => {
        ctx.logger.warn(`dsh-notify: ${channel.name} could not send ${what}: ${String(failure)}`)
      })
    }
  }

  /** Post one body to every configured destination. */
  const announce = (text, what) => { deliverTo(channels, text, what) }

  /**
   * Name the Session the way the GUI does.
   *
   * The title lives in the `title` projection rather than in the log header, so a
   * notification can say which conversation is asking instead of showing a bare id.
   *
   * @param session - the Session awaiting an answer.
   * @returns a one-line identity: title, project, and a short id when nothing else exists.
   */
  const sessionLabel = (session) => {
    const facts = sessionFacts(session)
    let projected = ''
    try {
      const value = ctx.get?.('sessionProjections')?.stateOf?.(session, 'title')
      if (typeof value === 'string' && value !== '') projected = value
    } catch (failure) {
      ctx.logger.warn(`dsh-notify: could not read the session title: ${String(failure)}`)
    }
    const name = projected !== '' ? projected : facts.title
    if (name === '') return facts.project === '' ? facts.shortId : `${facts.project} · ${facts.shortId}`
    return facts.project === '' ? name : `${name}（${facts.project}）`
  }

  /**
   * The Session name alone.
   *
   * The turn notice heading already names the Workspace, so repeating the directory there
   * would say the same thing twice; approvals keep the suffixed label, where it is the only
   * hint of which checkout is asking.
   *
   * @param session - the Session whose turn ended.
   * @returns the projected title, or the directory and short id when it has none yet.
   */
  const sessionName = (session) => {
    const facts = sessionFacts(session)
    let projected = ''
    try {
      const value = ctx.get?.('sessionProjections')?.stateOf?.(session, 'title')
      if (typeof value === 'string') projected = value
    } catch (failure) {
      ctx.logger.warn(`dsh-notify: could not read the session title: ${String(failure)}`)
    }
    const name = projected !== '' ? projected : facts.title
    if (name === '') return facts.project === '' ? facts.shortId : `${facts.project} · ${facts.shortId}`
    return name
  }

  /**
   * Hand one composed notice to the browser through the Session log.
   *
   * The browser half owns only the decision to show, so the text travels as a log-only
   * plugin record: invisible to the model, carried by fork and resume, and delivered to
   * every client that holds a binding for this Session. A host without a real Session
   * (tests, headless replays) simply skips it.
   *
   * @param session - the Session whose turn ended.
   * @param notice - the two lines the Discord message already carries.
   */
  const publishNotice = (session, notice) => {
    const id = String(session?.id ?? '')
    if (id === '') return
    // The browser asks for this the moment it sees the turn finish; it holds only the
    // newest notice, because an older one has already been superseded on screen.
    notices.set(id, { title: notice.title, body: notice.body, at: Date.now() })
  }

  /**
   * The Workspace that owns a Session, or the ungrouped label.
   *
   * Workspaces are a Host-side registry; a Session's membership lives in the owner's
   * `sessionIds`, so the label costs one scan. A host without the registry (headless
   * profiles, tests) reads as ungrouped rather than failing the notice.
   *
   * @param session - the Session whose turn ended.
   * @returns the Workspace title, or the ungrouped label.
   */
  const workspaceLabel = (session) => {
    try {
      const rows = ctx.get?.('workspaceRegistry')?.list?.() ?? []
      const id = String(session?.id ?? '')
      const owner = rows.find((row) => (row?.sessionIds ?? []).some((entry) => String(entry) === id))
      const title = typeof owner?.title === 'string' ? owner.title : ''
      return title === '' ? UNGROUPED : title
    } catch (failure) {
      ctx.logger.warn(`dsh-notify: could not read the workspace: ${String(failure)}`)
      return UNGROUPED
    }
  }

  /** Whether clickable controls can carry an answer right now. */
  const controlsReady = () => config.components && gatewayReady

  /**
   * The body of a question message: one question at a time, plus what is answered.
   * @param view - the questions, the position being asked, the answers so far, and the session.
   * @param code - the correlation code the text fallback needs.
   * @returns the message body.
   */
  const questionBody = (view, code) => {
    const current = view.questions[view.index]
    const lines = [
      `【${config.label}】在等你选择`,
      `会话：${view.sessionText}`,
      ...view.answered.map(line => `· ${line}`),
    ]
    if (current === undefined) return lines.join('\n')
    lines.push(view.questions.length > 1
      ? `第 ${String(view.index + 1)}/${String(view.questions.length)} 题`
      : '问题')
    lines.push(String(current.question ?? ''))
    if (typeof current.detail === 'string' && current.detail !== '') lines.push(current.detail)
    const options = Array.isArray(current.options) ? current.options : []
    if (!controlsReady()) {
      options.forEach((option, position) => {
        const label = typeof option === 'string' ? option : option?.label
        lines.push(`  ${String(position + 1)}) ${String(label ?? '')}`)
      })
      lines.push(`回复：${code} 选项编号，或直接写一段话`)
    } else if (options.length > 0) {
      lines.push('点上面的选项，或点「自己写」自己写一个')
    } else {
      lines.push('点「填写答案」写下你的回答')
    }
    return lines.join('\n')
  }

  /**
   * Apply one answer to the question being asked, and describe what comes next.
   * @param code - the request's correlation code.
   * @param entry - the pending flow.
   * @param item - the answer item for the current question.
   * @returns whether the batch is complete, plus the next body and controls.
   */
  const applyAnswer = (code, entry, item) => {
    const question = entry.questions[entry.index]
    entry.answers.push(item)
    entry.answered.push(answeredLine(entry.index, question, item))
    entry.index += 1
    if (entry.index >= entry.questions.length) {
      pending.delete(code)
      entry.settle({ answers: entry.answers })
      return { done: true, text: `${questionBody(entry, code)}\n\n— 已全部答完，交给 agent 继续`, components: [] }
    }
    return {
      done: false,
      text: questionBody(entry, code),
      components: config.components
        ? questionRows(code, entry.questions[entry.index], entry.index)
        : [],
    }
  }

  /** Turn a button press or select choice into one answer item. */
  const answerFromControl = (entry, parsed) => {
    const question = entry.questions[entry.index]
    if (question === undefined) return null
    const options = Array.isArray(question.options) ? question.options : []
    const raw = parsed.values[0] ?? parsed.detail
    const position = Number(String(raw).split(':').at(-1))
    const option = Number.isInteger(position) ? options[position] : undefined
    if (option === undefined) return null
    const label = typeof option === 'string' ? option : option?.label
    return { id: question.id, selected: typeof label === 'string' ? [label] : [] }
  }

  /**
   * Handle one gateway interaction: acknowledge it, then apply what it carried.
   * @param interaction - the `INTERACTION_CREATE` payload.
   */
  const onInteraction = (interaction) => {
    const parsed = parseInteraction(interaction)
    if (parsed === null) return
    const authorId = interaction?.member?.user?.id ?? interaction?.user?.id
    if (authorId !== undefined && String(authorId) !== config.discordAllowedUserId) {
      ctx.logger.warn('dsh-notify: ignoring an interaction from another user')
      return
    }
    const entry = pending.get(parsed.code)
    if (entry === undefined) {
      void answerInteraction({
        interaction,
        body: { type: 4, data: { content: '这条已经处理过了', flags: 64 } },
      })
      return
    }
    if (entry.kind === 'approval') {
      const outcome = parsed.kind === 'approve' ? 'allowed-once' : parsed.kind === 'deny' ? 'rejected' : null
      if (outcome === null) return
      pending.delete(parsed.code)
      const decided = parsed.kind === 'approve' ? '允许一次' : '拒绝'
      void answerInteraction({
        interaction,
        body: { type: 7, data: { content: `${entry.text}\n\n— 已由你在 Discord 决定：${decided}`, components: [] } },
      })
      entry.settle(outcome)
      return
    }
    if (parsed.kind === 'text') {
      // A free-text question needs a form before it can carry an answer.
      void answerInteraction({
        interaction,
        body: modalPayload(parsed.code, entry.questions[entry.index], entry.index),
      })
      return
    }
    const question = entry.questions[entry.index]
    const item = parsed.kind === 'submit'
      ? { id: question?.id, selected: [], custom: parsed.text ?? '' }
      : answerFromControl(entry, parsed)
    if (item === null) return
    const next = applyAnswer(parsed.code, entry, item)
    void answerInteraction({
      interaction,
      body: { type: 7, data: { content: next.text, components: next.components } },
    })
  }

  const startPoller = deps.startPoller ?? ((options) => {
    const poller = createReplyPoller(options)
    void poller.start()
    return poller
  })
  const startGateway = deps.startGateway ?? ((options) => {
    const gateway = createGateway(options)
    gateway.start()
    return gateway
  })

  if (config.answering) {
    // Text replies keep working whatever happens to the gateway.
    startPoller({
      token: config.discordBotToken,
      channelId: config.discordChannelId,
      allowedUserId: config.discordAllowedUserId,
      intervalMs: config.pollIntervalMs,
      log: (line) => { ctx.logger.warn(`dsh-notify: ${line}`) },
      onReply: ({ content }) => {
        for (const [code, entry] of pending) {
          const body = parseReply(content, code)
          if (body === null) continue
          if (entry.kind === 'approval') {
            const outcome = approvalFromReply(body)
            if (outcome === null) {
              ctx.logger.warn(`dsh-notify: reply for ${code} was not a usable decision`)
              return
            }
            pending.delete(code)
            void editAsBot({
              token: config.discordBotToken,
              channelId: config.discordChannelId,
              messageId: entry.messageId,
              text: `${entry.text}\n\n— 已由你在 Discord 回复：${body}`,
              components: [],
            })
            entry.settle(outcome)
            return
          }
          const item = answerFromReply(entry.questions[entry.index], body)
          if (item === null) {
            ctx.logger.warn(`dsh-notify: reply for ${code} was not a usable answer`)
            return
          }
          const next = applyAnswer(code, entry, item)
          void editAsBot({
            token: config.discordBotToken,
            channelId: config.discordChannelId,
            messageId: entry.messageId,
            text: next.text,
            components: next.components,
          })
          return
        }
      },
    })
    if (config.components) {
      startGateway({
        token: config.discordBotToken,
        onInteraction,
        // Controls only work once the socket is up, so the text fallback stays until then.
        onReady: () => { gatewayReady = true },
        log: (line) => { ctx.logger.warn(`dsh-notify: ${line}`) },
      })
    }
  }

  /** Rewrite one of our Discord messages with a note about what happened next. */
  const mark = (messageId, bodyText, suffix) => {
    void editAsBot({
      token: config.discordBotToken,
      channelId: config.discordChannelId,
      messageId,
      text: `${bodyText}\n\n— ${suffix}`,
      components: [],
    })
  }

  /**
   * Post the message a human answers, and register it for replies.
   *
   * Not `async` on purpose: the no-answering case is a plain `null` the caller branches
   * on, while the posted case is a promise carrying the reply promise.
   *
   * @param options - what is being asked.
   * @returns null when Discord answering is off, otherwise `{ code, messageId, text, reply }`.
   */
  const awaitReply = ({ kind, questions, sessionText, bodyText }) => {
    if (!config.answering) return null
    const code = makeCode()
    const controls = config.components
      ? kind === 'approval'
        ? approvalRows(code)
        : questions.length > 0 ? questionRows(code, questions[0], 0) : []
      : undefined
    let text
    if (kind === 'question' && questions.length > 0) {
      // One question per message, the way the desktop card shows a single question.
      // Controls carry the whole answer path, so no correlation code is mentioned.
      text = questionBody({ questions, index: 0, answered: [], sessionText }, code)
    } else {
      const hint = kind === 'approval' ? `\n回复：y ${code} 允许 / n ${code} 拒绝` : ''
      text = `${bodyText}${hint}`
    }
    return postAsBot({
      token: config.discordBotToken,
      channelId: config.discordChannelId,
      text,
      components: controls,
    }).then((posted) => {
      if (posted.ok !== true) {
        ctx.logger.warn(`dsh-notify: could not post to Discord: ${String(posted.error)}`)
        return null
      }
      const reply = new Promise((settle) => {
        // Zero means no deadline: the request waits exactly like the desktop card does.
        const timer = config.replyWindowMs === 0 ? undefined : setTimeout(() => {
          pending.delete(code)
          settle(null)
        }, config.replyWindowMs)
        if (timer !== undefined && typeof timer.unref === 'function') timer.unref()
        pending.set(code, {
          kind,
          questions: Array.isArray(questions) ? questions : [],
          answers: [],
          answered: [],
          index: 0,
          sessionText,
          messageId: posted.id,
          text,
          settle: (outcome) => {
            if (timer !== undefined) clearTimeout(timer)
            settle(outcome)
          },
        })
      })
      return { code, messageId: posted.id, text, reply }
    })
  }

  const raceDelegated = async ({ kind, questions, sessionText, bodyText, delegated }) => {
    const posting = awaitReply({ kind, questions, sessionText, bodyText })
    if (posting === null) return delegated

    // Posting and the Mac's answer race each other too: if the Mac answers while the
    // message is still in flight, the note is written as soon as the id is known.
    const first = await Promise.race([
      posting.then(posted => ({ posted })),
      delegated.then(outcome => ({ harness: true, value: outcome })),
    ])
    if (first.harness === true) {
      void posting.then((posted) => {
        if (posted === null) return
        pending.delete(posted.code)
        mark(posted.messageId, posted.text, '已在 Mac 处理，这条不用再回')
      })
      return first.value
    }
    const posted = first.posted
    if (posted === null) return delegated

    const winner = await Promise.race([
      posted.reply.then(outcome => ({ decided: outcome !== null, value: outcome })),
      delegated.then(outcome => ({ harness: true, value: outcome })),
    ])
    if (winner.harness === true) {
      pending.delete(posted.code)
      mark(posted.messageId, posted.text, '已在 Mac 处理，这条不用再回')
      return winner.value
    }
    if (!winner.decided) {
      mark(posted.messageId, posted.text, '已停止等 Discord 回复，请回 Mac 上处理')
      return delegated
    }
    return winner.value
  }

  ctx.on('approval/request', (request, next) => {
    // Delegating first is what keeps the Mac's own card alive; a waterfall listener
    // that returns here would silence every inner answerer.
    const delegated = next()
    try {
      const key = `approval:${String(request.agent?.session?.id ?? '')}:${request.toolName}:${String(request.callId ?? request.reason ?? '')}`
      if (!shouldAnnounce(key)) return delegated
      const label = sessionLabel(request.agent?.session)
      const bodyText = formatApproval({
        session: request.agent?.session,
        toolName: request.toolName ?? '',
        reason: request.reason,
        displayReason: request.displayReason,
        label: config.label,
        sessionLabel: label,
      })
      announce(bodyText, `approval (${request.toolName ?? 'unknown tool'})`)
      return raceDelegated({
        kind: 'approval',
        questions: [],
        sessionText: label,
        bodyText,
        delegated,
      })
    } catch (failure) {
      ctx.logger.warn(`dsh-notify: approval notification failed: ${String(failure)}`)
      return delegated
    }
  })

  // A finished turn is the other thing worth interrupting a person for: the browser
  // half shows a desktop notification, and this one says the same thing in the channel
  // that already carries approvals.
  if (config.turnNotify) {
    /** Last observed request and reply per Session, for the next completion notice. */
    const asked = new Map()
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
          sessionLabel: sessionName(session),
          workspaceLabel: workspaceLabel(session),
          asked: asked.get(id) ?? '',
          answered: answered.get(id) ?? '',
        })
        deliverTo(turnChannels, `${notice.title}\n${notice.body}`, 'the turn result')
        // The browser half shows the same two lines; it must not compose them itself,
        // because only the Host knows the Workspace, the status and the reply.
        publishNotice(session, notice)
      } catch (failure) {
        ctx.logger.warn(`dsh-notify: turn notification failed: ${String(failure)}`)
      }
    })
  }

  // The browser half shows the notice the Host composed; it asks for it when it sees the
  // turn finish, so the two never disagree about the text. Same-origin loopback only.
  mountNoticeRoute(ctx, () => notices)

  ctx.on('user-questions/request', (request, next) => {
    const delegated = next()
    try {
      const questions = Array.isArray(request.questions) ? request.questions : []
      const first = questions[0]
      const key = `question:${String(request.agent?.session?.id ?? '')}:${String(request.wait?.callId ?? first?.id ?? '')}`
      if (!shouldAnnounce(key)) return delegated
      const label = sessionLabel(request.agent?.session)
      const bodyText = formatQuestions({
        session: request.agent?.session,
        questions,
        label: config.label,
        sessionLabel: label,
      })
      announce(bodyText, 'user question')
      return raceDelegated({
        kind: 'question',
        questions,
        sessionText: label,
        bodyText,
        delegated,
      })
    } catch (failure) {
      ctx.logger.warn(`dsh-notify: question notification failed: ${String(failure)}`)
      return delegated
    }
  })
}
