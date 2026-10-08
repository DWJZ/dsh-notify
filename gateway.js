/**
 * A minimal Discord gateway client.
 *
 * Component interactions — a button click, a select choice, a submitted form — are
 * pushed over a websocket, so nothing short of a gateway connection can receive them.
 * This client speaks just enough of the protocol: HELLO, IDENTIFY, heartbeats,
 * reconnect-on-request, and forwarding `INTERACTION_CREATE`.
 *
 * @module dsh-notify/gateway
 */
const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json'

/** Intents are zero: interactions arrive without any privileged intent. */
const INTENTS = 0

/**
 * Open and maintain one gateway connection.
 *
 * @param options - the connection configuration.
 * @param options.token - bot token.
 * @param options.onInteraction - called with every `INTERACTION_CREATE` payload.
 * @param options.log - receives connection diagnostics.
 * @param options.WebSocketImpl - websocket constructor, injectable for tests.
 * @param options.reconnectDelayMs - wait before reconnecting a dropped socket.
 * @param options.setIntervalImpl - timer source, injectable for tests.
 * @param options.setTimeoutImpl - timer source, injectable for tests.
 * @returns start/stop and the last received sequence number.
 */
export function createGateway({
  token,
  onInteraction,
  onReady = () => {},
  log = () => {},
  WebSocketImpl = globalThis.WebSocket,
  reconnectDelayMs = 5_000,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
}) {
  let socket
  let heartbeatTimer
  let reconnectTimer
  let sequence
  let stopped = true

  /** Send one gateway payload, ignoring a socket that is already gone. */
  const send = (payload) => {
    try {
      socket?.send(JSON.stringify(payload))
    } catch (failure) {
      log(`gateway send failed: ${String(failure)}`)
    }
  }

  /** Identify once the gateway has said hello. */
  const identify = () => {
    send({
      op: 2,
      d: {
        token,
        intents: INTENTS,
        properties: { os: 'macos', browser: 'dsh-notify', device: 'dsh-notify' },
      },
    })
  }

  /** Begin the heartbeat loop at the interval the gateway asked for. */
  const startHeartbeat = (intervalMs) => {
    if (heartbeatTimer !== undefined) clearIntervalImpl(heartbeatTimer)
    heartbeatTimer = setIntervalImpl(() => { send({ op: 1, d: sequence ?? null }) }, intervalMs)
    if (typeof heartbeatTimer?.unref === 'function') heartbeatTimer.unref()
  }

  /** Drop the current socket and come back after the reconnect delay. */
  const scheduleReconnect = () => {
    if (stopped) return
    if (reconnectTimer !== undefined) clearTimeoutImpl(reconnectTimer)
    reconnectTimer = setTimeoutImpl(() => { connect() }, reconnectDelayMs)
    if (typeof reconnectTimer?.unref === 'function') reconnectTimer.unref()
  }

  /** Apply one payload from the gateway. */
  const handle = (raw) => {
    let payload
    try {
      payload = JSON.parse(String(raw))
    } catch {
      log('gateway sent a payload that is not JSON')
      return
    }
    if (typeof payload?.s === 'number') sequence = payload.s
    switch (payload?.op) {
      case 10:
        startHeartbeat(payload.d.heartbeat_interval)
        identify()
        break
      case 1:
        send({ op: 1, d: sequence ?? null })
        break
      case 7:
        socket?.close?.()
        scheduleReconnect()
        break
      case 9:
        // Invalid session: a fresh identify is required after a short pause.
        setTimeoutImpl(identify, 1_000)
        break
      case 0:
        if (payload.t === 'READY') onReady()
        else if (payload.t === 'INTERACTION_CREATE') onInteraction(payload.d)
        break
      default:
        break
    }
  }

  /** Open one socket. */
  const connect = () => {
    if (stopped) return
    if (typeof WebSocketImpl !== 'function') {
      log('gateway unavailable: this runtime has no WebSocket')
      return
    }
    try {
      socket = new WebSocketImpl(GATEWAY_URL)
    } catch (failure) {
      log(`gateway connect failed: ${String(failure)}`)
      scheduleReconnect()
      return
    }
    socket.onmessage = (event) => { handle(event?.data) }
    socket.onclose = () => { scheduleReconnect() }
    socket.onerror = (event) => { log(`gateway socket error: ${String(event?.message ?? event)}`) }
  }

  return {
    /** Connect, and keep reconnecting until stopped. */
    start() {
      stopped = false
      connect()
    },
    /** Close the socket and cancel every timer. */
    stop() {
      stopped = true
      if (heartbeatTimer !== undefined) clearIntervalImpl(heartbeatTimer)
      if (reconnectTimer !== undefined) clearTimeoutImpl(reconnectTimer)
      heartbeatTimer = undefined
      reconnectTimer = undefined
      try {
        socket?.close?.()
      } catch (failure) {
        log(`gateway close failed: ${String(failure)}`)
      }
      socket = undefined
    },
    /** Last sequence number seen, exposed for tests and diagnostics. */
    sequenceOf: () => sequence,
  }
}
