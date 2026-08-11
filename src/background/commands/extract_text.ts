import type { CommandResult } from '../../shared/types'
import { sendCommand } from '../debuggerSession'

/**
 * Visible text of a page or of one region.
 *
 * Reads through CDP rather than `chrome.scripting.executeScript`, which needs
 * host permission for the origin. The debugger is already attached and needs
 * none, so this works on every site the agent can reach instead of only the
 * ones the user has separately granted.
 */

interface ExtractTextArgs {
  tab_id: number
  selector?: string
  max_chars?: number
}

interface PageText {
  found: boolean
  text: string
  url: string
  title: string
}

export async function execExtractText(args: unknown): Promise<CommandResult> {
  const a = args as ExtractTextArgs
  if (typeof a.tab_id !== 'number') return { ok: false, status: 'error', error: 'tab_id required' }
  const limit = typeof a.max_chars === 'number' && a.max_chars > 0 ? a.max_chars : 50_000
  const selectorLiteral = a.selector ? JSON.stringify(a.selector) : 'null'

  const resp = await sendCommand<{ result?: { value?: PageText } }>(a.tab_id, 'Runtime.evaluate', {
    expression: `(function(){
      const sel = ${selectorLiteral};
      const root = sel ? document.querySelector(sel) : document.body;
      if (!root) return { found: false, text: '', url: location.href, title: document.title };
      return {
        found: true,
        text: root.innerText || '',
        url: location.href,
        title: document.title,
      };
    })()`,
    returnByValue: true,
  })

  const value = resp.result?.value
  if (!value?.found) {
    return {
      ok: false,
      status: 'error',
      error: a.selector ? `selector matched no element: ${a.selector}` : 'page has no readable body',
    }
  }
  let text = value.text
  const truncated = text.length > limit
  if (truncated) text = text.slice(0, limit)
  return {
    ok: true,
    status: 'success',
    data: { text, truncated, url: value.url, title: value.title },
  }
}
