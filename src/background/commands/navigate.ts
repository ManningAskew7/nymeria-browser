import type { CommandResult } from '../../shared/types'
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
  const complete = await waitForTabComplete(a.tab_id, TAB_LOAD_WAIT_MS)
  const finalTab = await chrome.tabs.get(a.tab_id).catch(() => null)

  return {
    ok: true,
    status: 'success',
    data: {
      tab_id: a.tab_id,
      url: (finalTab ?? tab)?.url,
      title: (finalTab ?? tab)?.title,
      complete,
    },
  }
}
