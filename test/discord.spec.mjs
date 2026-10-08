/**
 * Unit checks for the reply path: code minting, parsing, answer mapping, and the
 * poller's cursor discipline.
 *
 * Usage: `node test/discord.spec.mjs`.
 */
import {
  answerFromReply,
  approvalFromReply,
  createReplyPoller,
  fetchMessages,
  makeCode,
  parseReply,
} from '../discord.js'

let failures = 0
const check = (label, condition, detail = '') => {
  if (condition) console.log(`  ok   ${label}`)
  else {
    failures += 1
    console.log(`  FAIL ${label} ${detail}`)
  }
}

console.log('配对码')
const code = makeCode(4, () => 0.5)
check('长度正确', code.length === 4, code)
check('只用不易混的字符', /^[A-HJ-NP-Z2-9]{50}$/u.test(makeCode(50, Math.random)), '')
check('随机源可注入', makeCode(4, () => 0) === 'AAAA', makeCode(4, () => 0))

console.log('\n解析回复')
check('标准形式', parseReply('A7F3 y', 'A7F3') === 'y')
check('允许中英标点', parseReply('A7F3：1', 'A7F3') === '1')
check('大小写不敏感', parseReply('a7f3 YES', 'A7F3') === 'YES')
check('别的码不认', parseReply('B2C9 y', 'A7F3') === null)
check('没有码不认', parseReply('y', 'A7F3') === null)
check('空内容不认', parseReply('   ', 'A7F3') === null)
check('自由文本整段取回', parseReply('A7F3 用预发环境，别动生产', 'A7F3') === '用预发环境，别动生产')

console.log('\n审批判定')
check('y 允许', approvalFromReply('y') === 'allowed-once')
check('允许（中文）', approvalFromReply('允许') === 'allowed-once')
check('n 拒绝', approvalFromReply('n') === 'rejected')
check('拒绝（中文）', approvalFromReply('拒绝') === 'rejected')
check('含糊内容不判定', approvalFromReply('也许吧') === null)

console.log('\n提问作答')
const question = {
  id: 'q1',
  question: '发布到哪？',
  options: [{ label: '生产' }, { label: '预发' }],
}
check('数字选选项', JSON.stringify(answerFromReply(question, '2')) === JSON.stringify({ id: 'q1', selected: ['预发'] }), JSON.stringify(answerFromReply(question, '2')))
check('多选', JSON.stringify(answerFromReply({ ...question, multiSelect: true }, '1 2')) === JSON.stringify({ id: 'q1', selected: ['生产', '预发'] }))
check('越界数字当作自由文本', answerFromReply(question, '9')?.custom === '9', JSON.stringify(answerFromReply(question, '9')))
check('自由文本进 custom', answerFromReply(question, '先别发布')?.custom === '先别发布')
check('无选项时整段作为自由文本', answerFromReply({ id: 'q2' }, '用预发')?.custom === '用预发')
check('空回复不产生答案', answerFromReply(question, '  ') === null)

console.log('\n读取消息')
const calls = []
const fakeFetch = async (url, options) => {
  calls.push({ url, options })
  return {
    ok: true,
    status: 200,
    text: async () => '',
    json: async () => ([
      { id: '200', content: 'B', author: { id: 'u1', bot: false } },
      { id: '150', content: 'A', author: { id: 'u1', bot: false } },
    ]),
  }
}
const page = await fetchMessages({ token: 't', channelId: 'c', after: '100', fetchImpl: fakeFetch })
check('成功返回', page.ok === true)
check('按 id 升序排好', page.messages.map(m => m.id).join() === '150,200', page.messages.map(m => m.id).join())
check('带上 after 与 limit', calls[0]?.url.includes('after=100') && calls[0]?.url.includes('limit=50'), calls[0]?.url)
check('用 Bot 授权头', calls[0]?.options?.headers?.authorization === 'Bot t')

const failingFetch = async () => ({ ok: false, status: 403, text: async () => 'Missing Permissions' })
const failed = await fetchMessages({ token: 't', channelId: 'c', fetchImpl: failingFetch })
check('失败不抛、带状态码', failed.ok === false && failed.error.includes('403'), failed.error)

console.log('\n轮询游标与作者过滤')
const seen = []
const pages = [
  [{ id: '300', content: 'seed', author: { id: 'u1', bot: false } }],
  [
    { id: '301', content: 'A7F3 y', author: { id: 'u1', bot: false } },
    { id: '302', content: 'A7F3 n', author: { id: 'someone-else', bot: false } },
    { id: '303', content: 'A7F3 y', author: { id: 'bot-2', bot: true } },
  ],
]
let page2 = 0
const pollerFetch = async () => ({
  ok: true,
  status: 200,
  text: async () => '',
  json: async () => pages[Math.min(page2++, pages.length - 1)],
})
const poller = createReplyPoller({
  token: 't',
  channelId: 'c',
  allowedUserId: 'u1',
  onReply: (reply) => { seen.push(reply.content) },
  log: () => {},
  fetchImpl: pollerFetch,
})
await poller.start()
poller.stop()
await poller.pollOnce()
check('第一遍只播种游标，不产出回复', seen.length === 1, JSON.stringify(seen))
check('只接受允许的作者且忽略 bot', seen.join() === 'A7F3 y', JSON.stringify(seen))
check('游标推进到最新', poller.cursorOf() === '303', String(poller.cursorOf()))

console.log(failures === 0 ? '\nPASS' : `\n${String(failures)} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
