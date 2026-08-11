/**
 * Per-tab ring buffer of network requests, fed by CDP Network events.
 *
 * This is the other half of "did that action actually work". The console
 * catches thrown errors; this catches the request that came back 500 without
 * throwing anything, which is the more common silent failure on a real site.
 *
 * Capture starts when the debugger attaches, not when the tool is first
 * called. Anthropic's Claude-in-Chrome starts on first call, which means the
 * first question you ask about the network is always answered "nothing yet"
 * and you have to reload to see anything. Enabling at attach costs one CDP
 * call per tab and removes that whole class of confusion.
 */

import { onCdpEvent } from './debuggerSession'

export interface NetworkEntry {
  url: string
  method: string
  status?: number
  mime_type?: string
  /** Set when the request failed outright (DNS, abort, blocked). */
  error?: string
  resource_type?: string
  ts: number
}

const MAX_PER_TAB = 200

const buffers = new Map<number, NetworkEntry[]>()
/** requestId -> entry, so a response can find the request that opened it. */
const pending = new Map<number, Map<string, NetworkEntry>>()

function bufferFor(tabId: number): NetworkEntry[] {
  const buf = buffers.get(tabId) ?? []
  buffers.set(tabId, buf)
  return buf
}

function pendingFor(tabId: number): Map<string, NetworkEntry> {
  const map = pending.get(tabId) ?? new Map<string, NetworkEntry>()
  pending.set(tabId, map)
  return map
}

export function push(tabId: number, entry: NetworkEntry): void {
  const buf = bufferFor(tabId)
  buf.push(entry)
  if (buf.length > MAX_PER_TAB) buf.splice(0, buf.length - MAX_PER_TAB)
}

export interface ReadOptions {
  url_pattern?: string
  only_failures?: boolean
  limit?: number
  since?: number
}

export function read(tabId: number, opts: ReadOptions = {}): NetworkEntry[] {
  let out = (buffers.get(tabId) ?? []).slice()
  if (opts.since != null) out = out.filter((e) => e.ts >= (opts.since as number))
  if (opts.url_pattern) {
    const needle = opts.url_pattern
    out = out.filter((e) => e.url.includes(needle))
  }
  if (opts.only_failures) {
    out = out.filter((e) => Boolean(e.error) || (typeof e.status === 'number' && e.status >= 400))
  }
  if (typeof opts.limit === 'number' && opts.limit > 0 && out.length > opts.limit) {
    out = out.slice(out.length - opts.limit)
  }
  return out
}

/** Failures only: what the post-action verification payload reports. */
export function failuresSince(tabId: number, since: number, limit = 5): NetworkEntry[] {
  return read(tabId, { since, only_failures: true, limit })
}

export function clear(tabId: number): void {
  buffers.delete(tabId)
  pending.delete(tabId)
}

let captureInstalled = false

export function installCdpNetworkCapture(): () => void {
  if (captureInstalled) return () => undefined
  captureInstalled = true
  const unsubscribe = onCdpEvent((tabId, method, params) => {
    if (method === 'Network.requestWillBeSent') {
      const p = params as {
        requestId?: string
        request?: { url?: string; method?: string }
        type?: string
      }
      if (!p.requestId || !p.request?.url) return
      const entry: NetworkEntry = {
        url: p.request.url,
        method: p.request.method ?? 'GET',
        resource_type: p.type,
        ts: Date.now(),
      }
      pendingFor(tabId).set(p.requestId, entry)
      push(tabId, entry)
      return
    }
    if (method === 'Network.responseReceived') {
      const p = params as {
        requestId?: string
        response?: { status?: number; mimeType?: string }
      }
      if (!p.requestId) return
      const entry = pendingFor(tabId).get(p.requestId)
      if (!entry) return
      // Mutating the entry already in the buffer keeps request order intact.
      entry.status = p.response?.status
      entry.mime_type = p.response?.mimeType
      return
    }
    if (method === 'Network.loadingFailed') {
      const p = params as { requestId?: string; errorText?: string; canceled?: boolean }
      if (!p.requestId) return
      const entry = pendingFor(tabId).get(p.requestId)
      if (!entry) return
      entry.error = p.canceled ? 'canceled' : (p.errorText ?? 'failed')
      pendingFor(tabId).delete(p.requestId)
      return
    }
    if (method === 'Network.loadingFinished') {
      const p = params as { requestId?: string }
      if (p.requestId) pendingFor(tabId).delete(p.requestId)
    }
  })
  return () => {
    unsubscribe()
    captureInstalled = false
  }
}

export function resetForTests(): void {
  buffers.clear()
  pending.clear()
  captureInstalled = false
}
