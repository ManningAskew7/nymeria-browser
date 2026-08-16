/**
 * Per-tab ring buffer of console messages + uncaught exceptions.
 *
 * Fed by CDP (`Runtime.consoleAPICalled` / `Runtime.exceptionThrown`, plus
 * `Log.entryAdded` for the browser's own advisories, #177), which rides
 * `chrome.debugger` and so needs NO host permission: it works on any
 * origin the agent can reach. An earlier page-injected wrapper was removed
 * because it needed one and failed on every ungranted origin. Events from
 * cross-origin frame sessions land here too, frame-attributed; one buffer
 * per tab, shared across its frames.
 *
 * The buffer is what makes a silently failed action visible: a click that
 * "succeeded" while its fetch threw is otherwise indistinguishable from one
 * that worked.
 */

import { frameOriginForSession, onCdpEvent } from './debuggerSession'

export interface ConsoleEntry {
  level: 'log' | 'warn' | 'error' | 'info' | 'debug' | 'exception'
  text: string
  ts: number
  // Source location, when available.
  source?: string
  line?: number
  col?: number
  /**
   * Origin of the cross-origin frame this entry came from (#177). Absent
   * for the top document, so root entries keep their pre-#177 shape.
   */
  frame?: string
  /**
   * True for browser-generated advisories (CDP Log domain): policy
   * refusals like X-Frame-Options, CSP, mixed content, CORS. These are
   * Chrome talking, not the page, and they name causes no page-side
   * capture can see.
   */
  browser?: boolean
}

const MAX_PER_TAB = 200

const buffers = new Map<number, ConsoleEntry[]>()

export function push(tabId: number, entry: ConsoleEntry): void {
  const buf = buffers.get(tabId) ?? []
  buf.push(entry)
  if (buf.length > MAX_PER_TAB) buf.splice(0, buf.length - MAX_PER_TAB)
  buffers.set(tabId, buf)
}

/**
 * Push unless an identical entry is already buffered.
 *
 * Runtime and Log REPLAY their backlog on every enable, and the attach is
 * per-command-burst (10s linger), so each re-attach re-delivers entries the
 * buffer already holds; measured live 2026-08-16 as duplicate advisories at
 * identical timestamps. A replayed entry is byte-identical including its
 * CDP timestamp, so an exact-tuple match is the discriminator. The
 * collateral: a page emitting the same text twice within the same rounded
 * millisecond collapses to one entry, an acceptable trade for a diagnosis
 * window. Capture handlers use this; direct `push` stays exact.
 */
function pushCaptured(tabId: number, entry: ConsoleEntry): void {
  const buf = buffers.get(tabId)
  if (
    buf?.some(
      (e) =>
        e.ts === entry.ts &&
        e.text === entry.text &&
        e.level === entry.level &&
        e.frame === entry.frame &&
        e.browser === entry.browser &&
        e.source === entry.source &&
        e.line === entry.line &&
        e.col === entry.col,
    )
  ) {
    return
  }
  push(tabId, entry)
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

/** Log domain levels -> our levels. The Log domain has only these four. */
const LOG_DOMAIN_LEVELS: Record<string, ConsoleEntry['level']> = {
  verbose: 'debug',
  info: 'info',
  warning: 'warn',
  error: 'error',
}

/**
 * Frame attribution for an entry (#177): events from a flattened frame
 * session carry that session's id, resolved to the frame's origin while
 * the session is still live. Returns a spreadable fragment so root
 * entries (no sessionId) gain no key at all.
 */
function frameOf(tabId: number, sessionId: string | undefined): { frame?: string } {
  return sessionId ? { frame: frameOriginForSession(tabId, sessionId) } : {}
}

let cdpCaptureInstalled = false

/** Route CDP console/exception/advisory events into the buffer. Idempotent. */
export function installCdpConsoleCapture(): () => void {
  if (cdpCaptureInstalled) return () => undefined
  cdpCaptureInstalled = true
  const unsubscribe = onCdpEvent((tabId, method, params, sessionId) => {
    if (method === 'Runtime.consoleAPICalled') {
      const p = params as { type?: string; args?: RemoteObject[]; timestamp?: number }
      const level = CDP_LEVELS[p.type ?? 'log'] ?? 'log'
      const text = (p.args ?? []).map(remoteObjectToText).join(' ')
      pushCaptured(tabId, { level, text, ts: cdpTimestamp(p.timestamp), ...frameOf(tabId, sessionId) })
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
      pushCaptured(tabId, {
        level: 'exception',
        text,
        ts: cdpTimestamp(p.timestamp),
        source: d.url,
        line: d.lineNumber,
        col: d.columnNumber,
        ...frameOf(tabId, sessionId),
      })
      return
    }
    if (method === 'Log.entryAdded') {
      // Browser-generated advisories (#177). The refusal an agent needs
      // ("Refused to display ... X-Frame-Options") is error-level, so the
      // default only_errors read surfaces it; lower levels are kept but
      // filtered like page console noise.
      const p = params as {
        entry?: {
          level?: string
          text?: string
          timestamp?: number
          url?: string
          lineNumber?: number
        }
      }
      const e = p.entry ?? {}
      pushCaptured(tabId, {
        level: LOG_DOMAIN_LEVELS[e.level ?? 'info'] ?? 'info',
        text: e.text ?? '',
        ts: cdpTimestamp(e.timestamp),
        browser: true,
        ...(e.url ? { source: e.url } : {}),
        ...(typeof e.lineNumber === 'number' ? { line: e.lineNumber } : {}),
        ...frameOf(tabId, sessionId),
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
