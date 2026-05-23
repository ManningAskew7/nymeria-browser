import type { CommandResult } from '../../shared/types'

interface ScrollArgs {
  tab_id: number
  direction: 'up' | 'down' | 'left' | 'right'
  amount_px?: number
}

export async function execScroll(args: unknown): Promise<CommandResult> {
  const a = args as ScrollArgs
  if (typeof a.tab_id !== 'number') return { ok: false, status: 'error', error: 'tab_id required' }
  const amount = typeof a.amount_px === 'number' ? a.amount_px : 500
  const dxSign = a.direction === 'right' ? 1 : a.direction === 'left' ? -1 : 0
  const dySign = a.direction === 'down' ? 1 : a.direction === 'up' ? -1 : 0
  await chrome.scripting.executeScript({
    target: { tabId: a.tab_id },
    func: (dx: number, dy: number) => {
      window.scrollBy({ left: dx, top: dy, behavior: 'instant' as ScrollBehavior })
      return { x: window.scrollX, y: window.scrollY }
    },
    args: [dxSign * amount, dySign * amount],
  })
  return { ok: true, status: 'success', data: { direction: a.direction, amount_px: amount } }
}
