import type { CommandResult } from '../../shared/types'
import {
  clear as clearBuffer,
  isHookInstalled,
  markHookInstalled,
  push,
  read,
} from '../consoleBuffer'

interface ConsoleArgs {
  tab_id: number
  clear?: boolean
  only_errors?: boolean
  limit?: number
}

/**
 * Console capture works by injecting a small wrapper into the tab on first
 * use. The wrapper overrides console.{log,warn,error,info,debug} and
 * window.onerror, posting back to the SW via chrome.runtime.sendMessage.
 *
 * The wrapper only wires up once per page-lifetime (idempotent via a
 * window-level sentinel) but the SW has its own per-tab flag so we don't
 * re-inject on every chrome_console call.
 */
async function ensureHook(tabId: number): Promise<void> {
  if (isHookInstalled(tabId)) return
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const w = window as any
      if (w.__nymeria_console_hooked) return
      w.__nymeria_console_hooked = true
      const send = (level: string, args: unknown[]) => {
        try {
          const text = args
            .map((a) => {
              if (typeof a === 'string') return a
              try {
                return JSON.stringify(a)
              } catch {
                return String(a)
              }
            })
            .join(' ')
            .slice(0, 4000)
          window.postMessage(
            { __nymeria_console: true, level, text, ts: Date.now() },
            '*',
          )
        } catch {
          /* ignore */
        }
      }
      const consoleAny = console as unknown as Record<string, (...a: unknown[]) => void>
      for (const level of ['log', 'warn', 'error', 'info', 'debug'] as const) {
        const orig = consoleAny[level].bind(console)
        consoleAny[level] = (...a: unknown[]) => {
          send(level, a)
          orig(...a)
        }
      }
      const origOnerror = w.onerror
      w.onerror = function (
        msg: string,
        source: string,
        line: number,
        col: number,
        ...rest: unknown[]
      ): boolean {
        send('exception', [msg, `${source}:${line}:${col}`])
        if (typeof origOnerror === 'function') {
          return origOnerror.call(this, msg, source, line, col, ...rest)
        }
        return false
      }
      window.addEventListener('unhandledrejection', (e) => {
        send('exception', [`unhandledrejection: ${String((e as PromiseRejectionEvent).reason)}`])
      })
    },
  })
  // Now install the listener that copies postMessage entries into the SW
  // buffer. One listener per tab.
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    func: () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const w = window as any
      if (w.__nymeria_console_listener_installed) return
      w.__nymeria_console_listener_installed = true
      window.addEventListener('message', (e: MessageEvent) => {
        const d = e.data as { __nymeria_console?: boolean; level?: string; text?: string; ts?: number }
        if (!d || !d.__nymeria_console) return
        chrome.runtime
          .sendMessage({ kind: 'nymeria-console-entry', level: d.level, text: d.text, ts: d.ts })
          .catch(() => undefined)
      })
    },
  })
  markHookInstalled(tabId)
}

/**
 * Called by the SW message router when a content-script forwards a
 * console entry. Wired in background/index.ts onMessage handler.
 */
export function ingestConsoleEntry(
  tabId: number,
  payload: { level?: string; text?: string; ts?: number },
): void {
  const level = (payload.level as 'log' | 'warn' | 'error' | 'info' | 'debug' | 'exception') ?? 'log'
  push(tabId, { level, text: payload.text ?? '', ts: payload.ts ?? Date.now() })
}

export async function execConsole(args: unknown): Promise<CommandResult> {
  const a = args as ConsoleArgs
  if (typeof a.tab_id !== 'number') return { ok: false, status: 'error', error: 'tab_id required' }
  try {
    await ensureHook(a.tab_id)
  } catch (e) {
    return { ok: false, status: 'error', error: `failed to install console hook: ${String(e)}` }
  }
  const entries = read(a.tab_id, { only_errors: a.only_errors, limit: a.limit })
  if (a.clear) clearBuffer(a.tab_id)
  return { ok: true, status: 'success', data: { entries, count: entries.length } }
}
