/**
 * Unit checks for the browser half: it notifies only while the window is in the
 * background, names the session it is about, and takes the status from the turn
 * that ended when a binding was there to read it.
 *
 * Usage: `node test/client.spec.mjs`.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

let failures = 0
const check = (label, condition, detail = '') => {
  if (condition) console.log(`  ok   ${label}`)
  else {
    failures += 1
    console.log(`  FAIL ${label} ${detail}`)
  }
}

//#region browser stubs
const shown = []
let focused = false
class FakeNotification {
  static permission = 'granted'
  constructor(title, options) {
    shown.push({ title, body: options?.body ?? '', tag: options?.tag ?? '', persistent: options?.requireInteraction === true, renotify: options?.renotify === true, notice: this })
    this.onclick = null
    this.closed = false
  }
  close() { this.closed = true }
}
const windowStub = {
  __ModuleLoader__: { load: (spec) => { windowStub.spec = spec } },
  focus: () => { focused = true },
  // The notice withdrawal listens for the window coming back.
  listeners: new Map(),
  addEventListener: (name, handler) => { windowStub.listeners.set(name, handler) },
  removeEventListener: (name) => { windowStub.listeners.delete(name) },
}
const documentStub = {
  addEventListener: () => {},
  removeEventListener: () => {},
  visibilityState: 'hidden',
  focused: false,
  hasFocus() { return this.focused },
  querySelector: () => null,
  createElement: () => ({ setAttribute: () => {}, textContent: '' }),
  head: { appendChild: () => {} },
}
globalThis.window = windowStub
globalThis.document = documentStub
globalThis.Notification = FakeNotification

await import(pathToFileURL(join(root, 'client/client.js')).href)
const spec = windowStub.spec
check('the bundle registers itself under the plugin id', spec?.id === 'dsh-notify')
//#endregion

//#region fake client
const React = { createElement: () => null, useState: () => [null, () => {}] }
const exports = spec.factory((name) => (name === 'react' ? React : undefined))
check('the client half exports apply and inject', typeof exports.apply === 'function' && Array.isArray(exports.inject))
check('it injects the sessions, locale, slots and workspace services',
  ['sessions', 'locale', 'slots', 'uiWorkspace'].every(name => exports.inject.includes(name)), JSON.stringify(exports.inject))

const listListeners = []
const opened = []
const streams = new Map()
const streamListeners = []
const bindingFor = (id) => ({
  eventSource: {
    getSnapshot: () => ({ change: { kind: 'append', entries: (streams.get(id) ?? []).map(event => ({ event })) } }),
    // A live source delivers only appends after subscribing, like the real binding.
    subscribe: (fn) => { streamListeners.push(fn); return () => {} },
  },
})
/** Re-read every bound stream after the test changed what it carries. */
const pulse = () => { for (const fn of streamListeners) fn() }
let snapshot = { ids: [], byId: {} }
const ctx = {
  effect: (fn) => { fn(); return () => {} },
  locale: { register: () => {}, bind: () => (key, vars) => {
    if (vars === undefined) return key
    const rest = Object.entries(vars).map(([name, value]) => `${name}=${value}`).join(' ')
    return `${key}:${rest}`
  } },
  sessions: {
    list: { getSnapshot: () => snapshot, subscribe: (fn) => { listListeners.push(fn); return () => {} } },
    binding: (id) => (streams.has(id) ? bindingFor(id) : undefined),
  },
  slots: { inject: () => {}, register: () => () => {} },
  uiWorkspace: { openSession: (id) => { opened.push(id) } },
}
exports.apply(ctx)
check('it subscribed to the session list', listListeners.length === 1)
//#endregion

const observe = (next) => { snapshot = next; listListeners[0]() }
const row = (id, title, isRunning, mainView = true) => ({
  id,
  displayTitle: title,
  running: isRunning,
  retainedBy: mainView ? { mainView: 1 } : {},
})
const running = (title, isRunning, mainView = true) => ({ ids: ['a'], byId: { a: row('a', title, isRunning, mainView) } })
/// Two Sessions at once: `a` in the background, `b` on screen.
const alongside = (aRunning, bRunning) => ({
  ids: ['a', 'b'],
  byId: { a: row('a', '修 CI', aRunning, false), b: row('b', '问候', bRunning, true) },
})

/** What the Host answers for `/dsh-notify/notice`; null makes the route miss. */
let noticeReply = { title: 'dsh-plugins - 修 CI - 把 CI 修好', body: '✅ 已修好' }
const asked = []
globalThis.fetch = async (url) => {
  asked.push(String(url))
  if (noticeReply === null) return { ok: false, status: 404, json: async () => ({}) }
  return { ok: true, status: 200, json: async () => noticeReply }
}
const settle = () => new Promise((resolve) => { setTimeout(resolve, 0) })
/** One finished turn: the running flag drops, and the browser asks the Host. */
const finish = async (title = '修 CI', mainView = true) => {
  observe(running(title, true, mainView))
  observe(running(title, false, mainView))
  await settle()
}

console.log('it shows the notice the Host composed')
documentStub.focused = false
await finish()
check('one notification, with the heading the Host composed', shown.length === 1 && shown[0].title === 'dsh-plugins - 修 CI - 把 CI 修好', JSON.stringify(shown))
check('and the content line it composed too', shown[0].body === '✅ 已修好', String(shown[0].body))
check('the browser asked the Host for it', asked.at(-1)?.includes('/dsh-notify/notice?session=a') === true, JSON.stringify(asked.at(-1)))
check('the tag is per session, so repeats replace instead of stacking', shown[0].tag === 'dsh-notify:a')
// Without this the browser withdraws the notice the moment the tab becomes active
// again, which is when the person comes back to read it.
check('the notice asks to stay until it is handled', shown[0].persistent === true, JSON.stringify(shown[0]))
// A replacement carrying the same tag is silent by default, so without this a
// second finished turn would swap the notice out without alerting anyone.
check('and to alert again when it replaces the previous one', shown[0].renotify === true, JSON.stringify(shown[0]))

console.log('it stays quiet while the window has focus')
documentStub.focused = true
const quietAsked = asked.length
await finish()
check('no notification while focused', shown.length === 1)
check('and the Host is not even asked', asked.length === quietAsked, JSON.stringify(asked.length))

console.log('an unfocused window is enough, even with the tab still visible')
documentStub.focused = false
documentStub.visibilityState = 'visible'
await finish()
check('another application in front still gets a notice', shown.length === 2, JSON.stringify(shown.at(-1)))
documentStub.visibilityState = 'hidden'

console.log('the text is exactly what the Host published')
noticeReply = { title: 'dsh-plugins - 修 CI - 把 CI 修好', body: '❌ provider refused the request' }
await finish()
check('an error body is passed through untouched',
  shown.length === 3 && shown[2].body === '❌ provider refused the request', JSON.stringify(shown.at(-1)))

console.log('a turn the Host has no notice for shows nothing')
noticeReply = null
await finish()
check('nothing is shown when the route misses', shown.length === 3, JSON.stringify(shown.at(-1)))
noticeReply = { title: 'dsh-plugins - 修 CI - 把 CI 修好', body: '✅ 已修好' }

console.log('it respects a denied permission, and unsupported browsers')
FakeNotification.permission = 'denied'
await finish()
check('nothing is shown without permission', shown.length === 3)
FakeNotification.permission = 'granted'

console.log('clicking a notification brings the window back')
documentStub.visibilityState = 'hidden'
await finish()
check('the notification was shown', shown.length === 4)

const clicked = shown.at(-1).notice
focused = false
opened.length = 0
clicked.onclick()
check('the window is focused', focused === true)
check('the Session is opened', opened.join(',') === 'a', JSON.stringify(opened))
check('and the notice is dismissed', clicked.closed === true)

console.log('the browser shows the Host lines verbatim, including the budgets it applied')
noticeReply = { title: 'dsh-plugins - 问候 - 把 CI 修好…', body: `✅ ${'y'.repeat(139)}…` }
await finish('问候')
const last = shown.at(-1)
check('the heading is the Host heading', last.title === 'dsh-plugins - 问候 - 把 CI 修好…', JSON.stringify(last.title))
check('the body is the Host body', last.body === `✅ ${'y'.repeat(139)}…`, JSON.stringify(last.body.slice(0, 40)))
check('and nothing is re-truncated or trimmed here', last.body.endsWith('…'), String(last.body.length))

console.log('coming back to the window withdraws the notice on screen')
documentStub.focused = false
documentStub.visibilityState = 'hidden'
noticeReply = { title: 'dsh-plugins - 修 CI - 把 CI 修好', body: '✅ 已修好' }
const beforeReturn = shown.length
await finish()
const waiting = shown.at(-1)?.notice
check('a notice is waiting while the window is away', shown.length === beforeReturn + 1 && waiting?.closed === false, JSON.stringify(shown.at(-1)))
documentStub.focused = true
windowStub.listeners.get('focus')?.()
check('focusing the window dismisses it', waiting.closed === true, JSON.stringify(waiting))

console.log('switching to the Session a notice is about withdraws it too')
documentStub.focused = true
documentStub.visibilityState = 'visible'
documentStub.focused = false
await finish()
const pending = shown.at(-1)?.notice
documentStub.focused = true
observe(running('修 CI', false))
check('the notice for the Session now on screen is dismissed', pending.closed === true, JSON.stringify(pending))

console.log('a focused window still hears about the Session it is not showing')
documentStub.focused = true
documentStub.visibilityState = 'visible'
noticeReply = { title: 'dsh-plugins - 修 CI - 把 CI 修好', body: '✅ 已修好' }
const before = shown.length
observe(alongside(true, false))
observe(alongside(false, false))
await settle()
check('the background Session notifies while you work in another one',
  shown.length === before + 1 && shown.at(-1).tag === 'dsh-notify:a', JSON.stringify(shown.at(-1)))

console.log(failures === 0 ? '\nPASS' : `\n${String(failures)} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
