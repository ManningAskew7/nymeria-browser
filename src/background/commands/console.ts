import type { CommandResult } from '../../shared/types'
import { clear as clearBuffer, read } from '../consoleBuffer'
import { withSession } from '../debuggerSession'

/**
 * Read buffered console messages and uncaught exceptions.
 *
 * Capture rides CDP (`Runtime.consoleAPICalled` / `Runtime.exceptionThrown`),
 * enabled when the debugger attaches, so this returns history rather than
 * starting a recording.
 *
 * It deliberately does NOT inject a page-side wrapper any more. That was the
 * original mechanism and it needed `chrome.scripting` host permission for the
 * origin, so on any site the user had not separately granted, the command
 * failed while the answer was already sitting in the buffer. Removing it also
 * takes the last MAIN-world injection out of the extension.
 */

interface ConsoleArgs {
  tab_id: number
  clear?: boolean
  only_errors?: boolean
  limit?: number
}

export async function execConsole(args: unknown): Promise<CommandResult> {
  const a = args as ConsoleArgs
  if (typeof a.tab_id !== 'number') return { ok: false, status: 'error', error: 'tab_id required' }

  // Touch the session so capture is enabled even if this is the first command
  // ever sent to the tab.
  await withSession(a.tab_id, async () => undefined)

  const entries = read(a.tab_id, { only_errors: a.only_errors, limit: a.limit })
  if (a.clear) clearBuffer(a.tab_id)
  return { ok: true, status: 'success', data: { entries, count: entries.length } }
}
