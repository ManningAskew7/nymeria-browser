import type { CommandResult } from '../../shared/types'
import {
  blockedByDialogError,
  raceStandingDialog,
  standingDialog,
  standingDialogPayload,
} from '../dialogs'
import { clear as clearRefs } from '../snapshotRefs'
import { TAB_LOAD_WAIT_MS, waitForTabComplete } from '../settle'

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
  // Same dialog race as navigate (#169): a beforeunload can hold a
  // back/forward exactly as it holds a navigation, and the honest failure
  // names it instead of riding the wait.
  const outcome = await raceStandingDialog(
    a.tab_id,
    waitForTabComplete(a.tab_id, TAB_LOAD_WAIT_MS),
  )
  const after = await chrome.tabs.get(a.tab_id).catch(() => null)

  // Same belt as navigate: the complete-read can win on the OLD page while a
  // beforeunload stands; a dialog standing NOW is the story either way.
  const dialog = outcome.kind === 'dialog' ? outcome.dialog : standingDialog(a.tab_id)
  if (dialog) {
    return {
      ok: false,
      status: 'error',
      error: blockedByDialogError(a.tab_id, dialog),
      data: {
        direction: a.direction,
        url: after?.url,
        dialog: standingDialogPayload(a.tab_id, dialog),
      },
    }
  }

  return {
    ok: true,
    status: 'success',
    data: {
      direction: a.direction,
      url: after?.url,
      title: after?.title,
      url_changed: Boolean(before?.url && after?.url && before.url !== after.url),
      complete: outcome.kind === 'work' && outcome.value,
    },
  }
}
