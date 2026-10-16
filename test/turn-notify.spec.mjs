/**
 * Unit checks for the finished-turn notification: the text it renders, and that a
 * mounted plugin posts one per `turn/end`.
 *
 * Usage: `node test/turn-notify.spec.mjs`.
 */
import { apply, resolveConfig } from '../index.js'
import { formatTurnEnd } from '../notify.js'

let failures = 0
const check = (label, condition, detail = '') => {
  if (condition) console.log(`  ok   ${label}`)
  else {
    failures += 1
    console.log(`  FAIL ${label} ${detail}`)
  }
}

const session = { id: 'session-0d7283cf-5423-4d06-877d-e29083ea730d', header: { cwd: '/tmp/project' } }

console.log('the text names the task and how it ended')
check('a completed turn', formatTurnEnd({ session, reason: { kind: 'completed' }, sessionLabel: '修 CI' })
  === '【DSH】一轮回答结束\n会话：修 CI\n状态：完成')
check('an interrupted turn', formatTurnEnd({ session, reason: { kind: 'aborted' }, sessionLabel: '修 CI' }).endsWith('状态：被中断'))
check('a blocked turn waits for the person', formatTurnEnd({ session, reason: { kind: 'blocked' }, sessionLabel: '修 CI' }).endsWith('状态：等待你处理'))
check('an error carries its message', formatTurnEnd({
  session,
  reason: { kind: 'error', error: { message: 'provider refused  the  request' } },
  sessionLabel: '修 CI',
}).endsWith('状态：出错：provider refused the request'))
check('an unknown reason still ends the line', formatTurnEnd({ session, reason: undefined, sessionLabel: '修 CI' }).endsWith('状态：已结束'))
check('the label is configurable', formatTurnEnd({ session, reason: { kind: 'completed' }, label: 'WTM', sessionLabel: 'x' }).startsWith('【WTM】'))
check('without a label the project stands in', formatTurnEnd({ session, reason: { kind: 'completed' } }).includes('会话：project · session-0'))

console.log('the plugin posts one message per finished turn')
const delivered = []
const ctx = {
  logger: { info: () => {}, warn: () => {} },
  on: (name, listener) => {
    if (name === 'session/event') ctx.listeners.push(listener)
    return () => {}
  },
  get: () => undefined,
  listeners: [],
}
const channel = { name: 'test', deliver: text => { delivered.push(text); return { ok: true } } }
check('the turn switch defaults on', resolveConfig({ discordWebhookUrl: 'https://example.test/hook' }).turnNotify === true)
check('and can be turned off', resolveConfig({ discordWebhookUrl: 'https://example.test/hook', turnNotify: false }).turnNotify === false)

apply(ctx, { discordWebhookUrl: 'https://example.test/hook', turnNotify: true }, { channels: [channel] })
check('the plugin subscribed to Session events', ctx.listeners.length === 1)
ctx.listeners[0](session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
check('a finished turn is announced', delivered.length === 1 && delivered[0].includes('一轮回答结束'), JSON.stringify(delivered))
ctx.listeners[0](session, { type: 'step/end' })
check('other events stay silent', delivered.length === 1)

const quiet = { logger: { info: () => {}, warn: () => {} }, on: (name, listener) => { if (name === 'session/event') quiet.listeners.push(listener); return () => {} }, get: () => undefined, listeners: [] }
apply(quiet, { discordWebhookUrl: 'https://example.test/hook', turnNotify: false }, { channels: [channel] })
check('turning the switch off removes the listener', quiet.listeners.length === 0)

// With answering configured the webhook is blanked on purpose, so a notice that
// shared the announce channels would go nowhere: the regression this covers.
console.log('a notice still arrives when Discord answering owns the channel')
const calls = []
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), body: String(init?.body ?? '') })
  return new Response(JSON.stringify({ id: '1' }), { status: 200, headers: { 'content-type': 'application/json' } })
}
try {
  const answering = {
    logger: { info: () => {}, warn: () => {} },
    on: (name, listener) => { if (name === 'session/event') answering.listeners.push(listener); return () => {} },
    get: () => undefined,
    listeners: [],
  }
  apply(answering, {
    discordWebhookUrl: 'https://example.test/hook',
    discordBotToken: 'bot-token',
    discordChannelId: 'channel-id',
    discordAllowedUserId: 'user-id',
    turnNotify: true,
  })
  answering.listeners[0](session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await new Promise((resolve) => { setTimeout(resolve, 50) })
  // The bot posts after reading the channel once (its own reuse query), so the
  // notice is the call that targets the messages collection without a query.
  const posted = calls.filter(call => call.url.endsWith('/channels/channel-id/messages'))
  check('the bot channel received the notice', posted.length === 1, JSON.stringify(calls.map(call => call.url)))
  check('and it carries the finished-turn text', (posted[0]?.body ?? '').includes('一轮回答结束'), (posted[0]?.body ?? '').slice(0, 80))
} finally {
  globalThis.fetch = realFetch
}

console.log(failures === 0 ? '\nPASS' : `\n${String(failures)} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
