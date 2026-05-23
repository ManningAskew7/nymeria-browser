import type { CommandResult } from '../../shared/types'
import { clear as clearRefs } from '../snapshotRefs'

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

  // Wait until the tab finishes loading (or 25s, whichever first).
  const finalTab = await new Promise<chrome.tabs.Tab | null>((resolve) => {
    let resolved = false
    const finish = (t: chrome.tabs.Tab | null) => {
      if (resolved) return
      resolved = true
      chrome.tabs.onUpdated.removeListener(listener)
      clearTimeout(timer)
      resolve(t)
    }
    const listener = (changedId: number, info: { status?: string }, t: chrome.tabs.Tab) => {
      if (changedId === a.tab_id && info.status === 'complete') finish(t)
    }
    chrome.tabs.onUpdated.addListener(listener)
    const timer = setTimeout(() => finish(null), 25_000)
  })

  return {
    ok: true,
    status: 'success',
    data: {
      tab_id: a.tab_id,
      url: (finalTab ?? tab)?.url,
      title: (finalTab ?? tab)?.title,
      complete: finalTab !== null,
    },
  }
}
