/**
 * Per-tab ring buffer of console messages + uncaught exceptions.
 *
 * Fed by CDP (`Runtime.consoleAPICalled` / `Runtime.exceptionThrown`), which
 * rides `chrome.debugger` and so needs NO host permission: it works on any
 * origin the agent can reach. An earlier page-injected wrapper was removed
 * because it needed one and failed on every ungranted origin.
 *
 * The buffer is what makes a silently failed action visible: a click that
 * "succeeded" while its fetch threw is otherwise indistinguishable from one
 * that worked.
 */

import { onCdpEvent } from './debuggerSession'

export interface ConsoleEntry {
  level: 'log' | 'warn' | 'error' | 'info' | 'debug' | 'exception'
  text: string
  ts: number
  // Source location, when available.
  source?: string
  line?: number
  col?: number
}

const MAX_PER_TAB = 200

const buffers = new Map<number, ConsoleEntry[]>()

export function push(tabId: number, entry: ConsoleEntry): void {
  const buf = buffers.get(tabId) ?? []
  buf.push(entry)
  if (buf.length > MAX_PER_TAB) buf.splice(0, buf.length - MAX_PER_TAB)
  buffers.set(tabId, buf)
}

export function read(tabId: number, opts: { only_errors?: boolean; limit?: number }): ConsoleEntry[] {
  const buf = buffers.get(tabId) ?? []
  let out = buf
  if (opts.only_errors) {
    out = out.filter((e) => e.level === 'error' || e.level === 'exception')
  }
  if (typeof opts.limit === 'number' && opts.limit > 0 && out.length > opts.limit) {
    out = out.slice(out.length - opts.limit)
  }
  return out.slice()
}

/**
 * Entries recorded at or after `sinceTs`. This is what the post-action
 * verification payload reports, so an action can say "your click threw"
 * rather than leaving the agent to poll the console separately.
 */
export function readSince(
  tabId: number,
  sinceTs: number,
  opts: { only_errors?: boolean; limit?: number } = {},
): ConsoleEntry[] {
  const out = read(tabId, { only_errors: opts.only_errors }).filter((e) => e.ts >= sinceTs)
  if (typeof opts.limit === 'number' && opts.limit > 0 && out.length > opts.limit) {
    return out.slice(out.length - opts.limit)
  }
  return out
}

export function clear(tabId: number): void {
  buffers.delete(tabId)
}

const CDP_LEVELS: Record<string, ConsoleEntry['level']> = {
  log: 'log',
  warning: 'warn',
  warn: 'warn',
  error: 'error',
  info: 'info',
  debug: 'debug',
  assert: 'error',
}

interface RemoteObject {
  type?: string
  subtype?: string
  value?: unknown
  description?: string
  unserializableValue?: string
}

function remoteObjectToText(arg: RemoteObject): string {
  if (arg == null) return ''
  if (arg.value !== undefined) {
    return typeof arg.value === 'string' ? arg.value : JSON.stringify(arg.value)
  }
  if (arg.unserializableValue) return arg.unserializableValue
  if (arg.description) return arg.description
  return arg.type ?? ''
}

/**
 * CDP timestamps are milliseconds since epoch as a float. Fall back to the
 * receive time when a producer omits it, so ordering against `readSince`
 * stays sane.
 */
function cdpTimestamp(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? Math.round(raw) : Date.now()
}

let cdpCaptureInstalled = false

/** Route CDP console/exception events into the buffer. Idempotent. */
export function installCdpConsoleCapture(): () => void {
  if (cdpCaptureInstalled) return () => undefined
  cdpCaptureInstalled = true
  const unsubscribe = onCdpEvent((tabId, method, params) => {
    if (method === 'Runtime.consoleAPICalled') {
      const p = params as { type?: string; args?: RemoteObject[]; timestamp?: number }
      const level = CDP_LEVELS[p.type ?? 'log'] ?? 'log'
      const text = (p.args ?? []).map(remoteObjectToText).join(' ')
      push(tabId, { level, text, ts: cdpTimestamp(p.timestamp) })
      return
    }
    if (method === 'Runtime.exceptionThrown') {
      const p = params as {
        timestamp?: number
        exceptionDetails?: {
          text?: string
          url?: string
          lineNumber?: number
          columnNumber?: number
          exception?: RemoteObject
        }
      }
      const d = p.exceptionDetails ?? {}
      const described = d.exception ? remoteObjectToText(d.exception) : ''
      const text = [d.text, described].filter(Boolean).join(': ') || 'uncaught exception'
      push(tabId, {
        level: 'exception',
        text,
        ts: cdpTimestamp(p.timestamp),
        source: d.url,
        line: d.lineNumber,
        col: d.columnNumber,
      })
    }
  })
  return () => {
    unsubscribe()
    cdpCaptureInstalled = false
  }
}

export function resetForTests(): void {
  buffers.clear()
  cdpCaptureInstalled = false
}
