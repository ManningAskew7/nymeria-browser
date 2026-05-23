import type { CommandResult } from '../../shared/types'
import { sendCommand } from '../debuggerSession'

interface CdpArgs {
  tab_id: number
  method: string
  params?: Record<string, unknown>
}

export async function execCdp(args: unknown): Promise<CommandResult> {
  const a = args as CdpArgs
  if (typeof a.tab_id !== 'number') return { ok: false, status: 'error', error: 'tab_id required' }
  if (!a.method) return { ok: false, status: 'error', error: 'method required' }
  try {
    const result = await sendCommand(a.tab_id, a.method, a.params ?? {})
    return { ok: true, status: 'success', data: { method: a.method, result } }
  } catch (e) {
    return { ok: false, status: 'error', error: `cdp ${a.method} failed: ${String(e)}` }
  }
}
