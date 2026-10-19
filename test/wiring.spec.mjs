/**
 * Wiring checks: the plugin watches both seams, always delegates, fans out to every
 * configured channel, and never lets delivery trouble reach the flow it is watching.
 *
 * Usage: `node test/wiring.spec.mjs`.
 */
import { apply, resolveConfig } from '../index.js'
import { createChannels, sendDiscord } from '../notify.js'

let failures = 0
const check = (label, condition, detail = '') => {
  if (condition) console.log(`  ok   ${label}`)
  else {
    failures += 1
    console.log(`  FAIL ${label} ${detail}`)
  }
}

/** A context that records listeners and log lines instead of performing them. */
function stubContext() {
  const listeners = new Map()
  const logs = { info: [], warn: [] }
  return {
    listeners,
    logs,
    ctx: {
      on: (type, handler) => { listeners.set(type, handler) },
      logger: {
        info: (line) => { logs.info.push(line) },
        warn: (line) => { logs.warn.push(line) },
      },
    },
  }
}

const session = { id: 'session-abcd1234-9999', header: { cwd: '/tmp/project-x', title: '测试会话' } }

console.log('配置校验')
check('两个通道都没配时加载即报错', (() => {
  try {
    resolveConfig({})
    return false
  } catch (error) {
    return String(error).includes('discordWebhookUrl')
  }
})())
check('enabled:false 时不要求通道', resolveConfig({ enabled: false }).enabled === false)
const resolved = resolveConfig({ discordWebhookUrl: 'https://discord.example/hook', ttlMs: 1_000, minGapMs: 0 })
check('默认值落位', resolved.ttlMs === 1_000 && resolved.minGapMs === 0 && resolved.label === 'DSH')

console.log('\n通道选择')
check('只配 Discord 时建 Discord 通道',
  createChannels({ discordWebhookUrl: 'https://discord.example/hook' }).map(c => c.name).join() === 'discord')
check('只配 iMessage 时建 iMessage 通道',
  createChannels({ imessageRecipient: '+15550100' }).map(c => c.name).join() === 'imessage')
check('两个都配时都建',
  createChannels({ discordWebhookUrl: 'https://x', imessageRecipient: '+1' }).map(c => c.name).join() === 'discord,imessage')

console.log('\nDiscord 发送')
const requests = []
const realFetch = globalThis.fetch
globalThis.fetch = async (url, options) => {
  requests.push({ url, options })
  return { ok: true, status: 204, text: async () => '' }
}
const discordOutcome = await sendDiscord({ webhookUrl: 'https://discord.example/hook', text: '【DSH】需要你确认' })
globalThis.fetch = realFetch
check('POST 到 webhook', requests[0]?.url === 'https://discord.example/hook' && requests[0]?.options?.method === 'POST')
check('正文放在 content 字段', JSON.parse(String(requests[0]?.options?.body)).content === '【DSH】需要你确认')
check('2xx 视为成功', discordOutcome.ok === true)

console.log('\n两个通道都发')
const sent = []
const { ctx, listeners, logs } = stubContext()
apply(ctx, { discordWebhookUrl: 'https://discord.example/hook', imessageRecipient: '+15550100', minGapMs: 0 }, {
  channels: [
    { name: 'discord', deliver: (text) => { sent.push({ via: 'discord', text }); return Promise.resolve({ ok: true }) } },
    { name: 'imessage', deliver: (text) => { sent.push({ via: 'imessage', text }); return Promise.resolve({ ok: true }) } },
  ],
})
check('注册了审批监听', listeners.has('approval/request'))
check('注册了提问监听', listeners.has('user-questions/request'))

let delegated = false
const outcome = await listeners.get('approval/request')({
  agent: { session },
  toolName: 'bash',
  callId: 'call-1',
  displayReason: { zh: '执行 rm -rf build' },
}, () => { delegated = true; return Promise.resolve('allowed-once') })
check('审批监听把决定交回 next()', delegated === true && outcome === 'allowed-once', String(outcome))

await Promise.resolve()
check('两个通道各发一条', sent.length === 2, JSON.stringify(sent.map(s => s.via)))
check('消息里能认出是哪个会话', sent[0]?.text.includes('测试会话（project-x）'), sent[0]?.text)
check('消息里带项目目录名', sent[0]?.text.includes('（project-x）'), sent[0]?.text)

await listeners.get('approval/request')({
  agent: { session }, toolName: 'bash', callId: 'call-1', displayReason: { zh: '同一件事' },
}, () => Promise.resolve('allowed-once'))
await Promise.resolve()
check('同一件事重复请求不再发', sent.length === 2, String(sent.length))

console.log('\n失败不外溢')
const failing = stubContext()
apply(failing.ctx, { discordWebhookUrl: 'https://discord.example/hook', minGapMs: 0 }, {
  channels: [{ name: 'discord', deliver: () => Promise.reject(new Error('网络断了')) }],
})
let delegatedOnFailure = false
const failureOutcome = await failing.listeners.get('user-questions/request')({
  agent: { session }, questions: [{ id: 'q1', question: '继续吗？' }],
}, () => { delegatedOnFailure = true; return Promise.resolve({ answers: [] }) })
await Promise.resolve()
check('发送失败仍交回 next()', delegatedOnFailure === true)
check('失败只写 warn', failing.logs.warn.some(line => line.includes('could not send')), JSON.stringify(failing.logs.warn))
check('没有把错误抛给调用方', failureOutcome !== undefined)
check('成功路径写 info 并带通道名', logs.info.some(line => line.includes('via discord')), JSON.stringify(logs.info))

console.log(failures === 0 ? '\nPASS' : `\n${String(failures)} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
