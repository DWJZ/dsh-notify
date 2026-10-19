/**
 * Unit checks for the finished-turn notification: the text it renders, and that a
 * mounted plugin posts one per `turn/end`.
 *
 * Usage: `node test/turn-notify.spec.mjs`.
 */
import { resolveConfig } from '../config.js'
import { apply } from '../index.js'
import { formatTurnNotice } from '../notify.js'

let failures = 0
const check = (label, condition, detail = '') => {
  if (condition) console.log(`  ok   ${label}`)
  else {
    failures += 1
    console.log(`  FAIL ${label} ${detail}`)
  }
}

const session = { id: 'session-0d7283cf-5423-4d06-877d-e29083ea730d', header: { cwd: '/tmp/project' } }

console.log('the notice is one heading line and one content line')
{
  const notice = formatTurnNotice({ session, reason: { kind: 'completed' }, sessionLabel: '修 CI', workspaceLabel: 'dsh-plugins', asked: '把 CI 修好', answered: '已修好：缓存的 key 少了前缀。' })
  check('the heading names workspace, session and request', notice.title === 'dsh-plugins - 修 CI - 把 CI 修好', notice.title)
  check('the content leads with the status emoji', notice.body === '✅ 已修好：缓存的 key 少了前缀。', notice.body)
  const ungrouped = formatTurnNotice({ session, reason: { kind: 'aborted' }, sessionLabel: '修 CI', asked: 'x' })
  check('an ungrouped Session still names itself', ungrouped.title.startsWith('未分组 - 修 CI'), ungrouped.title)
  check('an interrupted turn carries its own mark', ungrouped.body === '⚠️', ungrouped.body)
  const blocked = formatTurnNotice({ session, reason: { kind: 'blocked' }, sessionLabel: '修 CI', asked: 'x', answered: 'y' })
  check('a blocked turn says so', blocked.body === '⏸️ y', blocked.body)
  const failed = formatTurnNotice({ session, reason: { kind: 'error', error: { message: 'provider refused  the  request' } }, sessionLabel: '修 CI', asked: 'x' })
  check('an error carries its message', failed.body === '❌ provider refused the request', failed.body)
  const long = formatTurnNotice({ session, reason: { kind: 'completed' }, sessionLabel: '修 CI', asked: 'x'.repeat(200), answered: 'y'.repeat(400) })
  check('the request keeps its budget', long.title.endsWith(`- ${'x'.repeat(69)}…`), String(long.title.length))
  check('the reply keeps its budget', long.body === `✅ ${'y'.repeat(139)}…`, String(long.body.length))
}

console.log('the notice names the Workspace that owns the Session')
{
  const delivered = []
  const withRegistry = {
    logger: { info: () => {}, warn: () => {} },
    on: (name, listener) => { if (name === 'session/event') withRegistry.listeners.push(listener); return () => {} },
    get: (name) => (name === 'workspaceRegistry'
      ? { list: () => [{ title: 'dsh-plugins', sessionIds: [String(session.id)] }, { title: 'other', sessionIds: [] }] }
      : undefined),
    inject: (_names, factory) => factory({ effect: (create) => create(), webServer: { register: () => () => {} } }),
    listeners: [],
  }
  apply(withRegistry, { discordWebhookUrl: 'https://example.test/hook', turnNotify: true }, { channels: [{ name: 'test', deliver: text => { delivered.push(text); return { ok: true } } }] })
  withRegistry.listeners[0](session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  check('the owning Workspace title heads the notice', delivered[0]?.startsWith('dsh-plugins - ') === true, JSON.stringify(delivered[0] ?? ''))
  check('and a foreign Workspace is never named', !delivered[0].includes('other'))
}

console.log('the plugin posts one message per finished turn')
const delivered = []
const ctx = {
  logger: { info: () => {}, warn: () => {} },
  on: (name, listener) => {
    if (name === 'session/event') ctx.listeners.push(listener)
    return () => {}
  },
  get: () => undefined,
  inject: (_names, factory) => factory({ effect: (create) => create(), webServer: { register: () => () => {} } }),
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

console.log('the notice route answers the browser')
{
  const routes = []
  const served = {
    logger: { info: () => {}, warn: () => {} },
    on: (name, listener) => { if (name === 'session/event') served.listeners.push(listener); return () => {} },
    get: () => undefined,
    listeners: [],
    inject: (_names, factory) => factory({ effect: (create) => create(), webServer: { register: (route) => { routes.push(route); return () => {} } } }),
  }
  const posted = []
  apply(served, { discordWebhookUrl: 'https://example.test/hook', turnNotify: true }, { channels: [{ name: 'test', deliver: text => { posted.push(text); return { ok: true } } }] })
  served.listeners[0](session, { type: 'user/message', data: { content: [{ type: 'text', text: '把 CI 修好' }] } })
  served.listeners[0](session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '已修好。' }] } } })
  served.listeners[0](session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })

  const route = routes.find(entry => entry.path === '/dsh-notify/notice')
  check('the browser has a notice route', route?.kind === 'exact', JSON.stringify(routes.map(entry => entry.path)))
  /** Drive the handler the way the web server does. */
  const ask = (method = 'GET', headers = {}) => {
    const answer = { status: 0, body: '' }
    const req = { method, url: `/dsh-notify/notice?session=${encodeURIComponent(String(session.id))}`, headers: { host: '127.0.0.1:3080', ...headers }, socket: { remoteAddress: '127.0.0.1' } }
    const res = { writeHead: (status) => { answer.status = status; return res }, end: (body) => { answer.body = String(body ?? '') } }
    route.handler(req, res)
    return answer
  }
  const ok = ask()
  const parsed = ok.status === 200 ? JSON.parse(ok.body) : {}
  check('it returns the same two lines Discord got', parsed.title?.startsWith('未分组 - ') && parsed.body?.startsWith('✅'), ok.body)
  check('and the Discord message matches them', posted[0] === `${parsed.title}\n${parsed.body}`, JSON.stringify(posted[0]))
  check('a cross-origin ask is refused', ask('GET', { origin: 'https://evil.example' }).status === 403)
  check('another method is refused', ask('POST').status === 405)
}

const quiet = { logger: { info: () => {}, warn: () => {} }, on: (name, listener) => { if (name === 'session/event') quiet.listeners.push(listener); return () => {} }, get: () => undefined, inject: (_names, factory) => factory({ effect: (create) => create(), webServer: { register: () => () => {} } }), listeners: [] }
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
    inject: (_names, factory) => factory({ effect: (create) => create(), webServer: { register: () => () => {} } }),
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
  check('and it carries the two-line notice',
    (posted[0]?.body ?? '').includes('未分组 - project') && (posted[0]?.body ?? '').includes('✅'),
    (posted[0]?.body ?? '').slice(0, 80))
  // One notice per turn is a running commentary: it belongs in the channel, but it
  // must not raise a notification the way an approval does.
  check('and asks Discord to deliver it without notifying',
    (posted[0]?.body ?? '').includes(`"flags":${String(1 << 12)}`), (posted[0]?.body ?? '').slice(-60))
} finally {
  globalThis.fetch = realFetch
}

console.log(failures === 0 ? '\nPASS' : `\n${String(failures)} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
