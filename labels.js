/**
 * How a notice names the Session and the Workspace it belongs to.
 *
 * The GUI shows the same names, so the projections are read in one place: the Host
 * composes with them and nothing else decides what a Session is called.
 */

import { sessionFacts, UNGROUPED } from './notify.js'

/**
 * Build the naming helpers for one plugin instance.
 * @param ctx - the plugin context; reads `sessionProjections` and `workspaceRegistry`.
 * @returns the three names a notice can need.
 */
export function createLabels(ctx) {
  /**
   * Name the Session the way the GUI does.
   *
   * The title lives in the `title` projection rather than in the log header, so a
   * notification can say which conversation is asking instead of showing a bare id.
   *
   * @param session - the Session awaiting an answer.
   * @returns a one-line identity: title, project, and a short id when nothing else exists.
   */
  const sessionLabel = (session) => {
    const facts = sessionFacts(session)
    let projected = ''
    try {
      const value = ctx.get?.('sessionProjections')?.stateOf?.(session, 'title')
      if (typeof value === 'string' && value !== '') projected = value
    } catch (failure) {
      ctx.logger.warn(`dsh-notify: could not read the session title: ${String(failure)}`)
    }
    const name = projected !== '' ? projected : facts.title
    if (name === '') return facts.project === '' ? facts.shortId : `${facts.project} · ${facts.shortId}`
    return facts.project === '' ? name : `${name}（${facts.project}）`
  }

  /**
   * The Session name alone.
   *
   * The turn notice heading already names the Workspace, so repeating the directory there
   * would say the same thing twice; approvals keep the suffixed label, where it is the only
   * hint of which checkout is asking.
   *
   * @param session - the Session whose turn ended.
   * @returns the projected title, or the directory and short id when it has none yet.
   */
  const sessionName = (session) => {
    const facts = sessionFacts(session)
    let projected = ''
    try {
      const value = ctx.get?.('sessionProjections')?.stateOf?.(session, 'title')
      if (typeof value === 'string') projected = value
    } catch (failure) {
      ctx.logger.warn(`dsh-notify: could not read the session title: ${String(failure)}`)
    }
    const name = projected !== '' ? projected : facts.title
    if (name === '') return facts.project === '' ? facts.shortId : `${facts.project} · ${facts.shortId}`
    return name
  }

  /**
   * The Workspace that owns a Session, or the ungrouped label.
   *
   * Workspaces are a Host-side registry; a Session's membership lives in the owner's
   * `sessionIds`, so the label costs one scan. A host without the registry (headless
   * profiles, tests) reads as ungrouped rather than failing the notice.
   *
   * @param session - the Session whose turn ended.
   * @returns the Workspace title, or the ungrouped label.
   */
  const workspaceLabel = (session) => {
    try {
      const rows = ctx.get?.('workspaceRegistry')?.list?.() ?? []
      const id = String(session?.id ?? '')
      const owner = rows.find((row) => (row?.sessionIds ?? []).some((entry) => String(entry) === id))
      const title = typeof owner?.title === 'string' ? owner.title : ''
      return title === '' ? UNGROUPED : title
    } catch (failure) {
      ctx.logger.warn(`dsh-notify: could not read the workspace: ${String(failure)}`)
      return UNGROUPED
    }
  }

  return { sessionLabel, sessionName, workspaceLabel }
}
