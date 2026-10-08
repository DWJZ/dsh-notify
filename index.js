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
import { createGateway } from './gateway.js'
import { createAnnouncer, createChannels, formatApproval, formatQuestions, sessionFacts } from './notify.js'

const API = 'https://discord.com/api/v10'

/** Plugin name, as the Loader reports it. */
export const name = 'dsh-notify'

/** Post one message as the bot, so it can carry components and be edited later. */
export async function postAsBot({ token, channelId, text, components, fetchImpl = fetch }) {
  try {
    const response = await fetchImpl(`${API}/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { authorization: `Bot ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(components === undefined ? { content: text } : { content: text, components }),
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

/**
 * Read the plugin configuration.
 *
 * Deployment-varying values live here rather than in code. A configuration with no
 * destination at all is a load-time failure: a notification plugin that cannot
 * address anyone is a misconfiguration, not a disabled feature.
 *
 * @param raw - the config object the Loader passed.
 * @returns the resolved settings.
 */
export function resolveConfig(raw) {
  const source = raw ?? {}
  const text = (value) => (typeof value === 'string' ? value.trim() : '')
  const settings = {
    discordWebhookUrl: text(source.discordWebhookUrl),
    imessageRecipient: text(source.imessageRecipient),
    discordBotToken: text(source.discordBotToken),
    discordChannelId: text(source.discordChannelId),
    discordAllowedUserId: text(source.discordAllowedUserId),
    label: text(source.label) === '' ? 'DSH' : text(source.label),
    components: source.components !== false,
    ttlMs: Number.isInteger(source.ttlMs) && source.ttlMs >= 0 ? source.ttlMs : 300_000,
    minGapMs: Number.isInteger(source.minGapMs) && source.minGapMs >= 0 ? source.minGapMs : 2_000,
    replyWindowMs: Number.isInteger(source.replyWindowMs) && source.replyWindowMs >= 0
      ? source.replyWindowMs
      : 0,
    pollIntervalMs: Number.isInteger(source.pollIntervalMs) && source.pollIntervalMs >= 1_000
      ? source.pollIntervalMs
      : 3_000,
  }
  if (source.enabled === false) return { ...settings, enabled: false, answering: false }
  if (settings.discordWebhookUrl === '' && settings.imessageRecipient === '') {
    throw new Error('dsh-notify: configure `discordWebhookUrl` or `imessageRecipient`')
  }
  const replyParts = [settings.discordBotToken, settings.discordChannelId, settings.discordAllowedUserId]
  const configured = replyParts.filter(part => part !== '').length
  if (configured !== 0 && configured !== replyParts.length) {
    throw new Error('dsh-notify: answering from Discord needs all three of '
      + '`discordBotToken`, `discordChannelId`, `discordAllowedUserId`')
  }
  return { ...settings, enabled: true, answering: configured === replyParts.length }
}

/**
 * Mount the plugin.
 * @param ctx - the plugin context; only event subscription and the logger are used.
 * @param raw - the Loader-supplied configuration.
 * @param deps - injectable collaborators for tests: `channels`, `startPoller`, `startGateway`.
 */
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
  const shouldAnnounce = createAnnouncer({ ttlMs: config.ttlMs, minGapMs: config.minGapMs })
  /** Pending decisions by correlation code; a question entry owns its own progress. */
  const pending = new Map()
  let gatewayReady = false

  /** Post one body to every channel, reporting outcomes without failing the caller. */
  const announce = (text, what) => {
    for (const channel of channels) {
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
