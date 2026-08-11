import { backgroundLogger as logger } from '../utils/logger'

/**
 * Ref-counted Chrome DevTools Protocol sessions per tab.
 *
 * Attach is expensive (shows the yellow "is being debugged" banner) and
 * pages glitch when re-attached. Multiple in-flight commands on the same
 * tab share one attach. We detach 10s after the last release so a rapid
 * back-to-back sequence of `chrome_*` commands doesn't flicker the banner.
 *
 * Two things ride on the attach beyond one-shot commands:
 *
 *  - Enabled CDP domains, tracked per session. `Runtime.enable` and friends
 *    are sent once per attach and forgotten when the attach ends, so a
 *    re-attach re-enables rather than assuming stale state.
 *  - CDP events. `chrome.debugger.onEvent` is a single global stream for
 *    every attached tab, so it is routed here once and fanned out to
 *    subscribers. This is how console and network capture work WITHOUT host
 *    permissions: `chrome.debugger` needs none, while `chrome.scripting`
 *    injection does.
 */

const DEBUGGER_VERSION = '1.3'
const DETACH_LINGER_MS = 10_000

interface Session {
  refCount: number
  detachTimer: ReturnType<typeof setTimeout> | null
  attached: boolean
  domains: Set<string>
}

const sessions = new Map<number, Session>()

export type CdpEventHandler = (tabId: number, method: string, params: unknown) => void

const eventHandlers = new Set<CdpEventHandler>()

/**
 * Subscribe to CDP events for every attached tab. Returns an unsubscribe fn.
 * Handlers must not throw; a throwing handler is logged and skipped so one
 * bad subscriber cannot starve the others.
 */
export function onCdpEvent(handler: CdpEventHandler): () => void {
  eventHandlers.add(handler)
  return () => eventHandlers.delete(handler)
}

function routeCdpEvent(source: { tabId?: number }, method: string, params: unknown): void {
  const tabId = source.tabId
  if (typeof tabId !== 'number') return
  for (const handler of eventHandlers) {
    try {
      handler(tabId, method, params)
    } catch (e) {
      logger.warn(`CDP event handler failed for ${method}:`, e)
    }
  }
}

/**
 * Registered at module load: MV3 wants listeners bound synchronously at the
 * service-worker top level. Exported so tests can re-bind after swapping in a
 * fresh `chrome` mock.
 */
export function installCdpEventRouter(): void {
  chrome.debugger.onEvent.addListener(routeCdpEvent)
}

installCdpEventRouter()

// Chrome detaches us unilaterally when DevTools opens on the tab, when the
// tab navigates to a protected page, or when the target goes away. Without
// this the session would stay marked attached and every later sendCommand
// would fail with "Debugger is not attached".
chrome.debugger.onDetach?.addListener?.((source) => {
  const tabId = source.tabId
  if (typeof tabId !== 'number') return
  const s = sessions.get(tabId)
  if (!s) return
  if (s.detachTimer) clearTimeout(s.detachTimer)
  logger.log(`debugger detached externally tab=${tabId}`)
  sessions.delete(tabId)
})

function getOrCreate(tabId: number): Session {
  let s = sessions.get(tabId)
  if (!s) {
    s = { refCount: 0, detachTimer: null, attached: false, domains: new Set() }
    sessions.set(tabId, s)
  }
  return s
}

export async function acquire(tabId: number): Promise<void> {
  const s = getOrCreate(tabId)
  if (s.detachTimer) {
    clearTimeout(s.detachTimer)
    s.detachTimer = null
  }
  s.refCount += 1
  if (!s.attached) {
    await chrome.debugger.attach({ tabId }, DEBUGGER_VERSION)
    s.attached = true
    s.domains.clear()
    logger.log(`debugger attached tab=${tabId}`)
    // Runtime carries console messages and uncaught exceptions, which the
    // post-action verification payload reports. Enable it eagerly and
    // best-effort so capture is running before the first action, and send it
    // raw rather than through sendCommand to avoid re-entering the refcount.
    void Promise.resolve(chrome.debugger.sendCommand({ tabId }, 'Runtime.enable', {}))
      .then(() => {
        sessions.get(tabId)?.domains.add('Runtime')
      })
      .catch((e: unknown) => logger.warn(`Runtime.enable failed tab=${tabId}:`, e))
  }
}

export function release(tabId: number): void {
  const s = sessions.get(tabId)
  if (!s) return
  s.refCount = Math.max(0, s.refCount - 1)
  if (s.refCount === 0 && s.attached) {
    if (s.detachTimer) clearTimeout(s.detachTimer)
    s.detachTimer = setTimeout(() => {
      void detachNow(tabId)
    }, DETACH_LINGER_MS)
  }
}

async function detachNow(tabId: number): Promise<void> {
  const s = sessions.get(tabId)
  if (!s) return
  if (s.refCount > 0) {
    // Someone re-acquired during the linger window.
    s.detachTimer = null
    return
  }
  try {
    await chrome.debugger.detach({ tabId })
    logger.log(`debugger detached tab=${tabId}`)
  } catch (e) {
    logger.warn(`debugger detach failed tab=${tabId}:`, e)
  }
  sessions.delete(tabId)
}

export async function sendCommand<T = unknown>(
  tabId: number,
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  await acquire(tabId)
  try {
    const result = await chrome.debugger.sendCommand({ tabId }, method, params)
    return result as T
  } finally {
    release(tabId)
  }
}

export async function withSession<T>(tabId: number, fn: () => Promise<T>): Promise<T> {
  await acquire(tabId)
  try {
    return await fn()
  } finally {
    release(tabId)
  }
}

/**
 * Send `<domain>.enable` once per attach.
 *
 * Must be called inside an `acquire`d session (`withSession` or another
 * `sendCommand`), because the enable is only remembered for as long as the
 * current attach lives.
 */
export async function ensureDomain(tabId: number, domain: string): Promise<void> {
  const s = sessions.get(tabId)
  if (s?.domains.has(domain)) return
  await sendCommand(tabId, `${domain}.enable`, {})
  // Re-read: the session may have been recreated during the await.
  sessions.get(tabId)?.domains.add(domain)
}

export function activeTabs(): number[] {
  return Array.from(sessions.entries())
    .filter(([, s]) => s.attached)
    .map(([tabId]) => tabId)
}

export function isAttached(tabId: number): boolean {
  return sessions.get(tabId)?.attached === true
}

export function enabledDomains(tabId: number): string[] {
  return Array.from(sessions.get(tabId)?.domains ?? [])
}

export function resetForTests(): void {
  for (const [, s] of sessions) {
    if (s.detachTimer) clearTimeout(s.detachTimer)
  }
  sessions.clear()
  eventHandlers.clear()
}
