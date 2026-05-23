import type { CommandResult } from '../../shared/types'
import { sendCommand } from '../debuggerSession'

interface DialogArgs {
  tab_id: number
  action: 'accept' | 'dismiss'
  prompt_text?: string
}

export async function execDialog(args: unknown): Promise<CommandResult> {
  const a = args as DialogArgs
  if (typeof a.tab_id !== 'number') return { ok: false, status: 'error', error: 'tab_id required' }
  if (a.action !== 'accept' && a.action !== 'dismiss') {
    return { ok: false, status: 'error', error: "action must be 'accept' or 'dismiss'" }
  }
  try {
    await sendCommand(a.tab_id, 'Page.enable', {})
    await sendCommand(a.tab_id, 'Page.handleJavaScriptDialog', {
      accept: a.action === 'accept',
      ...(a.prompt_text != null ? { promptText: a.prompt_text } : {}),
    })
    return { ok: true, status: 'success', data: { action: a.action } }
  } catch (e) {
    return { ok: false, status: 'error', error: `dialog failed (no pending dialog?): ${String(e)}` }
  }
}
