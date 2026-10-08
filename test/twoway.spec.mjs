/**
 * Two-way checks: a Discord reply or click decides a pending request, the Mac's own
 * card keeps working, a settled request is never answered twice, and several questions
 * in one request are answered one after another.
 *
 * Usage: `node test/twoway.spec.mjs`.
 */
import { apply, resolveConfig } from '../index.js'
import { createChannels, sendDiscord, sessionFacts } from '../notify.js'
import { parseCustomId } from '../components.js'

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
const replyConfig = {
  discordWebhookUrl: 'https://discord.example/hook',
  discordBotToken: 'bot-token',
  discordChannelId: 'chan-1',
  discordAllowedUserId: 'user-1',
  minGapMs: 0,
  replyWindowMs: 0,
}

console.log('配置校验')
check('两个通道都没配时加载即报错', (() => {
  try {
    resolveConfig({})
    return false
  } catch (error) {
    return String(error).includes('discordWebhookUrl')
  }
})())
check('只配一半的 bot 信息就报错', (() => {
  try {
    resolveConfig({ ...replyConfig, discordAllowedUserId: '' })
    return false
  } catch (error) {
    return String(error).includes('discordAllowedUserId')
  }
})())
check('三个都配齐才开启应答', resolveConfig(replyConfig).answering === true)
check('组件默认开启、回复默认不限时',
  resolveConfig(replyConfig).components === true && resolveConfig(replyConfig).replyWindowMs === 0)

console.log('\n通道选择')
check('只配 Discord 时建 Discord 通道',
  createChannels({ discordWebhookUrl: 'https://x' }).map(c => c.name).join() === 'discord')
check('两个都配时都建',
  createChannels({ discordWebhookUrl: 'https://x', imessageRecipient: '+1' }).map(c => c.name).join() === 'discord,imessage')

console.log('\nDiscord 发送')
const requests = []
const realFetch = globalThis.fetch
globalThis.fetch = async (url, options) => {
  requests.push({ url, options })
  return { ok: true, status: 204, text: async () => '', json: async () => ({ id: 'msg-1' }) }
}
const discordOutcome = await sendDiscord({ webhookUrl: 'https://discord.example/hook', text: '【DSH】需要你确认' })
globalThis.fetch = realFetch
check('POST 到 webhook', requests[0]?.url === 'https://discord.example/hook' && requests[0]?.options?.method === 'POST')
check('正文放在 content 字段', JSON.parse(String(requests[0]?.options?.body)).content === '【DSH】需要你确认')
check('2xx 视为成功', discordOutcome.ok === true)

/** One harness run: stub context, captured poller and gateway, captured HTTP calls. */
function harness({ gatewayReady = true } = {}) {
  const state = { onReply: undefined, onInteraction: undefined, posts: [], patches: [], callbacks: [], sent: [] }
  let messageCounter = 0
  const ctx = stubContext()
  const previousFetch = globalThis.fetch
  globalThis.fetch = async (url, options = {}) => {
    const body = options.body === undefined ? undefined : JSON.parse(String(options.body))
    if (String(url).includes('/interactions/')) state.callbacks.push({ url, body })
    else if (options.method === 'PATCH') state.patches.push({ url, body })
    else state.posts.push({ url, body })
    messageCounter += 1
    return { ok: true, status: 200, text: async () => '', json: async () => ({ id: `msg-${String(messageCounter)}` }) }
  }
  apply(ctx.ctx, replyConfig, {
    channels: [{ name: 'discord', deliver: (text) => { state.sent.push(text); return Promise.resolve({ ok: true }) } }],
    startPoller: (options) => { state.onReply = options.onReply; return { start: () => {}, stop: () => {} } },
    startGateway: (options) => {
      state.onInteraction = options.onInteraction
      if (gatewayReady) options.onReady()
      return { start: () => {}, stop: () => {} }
    },
  })
  return { state, ctx, restore: () => { globalThis.fetch = previousFetch } }
}

/** Click one control of the posted message. */
function click(state, customId) {
  state.onInteraction({
    id: `i-${String(state.callbacks.length + 1)}`,
    token: `t-${String(state.callbacks.length + 1)}`,
    type: 3,
    member: { user: { id: 'user-1' } },
    data: { custom_id: customId },
  })
}

console.log('\n审批：点按钮')
const buttonRun = harness()
let delegatedResolved = false
const macApproval = new Promise(() => {})
const approvalPromise = buttonRun.ctx.listeners.get('approval/request')({
  agent: { session }, toolName: 'bash', callId: 'call-1', displayReason: { zh: '执行 rm -rf build' },
}, () => { delegatedResolved = true; return macApproval })
await new Promise(resolve => setTimeout(resolve, 10))
const approvalPost = buttonRun.state.posts[0]?.body
check('消息带两个按钮', approvalPost?.components?.[0]?.components?.length === 2, JSON.stringify(approvalPost?.components))
check('按钮文案是允许/拒绝',
  approvalPost?.components?.[0]?.components?.map(component => component.label).join() === '允许一次,拒绝', '')
const facts = sessionFacts(session)
check('正文里有会话标识', String(approvalPost?.content).includes('测试会话（project-x）'), String(approvalPost?.content))
click(buttonRun.state, approvalPost.components[0].components[0].custom_id)
const approvalOutcome = await approvalPromise
await new Promise(resolve => setTimeout(resolve, 10))
check('点允许后返回 allowed-once', approvalOutcome === 'allowed-once', String(approvalOutcome))
check('回执里写明了决定',
  String(buttonRun.state.callbacks[0]?.body?.data?.content).includes('允许一次'), String(buttonRun.state.callbacks[0]?.body?.data?.content))
check('回执后按钮被移除', JSON.stringify(buttonRun.state.callbacks[0]?.body?.data?.components) === '[]')
check('Mac 侧仍被通知已作答', delegatedResolved === true)
buttonRun.restore()

console.log('\n审批：文字回复兜底')
const textRun = harness({ gatewayReady: false })
const textPromise = textRun.ctx.listeners.get('approval/request')({
  agent: { session }, toolName: 'bash', callId: 'call-2',
}, () => new Promise(() => {}))
await new Promise(resolve => setTimeout(resolve, 10))
const textPost = textRun.state.posts[0]?.body?.content ?? ''
check('未连上长连接时给出文字回复说明', /y [A-Z2-9]{4,8} 允许/u.test(textPost), textPost.split('\n').at(-1))
const textCode = /y ([A-Z2-9]{4,8}) 允许/u.exec(textPost)?.[1] ?? ''
textRun.state.onReply({ content: `${textCode} n` })
check('文字回复拒绝生效', (await textPromise) === 'rejected')
textRun.restore()

console.log('\n选择题：点选项')
const questionRun = harness()
const questionPromise = questionRun.ctx.listeners.get('user-questions/request')({
  agent: { session },
  questions: [{ id: 'q1', question: '发布到哪？', options: [{ label: '生产' }, { label: '预发' }] }],
}, () => new Promise(() => {}))
await new Promise(resolve => setTimeout(resolve, 10))
const questionControls = questionRun.state.posts[0]?.body?.components?.[0]?.components ?? []
check('两个选项渲染成两个按钮', questionControls.map(component => component.label).join() === '生产,预发', JSON.stringify(questionControls.map(component => component.label)))
click(questionRun.state, questionControls[1].custom_id)
const questionOutcome = await questionPromise
check('点第二个后答案映射成选项文本',
  JSON.stringify(questionOutcome) === JSON.stringify({ answers: [{ id: 'q1', selected: ['预发'] }] }), JSON.stringify(questionOutcome))
questionRun.restore()

console.log('\n连续问题：一题一题答')
const multiRun = harness()
const multiPromise = multiRun.ctx.listeners.get('user-questions/request')({
  agent: { session },
  questions: [
    { id: 'q1', header: '环境', question: '发布到哪？', options: [{ label: '生产' }, { label: '预发' }] },
    { id: 'q2', header: '时间', question: '什么时候发？', options: [{ label: '现在' }, { label: '晚点' }] },
  ],
}, () => new Promise(() => {}))
await new Promise(resolve => setTimeout(resolve, 10))
const firstControls = multiRun.state.posts[0]?.body?.components?.[0]?.components ?? []
check('先只显示第一题的选项', firstControls.map(component => component.label).join() === '生产,预发', JSON.stringify(firstControls.map(component => component.label)))
const firstBody = String(multiRun.state.posts[0]?.body?.content)
check('第一条消息只显示第一题', firstBody.includes('第 1/2 题') && !firstBody.includes('什么时候发？'), firstBody)
click(multiRun.state, firstControls[0].custom_id)
await new Promise(resolve => setTimeout(resolve, 10))
const afterFirst = multiRun.state.callbacks[0]?.body?.data
check('答完第一题后换成第二题的选项',
  afterFirst?.components?.[0]?.components?.map(component => component.label).join() === '现在,晚点', JSON.stringify(afterFirst?.components))
check('消息里记下第一题的答案', String(afterFirst?.content).includes('已答 环境：生产'), String(afterFirst?.content))
check('并显示进度', String(afterFirst?.content).includes('第 2/2 题'), String(afterFirst?.content))
click(multiRun.state, afterFirst.components[0].components[1].custom_id)
const multiOutcome = await multiPromise
await new Promise(resolve => setTimeout(resolve, 10))
check('全部答完后一次性交回整批',
  JSON.stringify(multiOutcome) === JSON.stringify({ answers: [{ id: 'q1', selected: ['生产'] }, { id: 'q2', selected: ['晚点'] }] }),
  JSON.stringify(multiOutcome))
check('结束消息说明已答完', String(multiRun.state.callbacks[1]?.body?.data?.content).includes('已全部答完'), String(multiRun.state.callbacks[1]?.body?.data?.content))
multiRun.restore()

console.log('\n没有选项的问题：弹输入框')
const modalRun = harness()
const modalPromise = modalRun.ctx.listeners.get('user-questions/request')({
  agent: { session },
  questions: [{ id: 'q1', header: '补充', question: '有什么要交代的？' }],
}, () => new Promise(() => {}))
await new Promise(resolve => setTimeout(resolve, 10))
const modalControls = modalRun.state.posts[0]?.body?.components?.[0]?.components ?? []
check('没有选项时给一个填写按钮', modalControls[0]?.label === '填写答案', JSON.stringify(modalControls))
click(modalRun.state, modalControls[0].custom_id)
await new Promise(resolve => setTimeout(resolve, 10))
check('点击后回执是一个输入框', modalRun.state.callbacks[0]?.body?.type === 9, String(modalRun.state.callbacks[0]?.body?.type))
const submitId = modalRun.state.callbacks[0]?.body?.data?.custom_id ?? ''
modalRun.state.onInteraction({
  id: 'i-modal', token: 't-modal', type: 5,
  member: { user: { id: 'user-1' } },
  data: { custom_id: submitId, components: [{ type: 1, components: [{ type: 4, custom_id: 'dsh:x:answer:0', value: '别动生产环境' }] }] },
})
const modalOutcome = await modalPromise
check('表单文本成为自由答案',
  JSON.stringify(modalOutcome) === JSON.stringify({ answers: [{ id: 'q1', selected: [], custom: '别动生产环境' }] }), JSON.stringify(modalOutcome))
modalRun.restore()

console.log('\n其它用户的点击被忽略')
const strangerRun = harness()
const strangerPromise = strangerRun.ctx.listeners.get('approval/request')({
  agent: { session }, toolName: 'bash', callId: 'call-3',
}, () => new Promise(() => {}))
await new Promise(resolve => setTimeout(resolve, 10))
const strangerControl = strangerRun.state.posts[0]?.body?.components?.[0]?.components?.[0]?.custom_id
strangerRun.state.onInteraction({
  id: 'i-x', token: 't-x', type: 3,
  member: { user: { id: 'someone-else' } },
  data: { custom_id: strangerControl },
})
await new Promise(resolve => setTimeout(resolve, 10))
check('陌生人的点击没有产生回执', strangerRun.state.callbacks.length === 0, String(strangerRun.state.callbacks.length))
void strangerPromise
strangerRun.restore()

console.log('\n无回复时交给 Mac')
const silentRun = harness({ gatewayReady: false })
const silentOutcome = await silentRun.ctx.listeners.get('approval/request')({
  agent: { session }, toolName: 'bash', callId: 'call-4',
}, () => Promise.resolve('rejected'))
silentRun.restore()
check('Mac 的决定照常生效', silentOutcome === 'rejected', String(silentOutcome))

console.log('\n有选项时也能自己写')
const writeRun = harness()
const writePromise = writeRun.ctx.listeners.get('user-questions/request')({
  agent: { session },
  questions: [{ id: 'q1', header: '环境', question: '发布到哪？', options: [{ label: '生产' }, { label: '预发' }] }],
}, () => new Promise(() => {}))
await new Promise(resolve => setTimeout(resolve, 10))
const writeRows = writeRun.state.posts[0]?.body?.components ?? []
check('选项行下面跟着一行「自己写」', writeRows[1]?.components?.[0]?.label === '自己写',
  JSON.stringify(writeRows.map(row => row.components?.map(component => component.label))))
click(writeRun.state, writeRows[1].components[0].custom_id)
await new Promise(resolve => setTimeout(resolve, 10))
const writeModal = writeRun.state.callbacks[0]?.body
check('点「自己写」弹出输入框', writeModal?.type === 9, String(writeModal?.type))
writeRun.state.onInteraction({
  id: 'i-write', token: 't-write', type: 5,
  member: { user: { id: 'user-1' } },
  data: { custom_id: writeModal?.data?.custom_id, components: [{ type: 1, components: [{ type: 4, custom_id: 'dsh:x:answer:0', value: '都别发，等我通知' }] }] },
})
const writeOutcome = await writePromise
check('自己写的答案原样交回',
  JSON.stringify(writeOutcome) === JSON.stringify({ answers: [{ id: 'q1', selected: [], custom: '都别发，等我通知' }] }), JSON.stringify(writeOutcome))
writeRun.restore()

console.log(failures === 0 ? '\nPASS' : `\n${String(failures)} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
