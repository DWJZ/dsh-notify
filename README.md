---
description: "dsh-notify: sends DSH approvals and questions to Discord, and answers them with buttons, selects, and modals."
---

# dsh-notify

English | [中文](README.zh.md)

Pushes a Session that is waiting for a human to Discord or iMessage — and on Discord takes the answer back by clicking: approval buttons, option buttons or a select menu, and a form for a free-text answer. Every message names the Session it belongs to, so several Sessions never blur together.

```
【DSH】需要你确认
会话：设计持久记忆插件方案（deepseek-harness）
事项：bash
详情：执行 rm -rf build

[ 允许一次 ] [ 拒绝 ]
```

## What it does

- Observes two seams: `approval/request` (the agent needs permission) and `user-questions/request` (the agent needs a choice). Both are waterfalls, so the plugin delegates with `next()` first: the desktop card keeps working, and whoever answers first wins.
- Notifies every configured destination. A delivery failure logs one warning and never interrupts the decision.
- On Discord it posts as the bot and attaches controls: `允许一次` / `拒绝` for an approval, one button per option (a select menu above five options) plus `自己写` for a choice, and a form when a question has no options.
- Answers one question at a time. A request carrying several questions walks through them inside the same message, keeps one `· 已答 …` line per answer, and submits the whole batch only after the last one.
- Falls back to a plain `<code> <answer>` reply whenever the gateway is unavailable, so a dropped websocket never leaves a request unanswerable.
- Marks its own message once the Session moved on: `已在 Mac 处理，这条不用再回` when the desktop answered first, `已停止等 Discord 回复，请回 Mac 上处理` when a reply window closed.
- `replyWindowMs: 0` (the default) waits with no deadline, exactly like the desktop card.

## Install

```sh
# from GitHub
dsh plugin --profile web add github:DWJZ/dsh-notify

# local development (the profile links the checkout, so edits apply on restart)
dsh plugin --profile web add link:/path/to/dsh-notify
```

## Configuration

At least one destination is required; with both configured, both receive the notice. Write it into `$DSH_HOME/profiles/<profile>/cordis.patch.yml`:

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

A configuration with no destination at all fails at load. Answering needs all three bot fields together: a partial set is rejected instead of silently ignored.

## Answering from Discord

The bot posts the message itself, so it can carry controls and be edited afterwards. Controls travel over a gateway websocket — a click is not a chat message — which is why the plugin opens `wss://gateway.discord.gg` with zero intents and keeps it alive with heartbeats and reconnects.

- An approval is decided by two buttons; the message is then rewritten with your decision and the buttons are removed.
- A choice with at most five options becomes buttons, more options become a select menu, and a question without options opens a form. Every question also offers `自己写`, which opens a form for an answer that is not on the list.
- The answer reaches the agent as an ordinary answer batch. If the desktop card answered first, the Discord message is marked as handled instead of asking twice.

## Known limitations

- Dismissing the desktop card after a Discord answer relies on the asker withdrawing a settled request: `ask_user_question` and the approval asker abort their own request once they have an answer. On a DSH build without that, the card stays on screen until the Session is reloaded.
- A notification only appears when the request actually reaches a human answerer. A profile whose automatic review answers first never calls this plugin, and no human needs to be told.
- iMessage needs macOS with Messages signed in, and cannot send while the Mac is asleep.
- One gateway connection is shared by every Session in the process.

## Test

```sh
npm test            # every spec: formatting, wiring, payloads, gateway, controls, two-way answering
npm run send:test   # sends one real iMessage to verify the delivery path end to end
```

`npm test` never sends a real message: it drives the plugin against stub destinations, a stub gateway, and a stub HTTP layer, covering the message text, destination selection, duplicate suppression, the failure path, control encoding, the gateway protocol, and answering by button, by select, by form, by text, and across several questions in one request.

## License

[MIT](LICENSE)
