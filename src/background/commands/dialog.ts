import type { CommandResult } from '../../shared/types'
import { CdpCallTimeout, sendCommand, TabUnusable } from '../debuggerSession'

interface DialogArgs {
  tab_id: number
  action: 'accept' | 'dismiss'
  prompt_text?: string
}

/**
 * Sized INSIDE this command's 5s backend budget, unlike the 15s default,
 * which the backend would always outrun here: dialog is aimed at a suspended
 * tab by definition, so its calls hanging is the expected failure, and the
 * honest named timeout has to arrive before the transport gives up and
 * blames the extension.
 */
const DIALOG_CALL_DEADLINE_MS = 3_500

export async function execDialog(args: unknown): Promise<CommandResult> {
  const a = args as DialogArgs
  if (typeof a.tab_id !== 'number') return { ok: false, status: 'error', error: 'tab_id required' }
  if (a.action !== 'accept' && a.action !== 'dismiss') {
    return { ok: false, status: 'error', error: "action must be 'accept' or 'dismiss'" }
  }
  try {
    const opts = { deadlineMs: DIALOG_CALL_DEADLINE_MS }
    await sendCommand(a.tab_id, 'Page.enable', {}, opts)
    await sendCommand(a.tab_id, 'Page.handleJavaScriptDialog', {
      accept: a.action === 'accept',
      ...(a.prompt_text != null ? { promptText: a.prompt_text } : {}),
    }, opts)
    return { ok: true, status: 'success', data: { action: a.action } }
  } catch (e) {
    // The session layer's failures carry their own diagnosis and remedy;
    // wrapping them as "no pending dialog?" would misattribute exactly the
    // cases they exist to name.
    if (e instanceof CdpCallTimeout || e instanceof TabUnusable) {
      return { ok: false, status: 'error', error: e.message }
    }
    return { ok: false, status: 'error', error: `dialog failed (no pending dialog?): ${String(e)}` }
  }
}
