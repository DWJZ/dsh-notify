# dsh-notify

需要你决定时给你发消息——审批请求、以及要你选择/回答的问题。消息里带会话与项目，所以你一眼能看出是哪个 Session 卡住了。

## 它做什么

| 触发 | 来源接缝 | 你收到 |
|---|---|---|
| agent 需要授权某个操作 | `approval/request` | `【DSH】需要你确认` + 会话 + 项目 + 工具名 + 理由 |
| agent 要你选一个东西 | `user-questions/request` | `【DSH】在等你选择` + 会话 + 项目 + 问题（最多三个） |

两个接缝都是 waterfall：本插件只是**观察者**，永远把决定交回 `next()`，从不自己作答，也不会因为推送失败而影响审批流程（失败只写一行 warn）。

## 通道（至少配一个，两个都配就都发）

| 通道 | 配置字段 | 消息的发送者 | 说明 |
|---|---|---|---|
| **Discord** | `discordWebhookUrl` | **bot 自己**（不会看成你自己发的） | 频道设置 → 整合 → Webhook → 新建 → 复制 URL |
| iMessage | `imessageRecipient` | 你自己的账号（自发自收） | 手机号或 Apple ID；需要给 DSH 授予控制「信息」的权限 |

## 其它配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `label` | `DSH` | 消息首行的发送方标识，例如 `DSH·JobHunt`，便于区分来源 |
| `enabled` | `true` | `false` 时完全不注册监听 |
| `ttlMs` | `300000` | 同一件事（同会话同工具同 callId）重复请求的抑制窗口 |
| `minGapMs` | `2000` | 两条消息之间的最小间隔，防止一次性刷屏 |

## 前置条件

- Discord 通道：只要 webhook URL，不需要 bot token、不需要常驻连接
- iMessage 通道：macOS 上 Messages 已登录；首次发送会弹「DSH 想要控制『信息』」，选允许
- Mac 睡眠时不会发送（通知来自 Mac 上运行的进程）

## 开发

```sh
npm test            # 42 条断言：格式化、通道选择、Discord 载荷、去重、失败不外溢（不发真消息）
npm run send:test   # 真发一条 iMessage 自检到配置的号码
```

`notify.js` 里的格式化函数都是纯函数；只有 `createAnnouncer()` 持有去重状态，时钟可注入。发送实现分 `sendIMessage`（osascript，脚本走 stdin、内容走 argv）与 `sendDiscord`（webhook POST），二者都返回 `{ ok, error }`，从不抛出。
