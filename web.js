/**
 * The routes the browser half calls.
 *
 * Every route owns its own response and accepts loopback same-origin callers only, the
 * same rule the restart plugin's control routes follow.
 */

/** Whether a request came from this machine, same origin, with no proxy in front. */
function sameOriginLoopback(req) {
  const address = req.socket?.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  if (req.headers.forwarded !== undefined
    || req.headers['x-forwarded-for'] !== undefined
    || req.headers['x-real-ip'] !== undefined) return false
  const host = req.headers.host ?? ''
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin === '') return host !== ''
  try { return new URL(origin).host === host } catch { return false }
}

/**
 * Answer `/dsh-notify/notice?session=<id>` with the newest composed notice.
 *
 * The browser composes nothing: it asks for the text the Host already sent to Discord,
 * so both surfaces always show the same sentence.
 * @param notices - reads the per-Session notice store.
 * @returns a request handler that owns its response.
 */
function noticeHandler(notices) {
  return (req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405, { allow: 'GET' })
      res.end()
      return
    }
    if (!sameOriginLoopback(req)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('notices are limited to same-origin loopback requests')
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const notice = notices().get(url.searchParams.get('session') ?? '')
    if (notice === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('no notice for that session')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ title: notice.title, body: notice.body }))
  }
}

/**
 * Register `/dsh-notify/notice` on the web host.
 * @param ctx - the plugin context.
 * @param notices - reads the newest composed notice per Session.
 */
export function mountNoticeRoute(ctx, notices) {
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/dsh-notify/notice',
      handler: noticeHandler(notices),
    }), 'dsh-notify: notice route')
  })
}
