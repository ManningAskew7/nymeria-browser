import type { CommandResult } from '../../shared/types'
import {
  blockedByDialogError,
  raceStandingDialog,
  standingDialog,
  standingDialogPayload,
} from '../dialogs'
import { clear as clearRefs } from '../snapshotRefs'
import { TAB_LOAD_WAIT_MS, waitForTabComplete } from '../settle'

interface NavigateArgs {
  tab_id: number
  url: string
}

const ALLOWED_SCHEMES = new Set(['http:', 'https:'])

function isAllowedUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    return ALLOWED_SCHEMES.has(u.protocol)
  } catch {
    return false
  }
}

export async function execNavigate(args: unknown): Promise<CommandResult> {
  const a = args as NavigateArgs
  if (typeof a.tab_id !== 'number') {
    return { ok: false, status: 'error', error: 'tab_id required' }
  }
  if (!isAllowedUrl(a.url)) {
    return { ok: false, status: 'error', error: 'url must be http:// or https://' }
  }
  const tab = await chrome.tabs.update(a.tab_id, { url: a.url })
  clearRefs(a.tab_id)

  // Shared with history.ts so the two cannot drift on what "loaded" means.
  // Raced against a dialog opening (#169): a beforeunload holds the tab on
  // its old page, and riding the 25s wait into `complete: false` would be
  // the old dishonest shape with a known cause standing right there.
  const outcome = await raceStandingDialog(
    a.tab_id,
    waitForTabComplete(a.tab_id, TAB_LOAD_WAIT_MS),
  )
  const finalTab = await chrome.tabs.get(a.tab_id).catch(() => null)

  // Belt over the race: `waitForTabComplete` can win by reading the OLD
  // page's status:"complete" before the load it just triggered starts (its
  // own doc warns exactly this), and a beforeunload standing at that instant
  // would ride the early-out back to the pre-#169 dishonest success.
  // Whichever branch won, a dialog standing NOW is the story.
  const dialog = outcome.kind === 'dialog' ? outcome.dialog : standingDialog(a.tab_id)
  if (dialog) {
    return {
      ok: false,
      status: 'error',
      error: blockedByDialogError(a.tab_id, dialog),
      data: {
        tab_id: a.tab_id,
        // Honest: the tab is still where it was.
        url: (finalTab ?? tab)?.url,
        requested_url: a.url,
        dialog: standingDialogPayload(a.tab_id, dialog),
      },
    }
  }

  return {
    ok: true,
    status: 'success',
    data: {
      tab_id: a.tab_id,
      url: (finalTab ?? tab)?.url,
      title: (finalTab ?? tab)?.title,
      complete: outcome.kind === 'work' && outcome.value,
    },
  }
}
