import { backgroundLogger as logger } from '../utils/logger'

/**
 * Ref-counted Chrome DevTools Protocol sessions per tab.
 *
 * Attach is expensive (shows the yellow "is being debugged" banner) and
 * pages glitch when re-attached. Multiple in-flight commands on the same
 * tab share one attach. We detach 10s after the last release so a rapid
 * back-to-back sequence of `chrome_*` commands doesn't flicker the banner.
 */

const DEBUGGER_VERSION = '1.3'
const DETACH_LINGER_MS = 10_000

interface Session {
  refCount: number
  detachTimer: ReturnType<typeof setTimeout> | null
  attached: boolean
}

const sessions = new Map<number, Session>()
const tabsRequiringDomain = new WeakMap<object, Set<string>>()

function getOrCreate(tabId: number): Session {
  let s = sessions.get(tabId)
  if (!s) {
    s = { refCount: 0, detachTimer: null, attached: false }
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
    logger.log(`debugger attached tab=${tabId}`)
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

export function activeTabs(): number[] {
  return Array.from(sessions.entries())
    .filter(([, s]) => s.attached)
    .map(([tabId]) => tabId)
}

export function isAttached(tabId: number): boolean {
  return sessions.get(tabId)?.attached === true
}

export function resetForTests(): void {
  for (const [, s] of sessions) {
    if (s.detachTimer) clearTimeout(s.detachTimer)
  }
  sessions.clear()
}

// Mark a domain as enabled (Accessibility, Runtime, Page, ...) so we
// don't send `*.enable` repeatedly for the same session.
export function markDomainEnabled(tabId: number, domain: string): boolean {
  const s = sessions.get(tabId)
  if (!s) return false
  const key = { id: tabId } as object
  let set = tabsRequiringDomain.get(key)
  if (!set) {
    set = new Set()
    tabsRequiringDomain.set(key, set)
  }
  if (set.has(domain)) return false
  set.add(domain)
  return true
}
