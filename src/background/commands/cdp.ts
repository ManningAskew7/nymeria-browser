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

export async function execCdp(args: unknown): Promise<CommandResult> {
  const a = args as CdpArgs
  if (typeof a.tab_id !== 'number') return { ok: false, status: 'error', error: 'tab_id required' }
  if (!a.method) return { ok: false, status: 'error', error: 'method required' }
  try {
    const result = await sendCommand(a.tab_id, a.method, a.params ?? {}, {
      deadlineMs: CDP_ESCAPE_DEADLINE_MS,
    })
    return { ok: true, status: 'success', data: { method: a.method, result } }
  } catch (e) {
    return { ok: false, status: 'error', error: `cdp ${a.method} failed: ${String(e)}` }
  }
}
