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
    shown.push({ title, body: options?.body ?? '', tag: options?.tag ?? '', persistent: options?.requireInteraction === true, renotify: options?.renotify === true })
    this.onclick = null
  }
  close() {}
}
const windowStub = {
  __ModuleLoader__: { load: (spec) => { windowStub.spec = spec } },
  focus: () => { focused = true },
}
const documentStub = {
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
check('it injects the sessions, locale and slots services',
  ['sessions', 'locale', 'slots'].every(name => exports.inject.includes(name)), JSON.stringify(exports.inject))

const listListeners = []
const streams = new Map()
const streamListeners = []
const bindingFor = (id) => ({
  eventSource: {
    getSnapshot: () => ({ change: { kind: 'append', entries: (streams.get(id) ?? []).map(event => ({ event })) } }),
    subscribe: (fn) => { streamListeners.push(fn); fn(); return () => {} },
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
}
exports.apply(ctx)
check('it subscribed to the session list', listListeners.length === 1)
//#endregion

const observe = (next) => { snapshot = next; listListeners[0]() }
const running = (title, isRunning) => ({ ids: ['a'], byId: { a: { displayTitle: title, running: isRunning } } })
/** Publish one session's stream, then let the bound subscription see it. */
const feed = (events) => { streams.set('a', events); pulse() }

console.log('it notifies when a turn ends out of sight')
observe(running('修 CI', true))
observe(running('修 CI', false))
check('one notification, named after the session', shown.length === 1 && shown[0].title === '修 CI', JSON.stringify(shown))
check('the tag is per session, so repeats replace instead of stacking', shown[0].tag === 'dsh-notify:a')
// Without this the browser withdraws the notice the moment the tab becomes active
// again, which is when the person comes back to read it.
check('the notice asks to stay until it is handled', shown[0].persistent === true, JSON.stringify(shown[0]))
// A replacement carrying the same tag is silent by default, so without this a
// second finished turn would swap the notice out without alerting anyone.
check('and to alert again when it replaces the previous one', shown[0].renotify === true, JSON.stringify(shown[0]))
check('an unreadable status still says something', shown[0].body.includes('statusOther'))

console.log('it stays quiet while the window has focus')
documentStub.focused = true
observe(running('修 CI', true))
observe(running('修 CI', false))
check('no notification while focused', shown.length === 1)

console.log('an unfocused window is enough, even with the tab still visible')
documentStub.focused = false
documentStub.visibilityState = 'visible'
observe(running('修 CI', true))
observe(running('修 CI', false))
check('another application in front still gets a notice', shown.length === 2, JSON.stringify(shown.at(-1)))
documentStub.visibilityState = 'hidden'

console.log('it reads the status from the turn that ended')
documentStub.visibilityState = 'hidden'
feed([{ type: 'turn/end', data: { reason: { kind: 'error' } } }])
observe(running('修 CI', true))
observe(running('修 CI', false))
check('the error status is carried', shown.length === 3 && shown[2].body.includes('statusError'), JSON.stringify(shown.at(-1)))

console.log('it respects a denied permission, and unsupported browsers')
FakeNotification.permission = 'denied'
observe(running('修 CI', true))
observe(running('修 CI', false))
check('nothing is shown without permission', shown.length === 3)
FakeNotification.permission = 'granted'

console.log('clicking a notification brings the window back')
documentStub.visibilityState = 'hidden'
observe(running('修 CI', true))
observe(running('修 CI', false))
check('the notification was shown', shown.length === 4)

console.log('the notice describes the turn, not the conversation name')
feed([
  { type: 'user/message', data: { content: [{ type: 'text', text: '把 CI 修好，\n顺便看下缓存键' }] } },
  {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '已修好：缓存的 key 少了 workspace 前缀。\n另外补了一个回归测试。' }] } },
  },
  { type: 'turn/end', data: { reason: { kind: 'completed' } } },
])
observe(running('问候', true))
observe(running('问候', false))
const last = shown.at(-1)
check('the request heads the notice', last.title === '把 CI 修好， 顺便看下缓存键', JSON.stringify(last.title))
check('the status repeats which conversation it was', last.body.includes('session'), JSON.stringify(last.body))
check('the reply opening follows the status', last.body.includes('已修好：缓存的 key 少了 workspace 前缀。'), JSON.stringify(last.body))
check('and both stay on one line each', last.body.split('\n').length === 2, JSON.stringify(last.body))

console.log('long text is cut to what a notification can show')
feed([
  { type: 'user/message', data: { content: [{ type: 'text', text: 'x'.repeat(200) }] } },
  { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'y'.repeat(400) }] } } },
  { type: 'turn/end', data: { reason: { kind: 'completed' } } },
])
observe(running('问候', true))
observe(running('问候', false))
const cut = shown.at(-1)
check('the request keeps its budget', cut.title.length === 70 && cut.title.endsWith('…'), String(cut.title.length))
check('the reply keeps its budget', cut.body.split('\n')[1].length === 140, String(cut.body.split('\n')[1].length))

console.log(failures === 0 ? '\nPASS' : `\n${String(failures)} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
