---
description: "dsh-notify：把 DSH 的审批与提问推到 Discord，用按钮、下拉菜单和输入框直接作答。"
---

# dsh-notify

[English](README.md) | 中文

把正在等人处理的 Session 推到 Discord 或 iMessage；在 Discord 上还能**点着把答案交回去**——审批是按钮，选择题是按钮或下拉菜单，要写一段话时弹输入框。每条消息都写明了它属于哪个 Session，多个会话同时卡住也不会混。

```
【DSH】需要你确认
会话：设计持久记忆插件方案（deepseek-harness）
事项：bash
详情：执行 rm -rf build

[ 允许一次 ] [ 拒绝 ]
```

## 它做什么

- 观察两个接缝：`approval/request`（agent 需要授权）与 `user-questions/request`（agent 需要你选）。两者都是 waterfall，所以本插件**先 `next()` 交回**：桌面卡片照常能用，谁先答就以谁为准。
- 每个配置好的通道都会收到通知。发送失败只写一行 warn，绝不会打断这次决定。
- 在 Discord 上以 bot 身份发帖，并挂上控件：审批给 `允许一次` / `拒绝`；选择题每个选项一个按钮（超过五个改用下拉菜单），外加 `自己写`；没有选项的问题直接弹输入框。
- **一次只问一题**。一次请求里有多个问题时，在同一条消息里依次走完，每答一题留一行 `· 已答 …`，全部答完才把整批答案交回。
- 长连接不可用时退回朴素的 `<code> <answer>` 文字回复，websocket 掉线不会让请求变得答不了。
- Session 已经有结果时改写自己那条消息：桌面先答了写 `已在 Mac 处理，这条不用再回`；等待窗口结束写 `已停止等 Discord 回复，请回 Mac 上处理`。
- `replyWindowMs: 0`（默认）表示**不限时**，和桌面卡片一样一直等。

## 安装

```sh
# from GitHub
dsh plugin --profile web add github:DWJZ/dsh-notify

# local development (the profile links the checkout, so edits apply on restart)
dsh plugin --profile web add link:/path/to/dsh-notify
```

## 配置

至少要配一个去处；两个都配就都收到通知。写进 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`：

```yaml
- id: dsh-notify
  config:
    discordWebhookUrl: ''        # channel webhook; the message appears as the bot
    imessageRecipient: ''        # phone number or Apple ID; needs Messages permission
    discordBotToken: ''          # answering: bot token used to read replies
    discordChannelId: ''         # answering: channel the bot posts into
    discordAllowedUserId: ''     # answering: only this user's replies count
    label: DSH                   # first-line sender tag
    components: true             # clickable controls; false keeps text replies only
    replyWindowMs: 0             # 0 waits forever
    pollIntervalMs: 3000         # text-reply poll interval
    ttlMs: 300000                # suppress repeats of one request
    minGapMs: 2000               # minimum gap between two messages
```

一个去处都没配会在加载时直接报错。应答要求三个 bot 字段一起给：只配一部分会被拒绝，而不是被静默忽略。

## 在 Discord 里应答

消息由 bot 自己发出，这样才能挂控件、也才能在之后改写它。点击事件走 gateway websocket（点击不是聊天消息，查消息查不到），所以插件以零 intents 连上 `wss://gateway.discord.gg`，用心跳与重连维持。

- 审批由两个按钮决定；决定之后消息被改写成你选的结论，按钮随之移除。
- 选项不超过五个的选择题用按钮，更多则用下拉菜单，没有选项的问题直接弹输入框。每题都还带一个 `自己写`，用来填一个不在选项里的答案。
- 答案以普通的答案批次交回 agent。若桌面卡片先答了，Discord 这条会被标注为已处理，而不会再问你一次。

## 已知限制

- Discord 应答之后桌面卡片能否收掉，取决于提问方在拿到答案后是否撤回自己的请求：`ask_user_question` 与审批发起方都会这么做。缺少这一行为的 DSH 版本上，卡片会一直留在界面上，直到重新加载会话。
- 只有真正落到人这里的请求才会收到通知。若某个 profile 的自动复核先把请求答掉了，本插件根本不会被调用——那本来也不需要通知人。
- iMessage 需要 macOS 且「信息」已登录，Mac 睡眠时发不出去。
- 一个进程内所有 Session 共用同一条 gateway 连接。

## 测试

```sh
npm test            # every spec: formatting, wiring, payloads, gateway, controls, two-way answering
npm run send:test   # sends one real iMessage to verify the delivery path end to end
```

`npm test` 不会发真消息：它用桩住的通道、桩住的 gateway 和桩住的 HTTP 层驱动插件，覆盖消息文本、通道选择、重复抑制、失败路径、控件编码、gateway 协议，以及用按钮、下拉、输入框、文字作答，和一次请求里多题连答。

## 许可证

[MIT](LICENSE)
