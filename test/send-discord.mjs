/**
 * Post one real Discord message through the plugin's own channel code.
 *
 * Usage: `node test/send-discord.mjs <webhook-url>`. Omit the argument to read the
 * URL from the bundle patch next to this package.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { formatQuestions, sendDiscord } from '../notify.js'

const PACKAGE = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Read the configured webhook out of the bundle patch. */
function webhookFromPatch() {
  const text = readFileSync(join(PACKAGE, 'cordis.patch.yml'), 'utf8')
  const match = /^\s*discordWebhookUrl:\s*"([^"]+)"/mu.exec(text)
  return match?.[1] ?? ''
}

const webhookUrl = process.argv[2] ?? webhookFromPatch()
if (webhookUrl === '') {
  console.log('没有 webhook：请传参数，或先在 cordis.patch.yml 里填 discordWebhookUrl')
  process.exit(1)
}

const text = formatQuestions({
  session: {
    id: 'session-selftest-0000-0000-000000000000',
    header: { cwd: '/tmp/dsh-notify', title: '通知通道自检' },
  },
  questions: [
    {
      id: 'q1',
      header: '自检',
      question: `这条消息由 dsh-notify 通过 Discord Webhook 发出，时间 ${new Date().toLocaleString('zh-CN')}`,
    },
  ],
})

const outcome = await sendDiscord({ webhookUrl, text })
if (outcome.ok) console.log('已发送到 Discord')
else {
  console.log(`发送失败：${outcome.error}`)
  process.exit(1)
}
