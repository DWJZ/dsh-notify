/**
 * Gateway checks: identify on hello, heartbeat with the last sequence, forward
 * interactions, and reconnect without leaking timers.
 *
 * Usage: `node test/gateway.spec.mjs`.
 */
import { createGateway } from '../gateway.js'

let failures = 0
const check = (label, condition, detail = '') => {
  if (condition) console.log(`  ok   ${label}`)
  else {
    failures += 1
    console.log(`  FAIL ${label} ${detail}`)
  }
}

/** A websocket stand-in that records what the client sends and can be driven. */
function fakeWebSocket() {
  const sockets = []
  class Socket {
    constructor(url) {
      this.url = url
      this.sent = []
      this.closed = false
      sockets.push(this)
    }

    send(raw) { this.sent.push(JSON.parse(raw)) }

    close() { this.closed = true }

    /** Deliver one gateway payload as if the server sent it. */
    deliver(payload) { this.onmessage?.({ data: JSON.stringify(payload) }) }
  }
  return { Socket, sockets }
}

/** Timer stand-ins that record their callbacks instead of running on a clock. */
function fakeTimers() {
  const intervals = []
  const timeouts = []
  return {
    intervals,
    timeouts,
    setIntervalImpl: (callback, ms) => { const handle = { callback, ms, unref: () => {} }; intervals.push(handle); return handle },
    clearIntervalImpl: (handle) => { handle.cleared = true },
    setTimeoutImpl: (callback, ms) => { const handle = { callback, ms, unref: () => {} }; timeouts.push(handle); return handle },
    clearTimeoutImpl: (handle) => { handle.cleared = true },
  }
}

console.log('握手与心跳')
const { Socket, sockets } = fakeWebSocket()
const timers = fakeTimers()
const interactions = []
const logs = []
const gateway = createGateway({
  token: 'bot-token',
  onInteraction: (payload) => { interactions.push(payload) },
  log: (line) => { logs.push(line) },
  WebSocketImpl: Socket,
  ...timers,
})
gateway.start()
check('建立了连接', sockets.length === 1, String(sockets.length))
check('连的是官方网关', String(sockets[0]?.url).startsWith('wss://gateway.discord.gg'), String(sockets[0]?.url))

sockets[0].deliver({ op: 10, d: { heartbeat_interval: 41_250 } })
const identify = sockets[0].sent.find(payload => payload.op === 2)
check('收到 HELLO 后 IDENTIFY', identify !== undefined, JSON.stringify(sockets[0].sent))
check('IDENTIFY 带上 token 与零 intents', identify?.d?.token === 'bot-token' && identify?.d?.intents === 0, JSON.stringify(identify?.d))
check('按服务器给的心跳间隔启动心跳', timers.intervals[0]?.ms === 41_250, String(timers.intervals[0]?.ms))

timers.intervals[0].callback()
const firstBeat = sockets[0].sent.at(-1)
check('心跳内容为 op 1', firstBeat?.op === 1 && firstBeat?.d === null, JSON.stringify(firstBeat))

console.log('\n交互事件')
sockets[0].deliver({ op: 0, s: 42, t: 'INTERACTION_CREATE', d: { id: 'i1', type: 3, data: { custom_id: 'ABCD:1' } } })
check('转发了按钮点击', interactions.length === 1 && interactions[0]?.data?.custom_id === 'ABCD:1', JSON.stringify(interactions))
timers.intervals[0].callback()
check('心跳带上最新的序号', sockets[0].sent.at(-1)?.d === 42, JSON.stringify(sockets[0].sent.at(-1)))

sockets[0].deliver({ op: 0, s: 43, t: 'MESSAGE_CREATE', d: { content: 'ignored' } })
check('只转发交互事件', interactions.length === 1, String(interactions.length))

console.log('\n断线与重连')
sockets[0].onclose()
check('掉线后排了一次重连', timers.timeouts.length === 1, String(timers.timeouts.length))
timers.timeouts[0].callback()
check('重连新建了 socket', sockets.length === 2, String(sockets.length))

console.log('\n停止后不再重连')
gateway.stop()
check('关掉了 socket', sockets[1].closed === true)
check('心跳定时器已清理', timers.intervals[0].cleared === true)
sockets[1].onclose()
check('停止后掉线不再重连', timers.timeouts.length === 1, String(timers.timeouts.length))

console.log('\n坏数据不会炸')
const before = logs.length
sockets[1].onmessage?.({ data: 'not json at all' })
check('非法负载只记一条日志', logs.length === before + 1, JSON.stringify(logs.slice(-1)))

console.log(failures === 0 ? '\nPASS' : `\n${String(failures)} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
