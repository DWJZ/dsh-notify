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
  === '【DSH】一轮回答结束\n状态：完成\n会话：修 CI')
check('an interrupted turn', formatTurnEnd({ session, reason: { kind: 'aborted' }, sessionLabel: '修 CI' }).includes('状态：被中断'))
check('a blocked turn waits for the person', formatTurnEnd({ session, reason: { kind: 'blocked' }, sessionLabel: '修 CI' }).includes('状态：等待你处理'))
check('an error carries its message', formatTurnEnd({
  session,
  reason: { kind: 'error', error: { message: 'provider refused  the  request' } },
  sessionLabel: '修 CI',
}).includes('状态：出错：provider refused the request'))
check('an unknown reason still ends the line', formatTurnEnd({ session, reason: undefined, sessionLabel: '修 CI' }).includes('状态：已结束'))
check('the label is configurable', formatTurnEnd({ session, reason: { kind: 'completed' }, label: 'WTM', sessionLabel: 'x' }).startsWith('【WTM】'))
check('without a label the project stands in', formatTurnEnd({ session, reason: { kind: 'completed' } }).includes('会话：project · session-0'))

console.log('the notice describes the turn, like the desktop one')
const described = formatTurnEnd({
  session,
  reason: { kind: 'completed' },
  sessionLabel: '问候（deepseek-harness）',
  asked: '把 CI 修好，\n顺便看下缓存键',
  answered: '已修好：缓存的 key 少了 workspace 前缀。\n另外补了一个回归测试。',
})
check('the request heads it', described.startsWith('【DSH】把 CI 修好， 顺便看下缓存键'), JSON.stringify(described))
check('the status comes next', described.includes('\n状态：完成\n'))
check('the session still names the conversation', described.includes('会话：问候（deepseek-harness）'))
check('and the reply opening closes it', described.endsWith('\n回答：已修好：缓存的 key 少了 workspace 前缀。 另外补了一个回归测试。'), JSON.stringify(described))
const cut = formatTurnEnd({
  session,
  reason: { kind: 'completed' },
  sessionLabel: 'x',
  asked: 'x'.repeat(200),
  answered: 'y'.repeat(400),
}).split('\n')
check('long text is cut to the same budgets the browser half uses',
  cut[0] === `【DSH】${'x'.repeat(69)}…` && cut[3] === `回答：${'y'.repeat(139)}…`,
  JSON.stringify(cut.map(line => line.length)))

console.log('the plugin posts one message per finished turn')
const delivered = []
const ctx = {
  logger: { info: () => {}, warn: () => {} },
  on: (name, listener) => {
    if (name === 'session/event') ctx.listeners.push(listener)
    return () => {}
  },
  get: () => undefined,
  inject: () => {},
  // The presence route mounts on the web host; these specs exercise the event paths.
  inject: () => {},
  listeners: [],
}
const channel = { name: 'test', deliver: text => { delivered.push(text); return { ok: true } } }
check('the turn switch defaults on', resolveConfig({ discordWebhookUrl: 'https://example.test/hook' }).turnNotify === true)
check('and can be turned off', resolveConfig({ discordWebhookUrl: 'https://example.test/hook', turnNotify: false }).turnNotify === false)

apply(ctx, { discordWebhookUrl: 'https://example.test/hook', turnNotify: true }, { channels: [channel] })
check('the plugin subscribed to Session events', ctx.listeners.length === 1)
ctx.listeners[0](session, { type: 'user/message', data: { content: [{ type: 'text', text: '把 CI 修好，\n顺便看下缓存键' }] } })
ctx.listeners[0](session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '已修好：缓存的 key 少了 workspace 前缀。' }] } } })
ctx.listeners[0](session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
check('a finished turn is announced', delivered.length === 1 && delivered[0].includes('一轮回答结束') === false, JSON.stringify(delivered))
check('the notice names the request that finished', delivered[0].includes('把 CI 修好'), JSON.stringify(delivered))
check('and the reply that answered it', delivered[0].includes('已修好：缓存的 key'), JSON.stringify(delivered))
ctx.listeners[0](session, { type: 'step/end' })
check('other events stay silent', delivered.length === 1)

console.log('a goal continuation stays silent')
ctx.listeners[0](session, { type: 'user/message', data: { content: [{ type: 'text', text: '<goal_round>\nround 2\n</goal_round>' }] } })
ctx.listeners[0](session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
check('no message for a self-driven round', delivered.length === 1, JSON.stringify(delivered.at(-1)))
ctx.listeners[0](session, { type: 'user/message', data: { content: [{ type: 'text', text: '继续' }] } })
ctx.listeners[0](session, { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } })
check('and the next turn a person started speaks again', delivered.length === 2, JSON.stringify(delivered))

const quiet = { logger: { info: () => {}, warn: () => {} }, on: (name, listener) => { if (name === 'session/event') quiet.listeners.push(listener); return () => {} }, get: () => undefined, inject: () => {}, listeners: [] }
apply(quiet, { discordWebhookUrl: 'https://example.test/hook', turnNotify: false }, { channels: [channel] })
check('turning the switch off removes the listener', quiet.listeners.length === 0)

// The browser is the only witness of what a person can already see; its report decides
// whether the Discord notice speaks.
console.log('the Discord notice follows the browser')
{
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: String(init?.body ?? '') })
    return new Response(JSON.stringify({ id: '1' }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const routes = []
  const following = {
    logger: { info: () => {}, warn: () => {} },
    on: (name, listener) => { if (name === 'session/event') following.listeners.push(listener); return () => {} },
    get: () => undefined,
    listeners: [],
    inject: (_names, factory) => factory({ effect: (create) => create(), webServer: { register: (route) => { routes.push(route); return () => {} } } }),
  }
  try {
    apply(following, {
      discordWebhookUrl: 'https://example.test/hook',
      discordBotToken: 'bot-token',
      discordChannelId: 'channel-id',
      discordAllowedUserId: 'user-id',
      turnNotify: true,
    })
    const presence = routes.find(route => route.path === '/dsh-notify/presence')
    check('the browser has a route to report presence', presence !== undefined, JSON.stringify(routes.map(route => route.path)))
    const answered = presence.handler({ headers: { host: '127.0.0.1:3080' }, body: JSON.stringify({ focused: true, shown: String(session.id) }) })
    check('a same-origin report is accepted', answered.status === 200, JSON.stringify(answered))

    const turn = async () => {
      calls.length = 0
      following.listeners.at(-1)(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
      await new Promise((resolve) => { setTimeout(resolve, 60) })
      return calls.map(call => call.body).join('\n')
    }

    const inFront = await turn()
    check('a turn the person is watching is delivered without a Discord popup',
      inFront.includes(`"flags":${String(1 << 12)}`), inFront.slice(-80))

    presence.handler({ headers: { host: '127.0.0.1:3080' }, body: JSON.stringify({ focused: true, shown: 'another-session' }) })
    const elsewhere = await turn()
    check('and another Session still speaks', !elsewhere.includes(`"flags":${String(1 << 12)}`), elsewhere.slice(-80))

    const crossed = presence.handler({ headers: { host: '127.0.0.1:3080', origin: 'https://evil.example' }, body: '{}' })
    check('a cross-origin report is refused', crossed.status === 403, JSON.stringify(crossed))
  } finally {
    globalThis.fetch = realFetch
  }
}

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
    inject: () => {},
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
  // One notice per turn is a running commentary: it belongs in the channel, but it
  // must not raise a notification the way an approval does.
  // Nothing reported presence, so the notice is not known to be redundant: it speaks.
  check('and lets Discord notify when the window never said it was watching',
    !(posted[0]?.body ?? '').includes(`"flags":${String(1 << 12)}`), (posted[0]?.body ?? '').slice(-60))
} finally {
  globalThis.fetch = realFetch
}

console.log(failures === 0 ? '\nPASS' : `\n${String(failures)} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
