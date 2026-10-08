/**
 * Send one real iMessage, so the delivery path can be verified end to end.
 *
 * Usage: `node test/send-once.mjs [recipient]`. The recipient defaults to the
 * configured phone number; nothing else about the plugin is exercised here.
 */
import { formatApproval, sendIMessage } from '../notify.js'

const recipient = process.argv[2] ?? '+15550100'
const text = formatApproval({
  session: {
    id: 'session-selftest-0000-0000-000000000000',
    header: { cwd: '/tmp/dsh-notify', title: '通知通道自检' },
  },
  toolName: 'send-once.mjs',
  reason: `这条是自检消息，发出时间 ${new Date().toLocaleString('zh-CN')}`,
})

const outcome = await sendIMessage({ recipient, text })
if (outcome.ok) console.log(`已发送到 ${recipient}`)
else {
  console.log(`发送失败：${outcome.error}`)
  process.exit(1)
}
