/**
 * Per-tab ring buffer of console messages + uncaught exceptions.
 *
 * Populated by a small content script we inject on demand which wraps
 * `console.*` and `window.onerror` and posts entries back via
 * `chrome.runtime.sendMessage`. Background SW receives them through the
 * standard onMessage router (see background/index.ts).
 */

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
const hookInstalled = new Set<number>()

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

export function clear(tabId: number): void {
  buffers.delete(tabId)
}

export function isHookInstalled(tabId: number): boolean {
  return hookInstalled.has(tabId)
}

export function markHookInstalled(tabId: number): void {
  hookInstalled.add(tabId)
}

export function forgetHook(tabId: number): void {
  hookInstalled.delete(tabId)
}

export function resetForTests(): void {
  buffers.clear()
  hookInstalled.clear()
}
