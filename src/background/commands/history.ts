import type { CommandResult } from '../../shared/types'
import { clear as clearRefs } from '../snapshotRefs'
import { waitForTabComplete } from '../settle'

/**
 * Move a tab through its session history.
 *
 * Uses `chrome.tabs.goBack/goForward`, which need no host permission, rather
 * than injecting `history.back()` (which does). It also reports honestly when
 * there is nowhere to go and waits for the destination to load, instead of
 * returning the instant the request is made and leaving the caller to read a
 * page that is still the old one.
 */

interface HistoryArgs {
  tab_id: number
  direction: 'back' | 'forward'
}

export async function execHistory(args: unknown): Promise<CommandResult> {
  const a = args as HistoryArgs
  if (typeof a.tab_id !== 'number') {
    return { ok: false, status: 'error', error: 'tab_id required' }
  }
  if (a.direction !== 'back' && a.direction !== 'forward') {
    return { ok: false, status: 'error', error: 'direction must be back or forward' }
  }

  const before = await chrome.tabs.get(a.tab_id).catch(() => null)
  try {
    if (a.direction === 'back') await chrome.tabs.goBack(a.tab_id)
    else await chrome.tabs.goForward(a.tab_id)
  } catch (e) {
    return {
      ok: false,
      status: 'error',
      error: `cannot go ${a.direction}: this tab has no ${a.direction} entry (${String(e)})`,
    }
  }
  clearRefs(a.tab_id)
  const complete = await waitForTabComplete(a.tab_id, 15_000)
  const after = await chrome.tabs.get(a.tab_id).catch(() => null)

  return {
    ok: true,
    status: 'success',
    data: {
      direction: a.direction,
      url: after?.url,
      title: after?.title,
      url_changed: Boolean(before?.url && after?.url && before.url !== after.url),
      complete,
    },
  }
}
