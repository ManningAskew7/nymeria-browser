import type { CommandResult } from '../../shared/types'
import { everAttached, isAttached, withSession } from '../debuggerSession'
import { clear as clearNetwork, read as readNetwork } from '../networkBuffer'

/**
 * Read buffered network activity for a tab.
 *
 * Capture is already running while a tab is being driven (the Network domain
 * is enabled at attach), so this returns history rather than starting a
 * recording. It is not continuous, and the two ways it can be silent are
 * different facts, so the payload names whichever applies:
 *
 * - `capture_started_now`: this tab has never been attached (so never
 *   captured) and this call is what starts it. An empty list says nothing
 *   about the page.
 * - `capture_resumed`: the tab was captured before but the session had been
 *   released (the debugger detaches after an idle linger), so whatever the
 *   page did between commands was never seen.
 *
 * Both read the SESSION layer, not the buffer: an emptied buffer (`clear`, or
 * a tab driven that made no requests) is not a tab that was never watched,
 * and answering from `hasHistory` would have called those cold starts.
 *
 * Without them a bare `count: 0` reads as "this page made no requests", which
 * is a claim about the page rather than about the buffer.
 *
 * There is no settle wait here, unlike console.ts's COLD_ATTACH_REPLAY_MS:
 * Runtime and Log replay their backlog on enable and `Network.enable` replays
 * nothing, so waiting would buy silence.
 */

interface NetworkArgs {
  tab_id: number
  url_pattern?: string
  only_failures?: boolean
  /** Newest N entries; defaults to 50 here, and 0 returns none. */
  limit?: number
  clear?: boolean
}

export async function execNetwork(args: unknown): Promise<CommandResult> {
  const a = args as NetworkArgs
  if (typeof a.tab_id !== 'number') return { ok: false, status: 'error', error: 'tab_id required' }

  // Touch the session so the Network domain is enabled even if this is the
  // first command ever sent to the tab, reading FIRST whether capture was
  // actually running when the question was asked.
  const wasAttached = isAttached(a.tab_id)
  const wasCapturedBefore = everAttached(a.tab_id)
  await withSession(a.tab_id, async () => undefined)

  const entries = readNetwork(a.tab_id, {
    url_pattern: a.url_pattern,
    only_failures: a.only_failures,
    limit: a.limit ?? 50,
  })
  if (a.clear) clearNetwork(a.tab_id)

  return {
    ok: true,
    status: 'success',
    data: {
      requests: entries,
      count: entries.length,
      filtered: Boolean(a.url_pattern || a.only_failures),
      ...(wasAttached
        ? {}
        : wasCapturedBefore
          ? { capture_resumed: true }
          : { capture_started_now: true }),
    },
  }
}
