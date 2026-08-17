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
 *
 * It is not CONTINUOUS, though, and the reader owns saying so: the session
 * is released after an idle linger (DETACH_LINGER_MS), so anything the page
 * does between commands is never seen. `network.ts` asks the session layer
 * (`isAttached` plus `everAttached`) to tell a never-watched tab from a
 * lapsed one and flags both, because an unqualified empty answer reads as a
 * claim about the page.
 *
 * Requests from cross-origin frame sessions land here too (#177),
 * frame-attributed; one buffer per tab, shared across its frames, so a
 * noisy frame can evict root entries (a diagnosis window, not a recorder).
 */

import { frameOriginForSession, onCdpEvent } from './debuggerSession'

export interface NetworkEntry {
  url: string
  method: string
  status?: number
  mime_type?: string
  /** Set when the request failed outright (DNS, abort, blocked). */
  error?: string
  resource_type?: string
  ts: number
  /**
   * Origin of the cross-origin frame that made the request (#177). Absent
   * for the top document, so root entries keep their pre-#177 shape.
   */
  frame?: string
}

const MAX_PER_TAB = 200

const buffers = new Map<number, NetworkEntry[]>()
/**
 * Correlation key -> entry, so a response can find the request that opened
 * it. Keys are `<sessionId or root>:<requestId>` (#177): requestIds are
 * only unique WITHIN a CDP session, so two frames (or a frame and the root)
 * can reuse the same id and must not cross-contaminate.
 */
const pending = new Map<number, Map<string, NetworkEntry>>()

function correlationKey(sessionId: string | undefined, requestId: string): string {
  return `${sessionId ?? 'root'}:${requestId}`
}

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
  /** Newest N entries. OMIT for everything buffered; 0 returns none. */
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
  // `limit: 0` means ZERO. It used to fall through a `> 0` guard and return
  // the WHOLE buffer, so the one spelling that unambiguously asks for nothing
  // returned the most this can give (up to MAX_PER_TAB). Unlimited is spelled
  // by omitting the option.
  if (typeof opts.limit === 'number') {
    const limit = Math.max(0, Math.trunc(opts.limit))
    if (out.length > limit) out = out.slice(out.length - limit)
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
  const unsubscribe = onCdpEvent((tabId, method, params, sessionId) => {
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
        ...(sessionId ? { frame: frameOriginForSession(tabId, sessionId) } : {}),
      }
      pendingFor(tabId).set(correlationKey(sessionId, p.requestId), entry)
      push(tabId, entry)
      return
    }
    if (method === 'Network.responseReceived') {
      const p = params as {
        requestId?: string
        response?: { status?: number; mimeType?: string }
      }
      if (!p.requestId) return
      const entry = pendingFor(tabId).get(correlationKey(sessionId, p.requestId))
      if (!entry) return
      // Mutating the entry already in the buffer keeps request order intact.
      entry.status = p.response?.status
      entry.mime_type = p.response?.mimeType
      return
    }
    if (method === 'Network.loadingFailed') {
      const p = params as { requestId?: string; errorText?: string; canceled?: boolean }
      if (!p.requestId) return
      const key = correlationKey(sessionId, p.requestId)
      const entry = pendingFor(tabId).get(key)
      if (!entry) return
      entry.error = p.canceled ? 'canceled' : (p.errorText ?? 'failed')
      pendingFor(tabId).delete(key)
      return
    }
    if (method === 'Network.loadingFinished') {
      const p = params as { requestId?: string }
      if (p.requestId) pendingFor(tabId).delete(correlationKey(sessionId, p.requestId))
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
