/**
 * Checks for the two behaviours the live trial exposed: one message per request, and
 * a note on the Discord message when the Mac answers first.
 *
 * Usage: `node test/annotate.spec.mjs`.
 */
import { apply } from '../index.js'

let failures = 0
const check = (label, condition, detail = '') => {
  if (condition) console.log(`  ok   ${label}`)
  else {
    failures += 1
    console.log(`  FAIL ${label} ${detail}`)
  }
}

const session = { id: 'session-abcd1234-9999', header: { cwd: '/tmp/project-x', title: '测试会话' } }
const config = {
  discordWebhookUrl: 'https://discord.example/hook',
  discordBotToken: 'bot-token',
  discordChannelId: 'chan-1',
  discordAllowedUserId: 'user-1',
  minGapMs: 0,
}
const realFetch = globalThis.fetch

/** Record every HTTP call the plugin makes, and refuse nothing. */
function captureFetch() {
  const calls = []
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, method: options.method ?? 'GET', body: options.body === undefined ? undefined : JSON.parse(String(options.body)) })
    return { ok: true, status: 200, text: async () => '', json: async () => ({ id: `msg-${String(calls.length)}` }) }
  }
  return calls
}

/** A context that records listeners and log lines. */
function stubContext() {
  const listeners = new Map()
  return {
    listeners,
    ctx: {
      on: (type, handler) => { listeners.set(type, handler) },
      logger: { info: () => {}, warn: () => {} },
    },
  }
}

console.log('开着应答时不再重复发一条')
const dedupeCalls = captureFetch()
const dedupe = stubContext()
apply(dedupe.ctx, config, { startPoller: () => ({ start: () => {}, stop: () => {} }), startGateway: () => ({ start: () => {}, stop: () => {} }) })
const dedupePromise = dedupe.listeners.get('approval/request')({
  agent: { session }, toolName: 'bash', callId: 'call-1',
}, () => new Promise(() => {}))
await new Promise(resolve => setTimeout(resolve, 20))
const posts = dedupeCalls.filter(call => call.method === 'POST')
check('只发了一条（bot 那条带配对码）', posts.length === 1, String(posts.length))
check('发的是 bot 消息接口，不是 webhook', String(posts[0]?.url).includes('/channels/chan-1/messages'), String(posts[0]?.url))
globalThis.fetch = realFetch
void dedupePromise

console.log('\nMac 先答时给 Discord 那条加标注')
const annotateCalls = captureFetch()
const annotate = stubContext()
apply(annotate.ctx, config, { startPoller: () => ({ start: () => {}, stop: () => {} }), startGateway: () => ({ start: () => {}, stop: () => {} }) })
let settleMac
const mac = new Promise((resolve) => { settleMac = resolve })
const annotatePromise = annotate.listeners.get('approval/request')({
  agent: { session }, toolName: 'bash', callId: 'call-2',
}, () => mac)
await new Promise(resolve => setTimeout(resolve, 20))
settleMac('rejected')
const annotateOutcome = await annotatePromise
await new Promise(resolve => setTimeout(resolve, 20))
const patches = annotateCalls.filter(call => call.method === 'PATCH')
check('答案是 Mac 的那个', annotateOutcome === 'rejected', String(annotateOutcome))
check('改写了 Discord 消息', patches.length === 1, String(patches.length))
check('标注内容是「已在 Mac 处理」', String(patches[0]?.body?.content).includes('已在 Mac 处理'), String(patches[0]?.body?.content).slice(-60))
check('保留原始正文', String(patches[0]?.body?.content).includes('【DSH】需要你确认'), '')
globalThis.fetch = realFetch

console.log(failures === 0 ? '\nPASS' : `\n${String(failures)} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
