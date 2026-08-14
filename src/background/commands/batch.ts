import type { CommandResult } from '../../shared/types'
import { commitSeq, commitSince, navigationPending } from '../navWatch'

/**
 * Run several commands in one round trip.
 *
 * On a remote SSE link the per-action round trip dominates wall clock, so a
 * four-step login is four network crossings for four trivial actions. Batching
 * collapses that to one.
 *
 * Two failure modes are designed out rather than documented as gotchas,
 * because both are live footguns in Anthropic's shipped implementation:
 *
 *  - A failure aborts the tail rather than charging on, and the result says
 *    exactly how far it got.
 *  - A navigation mid-batch aborts the remainder. Every later action was
 *    written against the old page: its refs point into a document that no
 *    longer exists and its coordinates describe a layout that is gone.
 *    Continuing would act on the new page with the old page's intent.
 */

export interface BatchAction {
  type: string
  args?: Record<string, unknown>
}

interface BatchArgs {
  tab_id?: number
  actions?: BatchAction[]
  /**
   * Escape hatch for a sequence that deliberately spans a navigation: a URL
   * change, a same-URL reload, or a navigation still in flight at step end.
   */
  continue_on_url_change?: boolean
}

export type SingleRunner = (type: string, args: unknown) => Promise<CommandResult>

export const MAX_BATCH_ACTIONS = 20

/**
 * What a batch may run, as an ALLOWLIST.
 *
 * A denylist here was a privilege-escalation hole: a batch step of
 * `{type: "cdp"}` reached the escape-hatch executor from the MODERATE
 * `chrome_batch`, skipping every safeguard the typed tools add. The
 * browser-control kit now BINDS `chrome_cdp` (#167), so keeping it out of
 * batches is a decision rather than a leftover: the escape hatch is
 * last-resort and method-denylisted (cdp.ts), and each raw call stays a
 * single, individually visible, individually justified round trip. Batching
 * is for ordinary page work; diagnostics and escape hatches are single
 * calls.
 */
const ALLOWED_IN_BATCH = new Set([
  'act',
  'navigate',
  'snapshot',
  'extract_text',
  'screenshot',
  'tabs',
  'history',
])

async function urlOf(tabId: number | undefined): Promise<string | null> {
  if (typeof tabId !== 'number') return null
  try {
    const tab = await chrome.tabs.get(tabId)
    return tab?.url ?? null
  } catch {
    return null
  }
}

export async function execBatch(args: unknown, run: SingleRunner): Promise<CommandResult> {
  const a = (args ?? {}) as BatchArgs
  const actions = a.actions
  if (!Array.isArray(actions) || actions.length === 0) {
    return { ok: false, status: 'error', error: 'actions must be a non-empty array' }
  }
  if (actions.length > MAX_BATCH_ACTIONS) {
    return {
      ok: false,
      status: 'error',
      error: `batch is limited to ${MAX_BATCH_ACTIONS} actions (got ${actions.length})`,
    }
  }
  for (const action of actions) {
    if (!action || typeof action.type !== 'string') {
      return { ok: false, status: 'error', error: 'each action needs a string "type"' }
    }
    if (!ALLOWED_IN_BATCH.has(action.type)) {
      return {
        ok: false,
        status: 'error',
        error:
          `"${action.type}" cannot run inside a batch. Allowed: ` +
          `${Array.from(ALLOWED_IN_BATCH).sort().join(', ')}. Run it as a single command.`,
      }
    }
  }

  const results: { type: string; ok: boolean; data?: unknown; error?: string }[] = []
  let abortedReason: string | null = null
  let urlBefore = await urlOf(a.tab_id)

  for (let i = 0; i < actions.length; i += 1) {
    const action = actions[i]
    // A per-action tab_id may be present; otherwise inherit the batch's.
    const actionArgs = { tab_id: a.tab_id, ...(action.args ?? {}) }
    const stepStart = Date.now()
    const seqBefore = typeof a.tab_id === 'number' ? commitSeq(a.tab_id) : 0
    let result: CommandResult
    try {
      result = await run(action.type, actionArgs)
    } catch (e) {
      result = { ok: false, status: 'error', error: String(e) }
    }
    results.push({
      type: action.type,
      ok: result.ok,
      ...(result.data === undefined ? {} : { data: result.data }),
      ...(result.error ? { error: result.error } : {}),
    })

    if (!result.ok) {
      abortedReason = `action ${i + 1} ("${action.type}") failed`
      break
    }

    // #168 gate: a step that armed a wait condition and did not see it is a
    // checkpoint the agent asked for. The step itself succeeded (its input
    // was delivered, which is why this is not the failure branch above); the
    // remaining actions were written against a page state that never
    // arrived, so they do not run. No escape hatch: the gate is armed
    // explicitly per action, and not arming it is the bypass.
    const d = result.data as Record<string, unknown> | undefined
    if (
      i < actions.length - 1 &&
      action.type === 'act' &&
      d &&
      d.found === false &&
      typeof d.condition === 'string'
    ) {
      abortedReason =
        `action ${i + 1} ("act") was delivered, but its wait condition (${d.condition}) ` +
        'was not met. The remaining actions were written against a page state that never ' +
        'arrived, so they were not run.'
      break
    }
    // The mirror of the gate: a MET condition is consent to whatever page
    // change it implies. "Click sign in, wait for 'Welcome back'" names the
    // navigation as the expected outcome, so aborting on it would refuse the
    // exact sequence the agent wrote. Steps after a met condition run against
    // the page state the agent asked to see.
    const met =
      action.type === 'act' && d !== undefined && d.found === true && typeof d.condition === 'string'

    // A dialog left STANDING by a successful step stops the batch: every
    // executor refuses on a standing dialog, so charging on only converts
    // this named cause into a one-step-later refusal, and the tail would run
    // against a page paused on a question the agent has not answered.
    const dialog = d?.dialog as
      | { state?: string; type?: string; message?: string; answer_with?: string }
      | undefined
    if (i < actions.length - 1 && dialog?.state === 'standing') {
      abortedReason =
        `action ${i + 1} ("${action.type}") left a ${dialog.type ?? 'page'} dialog standing` +
        (dialog.message ? `: "${dialog.message}"` : '') +
        '. The page is paused on it, so the remaining actions were not run. Answer it with ' +
        `${dialog.answer_with ?? 'chrome_dialog'}, then continue from there.`
      break
    }

    const urlAfter = await urlOf(a.tab_id)
    // The browser-process record catches what a URL compare cannot: a
    // same-URL commit (a reload) replaces the document and kills every ref
    // minted before it. The compare stays because it catches what the record
    // cannot: an SPA move changes the URL with no commit.
    const urlChanged = Boolean(urlBefore && urlAfter && urlBefore !== urlAfter)
    const committed = typeof a.tab_id === 'number' && Boolean(commitSince(a.tab_id, seqBefore))
    const pending = typeof a.tab_id === 'number' ? navigationPending(a.tab_id, stepStart) : null
    urlBefore = urlAfter
    if (i < actions.length - 1 && !a.continue_on_url_change && !met) {
      if (committed || urlChanged) {
        abortedReason = urlChanged
          ? `the page navigated to ${urlAfter} after action ${i + 1} ("${action.type}"). ` +
            'The remaining actions were written against the previous page, so they were not run. ' +
            'Read the new page and continue from there.'
          : `a new document committed at ${urlAfter} after action ${i + 1} ("${action.type}") ` +
            '(a reload: same URL, new page). The refs the remaining actions were written ' +
            'against died with the old document, so they were not run. Re-read the page and ' +
            'continue from there.'
        break
      }
      // Started, not yet committed: the page is ABOUT to be replaced, which
      // is the exact footgun the abort above exists for, one beat earlier.
      if (pending) {
        abortedReason =
          `a navigation to ${pending.url} was still in flight after action ${i + 1} ` +
          `("${action.type}"). The remaining actions were written against the previous page, ` +
          'so they were not run. Read the new page once it arrives and continue from there.'
        break
      }
    }
  }

  const completed = results.filter((r) => r.ok).length
  const remaining = actions.length - results.length
  return {
    ok: abortedReason === null,
    status: abortedReason === null ? 'success' : 'error',
    data: {
      results,
      completed,
      remaining,
      total: actions.length,
      ...(abortedReason ? { aborted: abortedReason } : {}),
    },
    ...(abortedReason
      ? { error: `${abortedReason} (${completed} completed, ${remaining} not run)` }
      : {}),
  }
}
