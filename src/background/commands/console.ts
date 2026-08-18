import type { CommandResult } from '../../shared/types'
import { clear as clearBuffer, read } from '../consoleBuffer'
import { withSession } from '../debuggerSession'
import { sampleCaptureFlags } from './captureFlags'

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

/**
 * How long a COLD attach gets for the enable backlog to arrive before the
 * first read. Runtime and Log replay their buffered entries on enable, but
 * the enables are fire-and-forget inside the attach, so a read issued the
 * same instant returns before the replay lands: the exact "empty the first
 * time you ask" failure this capture design exists to prevent (measured
 * live 2026-08-16: a first read right after attach missed a frame's whole
 * load history, then a re-ask saw it). Local IPC, so the replay is a
 * few-ms affair; the bound just keeps a wedged tab from eating the budget.
 */
const COLD_ATTACH_REPLAY_MS = 400

export async function execConsole(args: unknown): Promise<CommandResult> {
  const a = args as ConsoleArgs
  if (typeof a.tab_id !== 'number') return { ok: false, status: 'error', error: 'tab_id required' }

  // Touch the session so capture is enabled even if this is the first command
  // ever sent to the tab, sampling the capture-honesty flags FIRST (#183):
  // console had the same silence ambiguity as network, unflagged, until this
  // read joined the shared sampler.
  const capture = sampleCaptureFlags(a.tab_id)
  await withSession(a.tab_id, async () => undefined)
  if (!capture.wasAttached) {
    await new Promise((resolve) => setTimeout(resolve, COLD_ATTACH_REPLAY_MS))
  }

  // Whole matching set first, then under the limit: the total is what makes
  // a truncated answer honest (`count` means rows RETURNED), same rule and
  // same measured confusion as network.ts. only_errors defaults ON at the
  // backend, so a cut here was doubly easy to read as "the page logged
  // nothing" (#183-rider parity, flagged by the health read's true counts).
  const matched = read(a.tab_id, { only_errors: a.only_errors })
  const entries = read(a.tab_id, { only_errors: a.only_errors, limit: a.limit })
  if (a.clear) clearBuffer(a.tab_id)
  return {
    ok: true,
    status: 'success',
    data: {
      entries,
      count: entries.length,
      ...(matched.length > entries.length ? { matched_total: matched.length } : {}),
      filtered: Boolean(a.only_errors),
      ...capture.flags,
    },
  }
}
