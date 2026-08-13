import type { CommandResult } from '../../shared/types'

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
  /** Escape hatch for a sequence that deliberately spans a navigation. */
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

    const urlAfter = await urlOf(a.tab_id)
    const navigated = Boolean(urlBefore && urlAfter && urlBefore !== urlAfter)
    urlBefore = urlAfter
    if (navigated && i < actions.length - 1 && !a.continue_on_url_change) {
      abortedReason =
        `the page navigated to ${urlAfter} after action ${i + 1} ("${action.type}"). ` +
        'The remaining actions were written against the previous page, so they were not run. ' +
        'Read the new page and continue from there.'
      break
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
