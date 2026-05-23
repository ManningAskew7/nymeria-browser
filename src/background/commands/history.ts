import type { CommandResult } from '../../shared/types'

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
  // chrome.scripting.executeScript with history.back()/forward() is the
  // simplest portable path.
  await chrome.scripting.executeScript({
    target: { tabId: a.tab_id },
    func: (dir: 'back' | 'forward') => {
      if (dir === 'back') window.history.back()
      else window.history.forward()
    },
    args: [a.direction],
  })
  return { ok: true, status: 'success', data: { direction: a.direction } }
}
