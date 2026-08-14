import type { CommandResult } from '../../shared/types'
import { sendCommand } from '../debuggerSession'

interface CdpArgs {
  tab_id: number
  method: string
  params?: Record<string, unknown>
}

/**
 * The escape hatch forwards arbitrary methods, including long-legitimate ones
 * (an awaitPromise evaluate, a slow tracing stop), so it gets most of its 60s
 * backend transport budget rather than the tight default. Still bounded: the
 * 5s left under the budget keeps the failure OURS and named instead of a bare
 * backend timeout, and stops a never-answered call from pinning the worker.
 */
const CDP_ESCAPE_DEADLINE_MS = 55_000

/**
 * What execCdp refuses, as exact method names, mirroring the backend list in
 * chrome_browser.py (#167), where the model-facing refusal copy lives. The
 * backend check is the first line and ships with the kit that binds
 * chrome_cdp; this one is the wire-level backstop that holds for every
 * caller of the executor.
 *
 * A denylist is right HERE and wrong in batch.ts, which is not a
 * contradiction: batch gates ROUTES, and any command type it failed to
 * name reached its executor anyway, so only an allowlist closes it. This
 * gates METHODS at the single executor that runs them, where an allowlist
 * would have to enumerate a protocol of hundreds of methods to keep the
 * escape hatch worth having. Three classes:
 *
 *  - Credential-store reads: one call returns session cookies (CDP bypasses
 *    HttpOnly) or site-storage tokens for every signed-in site.
 *  - Script execution: page-context JS is one invisible call from reading a
 *    token and sending it anywhere. Page.reload is in this class for its
 *    scriptToEvaluateOnLoad parameter; the tabs command already reloads.
 *  - Wedge enables: enabling Fetch or Debugger delivers nothing (no
 *    listener consumes their events) and can wedge the tab with paused
 *    requests or debugger pauses. Page IS consumed now (#169: the session
 *    enables it at attach and dialogs.ts answers its events by policy),
 *    which is exactly why a raw re-enable stays refused: ownership is
 *    already taken, with an answering policy attached, and a second client
 *    state fighting it buys nothing.
 */
export const CDP_DENIED_METHODS = new Set([
  // Credential-store reads
  'Network.getAllCookies',
  'Network.getCookies',
  'Storage.getCookies',
  'DOMStorage.getDOMStorageItems',
  'IndexedDB.requestData',
  // Script execution
  'Runtime.evaluate',
  'Runtime.callFunctionOn',
  'Runtime.runScript',
  'Page.addScriptToEvaluateOnNewDocument',
  'Page.addScriptToEvaluateOnLoad',
  'Page.reload',
  // Wedge enables
  'Fetch.enable',
  'Debugger.enable',
  'Page.enable',
])

export async function execCdp(args: unknown): Promise<CommandResult> {
  const a = args as CdpArgs
  if (typeof a.tab_id !== 'number') return { ok: false, status: 'error', error: 'tab_id required' }
  if (!a.method) return { ok: false, status: 'error', error: 'method required' }
  if (CDP_DENIED_METHODS.has(a.method)) {
    return {
      ok: false,
      status: 'error',
      error:
        `method "${a.method}" is refused: it can hand over the user's stored ` +
        'credentials or wedge their browser. Nothing was sent.',
    }
  }
  try {
    const result = await sendCommand(a.tab_id, a.method, a.params ?? {}, {
      deadlineMs: CDP_ESCAPE_DEADLINE_MS,
    })
    return { ok: true, status: 'success', data: { method: a.method, result } }
  } catch (e) {
    return { ok: false, status: 'error', error: `cdp ${a.method} failed: ${String(e)}` }
  }
}
