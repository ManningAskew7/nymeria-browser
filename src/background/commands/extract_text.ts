import type { CommandResult } from '../../shared/types'

interface ExtractTextArgs {
  tab_id: number
  selector?: string
  max_chars?: number
}

export async function execExtractText(args: unknown): Promise<CommandResult> {
  const a = args as ExtractTextArgs
  if (typeof a.tab_id !== 'number') return { ok: false, status: 'error', error: 'tab_id required' }
  const limit = typeof a.max_chars === 'number' && a.max_chars > 0 ? a.max_chars : 50_000

  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: a.tab_id },
    func: (sel: string | undefined) => {
      const root: HTMLElement | null = sel ? (document.querySelector(sel) as HTMLElement | null) : document.body
      if (!root) return { found: false, text: '' }
      return { found: true, text: root.innerText ?? '' }
    },
    args: [a.selector],
  })

  if (!result?.found) {
    return { ok: false, status: 'error', error: `selector matched no element: ${a.selector}` }
  }
  let text = result.text
  const truncated = text.length > limit
  if (truncated) text = text.slice(0, limit)
  return { ok: true, status: 'success', data: { text, truncated } }
}
