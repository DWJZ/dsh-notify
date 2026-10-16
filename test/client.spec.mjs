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
    shown.push({ title, body: options?.body ?? '', tag: options?.tag ?? '' })
    this.onclick = null
  }
  close() {}
}
const windowStub = {
  __ModuleLoader__: { load: (spec) => { windowStub.spec = spec } },
  focus: () => { focused = true },
}
const documentStub = { visibilityState: 'hidden' }
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
const bindings = new Map()
let snapshot = { ids: [], byId: {} }
const ctx = {
  effect: (fn) => { fn(); return () => {} },
  locale: { register: () => {}, bind: () => (key, vars) => (vars === undefined ? key : `${key}:${JSON.stringify(vars)}`) },
  sessions: {
    list: { getSnapshot: () => snapshot, subscribe: (fn) => { listListeners.push(fn); return () => {} } },
    binding: (id) => bindings.get(id),
  },
  slots: { inject: () => {}, register: () => () => {} },
}
exports.apply(ctx)
check('it subscribed to the session list', listListeners.length === 1)
//#endregion

const observe = (next) => { snapshot = next; listListeners[0]() }
const running = (title, isRunning) => ({ ids: ['a'], byId: { a: { displayTitle: title, running: isRunning } } })
const bindingWith = (reason) => ({
  eventSource: {
    getSnapshot: () => ({ change: { kind: 'append', entries: [{ event: { type: 'turn/end', data: { reason } } }] } }),
    subscribe: (fn) => { fn(); return () => {} },
  },
})

console.log('it notifies when a turn ends out of sight')
observe(running('修 CI', true))
observe(running('修 CI', false))
check('one notification, named after the session', shown.length === 1 && shown[0].title === '修 CI', JSON.stringify(shown))
check('the tag is per session, so repeats replace instead of stacking', shown[0].tag === 'dsh-notify:a')
check('an unreadable status still says something', shown[0].body.includes('statusOther'))

console.log('it stays quiet while the window is in front')
documentStub.visibilityState = 'visible'
observe(running('修 CI', true))
observe(running('修 CI', false))
check('no notification while visible', shown.length === 1)

console.log('it reads the status from the turn that ended')
documentStub.visibilityState = 'hidden'
bindings.set('a', bindingWith({ kind: 'error' }))
observe(running('修 CI', true))
observe(running('修 CI', false))
check('the error status is carried', shown.length === 2 && shown[1].body.includes('statusError'), JSON.stringify(shown.at(-1)))

console.log('it respects a denied permission, and unsupported browsers')
FakeNotification.permission = 'denied'
observe(running('修 CI', true))
observe(running('修 CI', false))
check('nothing is shown without permission', shown.length === 2)
FakeNotification.permission = 'granted'

console.log('clicking a notification brings the window back')
documentStub.visibilityState = 'hidden'
observe(running('修 CI', true))
observe(running('修 CI', false))
check('the notification was shown', shown.length === 3)

console.log(failures === 0 ? '\nPASS' : `\n${String(failures)} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
