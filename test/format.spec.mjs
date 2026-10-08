/**
 * Unit checks for the message text and the de-duplication policy.
 *
 * Usage: `node test/format.spec.mjs`.
 */
import {
  condense,
  createAnnouncer,
  DETAIL_LIMIT,
  formatApproval,
  formatQuestions,
  sessionFacts,
} from '../notify.js'

let failures = 0
const check = (label, condition, detail = '') => {
  if (condition) console.log(`  ok   ${label}`)
  else {
    failures += 1
    console.log(`  FAIL ${label} ${detail}`)
  }
}

const session = {
  id: 'session-0d7283cf-5423-4d06-877d-e29083ea730d',
  header: { cwd: '/tmp/JobHunt', title: '简历投递' },
}

console.log('会话标识')
const facts = sessionFacts(session)
check('短 id 截断到 20 字符', facts.shortId === 'session-0d7283cf-542…', facts.shortId)
check('项目名取目录末段', facts.project === 'JobHunt', facts.project)
check('标题可用', facts.title === '简历投递', facts.title)
check('缺字段时不抛错', sessionFacts(undefined).shortId === '')

console.log('\n审批文本')
const approval = formatApproval({
  session,
  toolName: 'bash',
  displayReason: { en: 'run the submit script', zh: '执行提交脚本 rm -rf build' },
})
check('包含标题与项目', approval.includes('简历投递（JobHunt）'), approval)
check('包含工具名', approval.includes('事项：bash'), approval)
check('优先用中文 displayReason', approval.includes('执行提交脚本'), approval)
check('第二行是会话行', approval.split('\n')[1].startsWith('会话：'), approval)
const labelled = formatApproval({ session, toolName: 'bash', sessionLabel: '设计持久记忆插件方案（deepseek-harness）' })
check('调用方给的会话标签优先', labelled.includes('会话：设计持久记忆插件方案（deepseek-harness）'), labelled)
check('给了标签就不再重复项目行', !labelled.includes('项目：'), labelled)

console.log('\n提问文本')
const questions = formatQuestions({
  session,
  questions: [
    { id: 'q1', header: '部署目标', question: '这次要发布到生产还是预发？' },
    { id: 'q2', question: '要顺带跑迁移吗？' },
  ],
})
check('列出每个问题', questions.includes('部署目标：这次要发布到生产还是预发？')
  && questions.includes('问题 2：要顺带跑迁移吗？'), questions)
check('首行带发送方标识', questions.split('\n')[0] === '【DSH】在等你选择', questions)
check('审批首行也带发送方标识', approval.split('\n')[0] === '【DSH】需要你确认', approval)
check('可以自定义标识', formatApproval({ session, toolName: 'bash', label: 'DSH·JobHunt' })
  .startsWith('【DSH·JobHunt】需要你确认'))
check('提问也支持自定义标识', formatQuestions({ session, questions: [], label: '小助手' })
  .startsWith('【小助手】在等你选择'))

console.log('\n截断')
check('长文本被截断并留省略号', condense('x'.repeat(500)).length === DETAIL_LIMIT, String(condense('x'.repeat(500)).length))
check('换行被折成单行', condense('a\n\nb   c') === 'a b c', condense('a\n\nb   c'))
check('非字符串返回空串', condense(undefined) === '')

console.log('\n去重与限速')
let at = 1_000_000
const shouldAnnounce = createAnnouncer({ ttlMs: 300_000, minGapMs: 2_000, now: () => at })
check('首次放行', shouldAnnounce('approval:a') === true)
check('同一 key 立刻重复被抑制', shouldAnnounce('approval:a') === false)
at += 1_000
check('2 秒内的另一个 key 被限速', shouldAnnounce('approval:b') === false)
at += 2_000
check('限速窗口过后新 key 放行', shouldAnnounce('approval:b') === true)
at += 400_000
check('TTL 过期后同一 key 再次放行', shouldAnnounce('approval:a') === true)

console.log(failures === 0 ? '\nPASS' : `\n${String(failures)} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
