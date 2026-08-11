import type { CommandResult } from '../../shared/types'
import { withSession } from '../debuggerSession'
import { clear as clearNetwork, read as readNetwork } from '../networkBuffer'

/**
 * Read buffered network activity for a tab.
 *
 * Capture is already running (enabled when the debugger attached), so this
 * returns history rather than starting a recording.
 */

interface NetworkArgs {
  tab_id: number
  url_pattern?: string
  only_failures?: boolean
  limit?: number
  clear?: boolean
}

export async function execNetwork(args: unknown): Promise<CommandResult> {
  const a = args as NetworkArgs
  if (typeof a.tab_id !== 'number') return { ok: false, status: 'error', error: 'tab_id required' }

  // Touch the session so the Network domain is enabled even if this is the
  // first command ever sent to the tab.
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
    },
  }
}
