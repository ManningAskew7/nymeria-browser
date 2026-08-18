/**
 * Per-tab navigation lifecycle, observed from the browser process.
 *
 * `webNavigation` events come from the browser, not the renderer, so a page
 * cannot lie to them (the main-world probe problem tracked in backlog #160
 * does not apply here), and they need no CDP attach and no host permission.
 * The extension has always RECEIVED `onCommitted` and thrown it away after
 * clearing refs; this module is the half that remembers.
 *
 * Five event classes, because Chrome splits navigation three ways:
 * - `onBeforeNavigate` / `onCommitted` / `onErrorOccurred` cover CROSS-
 *   document navigations (start, arrival, death).
 * - `onReferenceFragmentUpdated` and `onHistoryStateUpdated` are the
 *   SAME-document navigations (fragment jump, pushState), which fire
 *   NEITHER of the first two. A consumer that only watched commits would
 *   read a hash-router navigation as "never started", a false failure
 *   (review finding F1 of the 2026-08-14 pass).
 *
 * Consumers wait on `waitForNavSignal`, which wakes on ANY of arrival,
 * same-document move, abort, or tab close, so an abort at t=3s is known at
 * t=3s rather than at a deadline (F2).
 *
 * State is in-memory and per-worker on purpose. Every consumer samples and
 * reads within one command's lifetime, and the worker cannot recycle while a
 * command is running; nothing here needs to survive a recycle.
 *
 * Top-frame only (`frameId !== 0` is ignored), matching the URL semantics of
 * every payload these fields sit in: an iframe navigating is not the tab
 * going somewhere.
 */

export interface CommitRecord {
  url: string
  seq: number
}

export interface NavErrorRecord {
  error: string | null
  at: number
}

export type NavSignal =
  | { kind: 'commit'; url: string; seq: number }
  | { kind: 'same-document'; url: string }
  | { kind: 'error'; error: string | null }
  | { kind: 'removed' }

interface TabNav {
  /** Count of top-frame commits observed for this tab, this worker life. */
  seq: number
  lastCommit: CommitRecord | null
  /** A navigation that has started (onBeforeNavigate) and not yet committed. */
  pending: { url: string; at: number } | null
  /** The last started navigation that died without committing. */
  lastError: NavErrorRecord | null
  /** The last same-document navigation (fragment / history API). */
  lastSameDoc: { url: string; at: number } | null
}

const tabs = new Map<number, TabNav>()
const waiters = new Map<number, Set<(s: NavSignal) => void>>()

function stateFor(tabId: number): TabNav {
  const existing = tabs.get(tabId)
  if (existing) return existing
  const fresh: TabNav = { seq: 0, lastCommit: null, pending: null, lastError: null, lastSameDoc: null }
  tabs.set(tabId, fresh)
  return fresh
}

function notify(tabId: number, signal: NavSignal): void {
  const set = waiters.get(tabId)
  if (!set) return
  waiters.delete(tabId)
  for (const w of set) w(signal)
}

interface NavDetails {
  tabId: number
  url: string
  frameId: number
  error?: string
}

function handleBeforeNavigate(details: NavDetails): void {
  if (details.frameId !== 0) return
  const s = stateFor(details.tabId)
  s.pending = { url: details.url, at: Date.now() }
}

function handleCommitted(details: NavDetails): void {
  if (details.frameId !== 0) return
  const s = stateFor(details.tabId)
  s.seq += 1
  s.lastCommit = { url: details.url, seq: s.seq }
  s.pending = null
  s.lastError = null
  notify(details.tabId, { kind: 'commit', url: details.url, seq: s.seq })
}

function handleSameDocument(details: NavDetails): void {
  if (details.frameId !== 0) return
  const s = stateFor(details.tabId)
  s.lastSameDoc = { url: details.url, at: Date.now() }
  notify(details.tabId, { kind: 'same-document', url: details.url })
}

function handleErrorOccurred(details: NavDetails): void {
  if (details.frameId !== 0) return
  const s = stateFor(details.tabId)
  s.pending = null
  s.lastError = { error: details.error ?? null, at: Date.now() }
  notify(details.tabId, { kind: 'error', error: details.error ?? null })
}

/**
 * Drop a closed tab's state, waking any waiter with `removed` FIRST so a
 * command mid-wait fails fast and honestly instead of riding its deadline.
 * Called from the one `chrome.tabs.onRemoved` listener in index.ts, where
 * every sibling module's per-tab teardown already lives.
 */
export function clearTabNav(tabId: number): void {
  notify(tabId, { kind: 'removed' })
  tabs.delete(tabId)
  waiters.delete(tabId)
}

let installed = false

/**
 * Register the listeners. Called once from the worker top level (index.ts),
 * like the console and network captures: MV3 requires top-level registration
 * so the events wake a recycled worker. Idempotent: a double install would
 * double-count every seq.
 */
export function installNavWatch(): void {
  if (installed) return
  installed = true
  chrome.webNavigation?.onBeforeNavigate?.addListener?.(handleBeforeNavigate)
  chrome.webNavigation?.onCommitted?.addListener?.(handleCommitted)
  chrome.webNavigation?.onReferenceFragmentUpdated?.addListener?.(handleSameDocument)
  chrome.webNavigation?.onHistoryStateUpdated?.addListener?.(handleSameDocument)
  chrome.webNavigation?.onErrorOccurred?.addListener?.(handleErrorOccurred)
}

/** Current commit counter for the tab; sample BEFORE acting, compare after. */
export function commitSeq(tabId: number): number {
  return tabs.get(tabId)?.seq ?? 0
}

/** The last commit newer than `sinceSeq`, or null. */
export function commitSince(tabId: number, sinceSeq: number): CommitRecord | null {
  const s = tabs.get(tabId)
  if (!s?.lastCommit) return null
  return s.lastCommit.seq > sinceSeq ? s.lastCommit : null
}

/**
 * A navigation that started at or after `sinceMs` and has not yet committed.
 * The time filter is the attribution: an unrelated navigation already in
 * flight when a command began must not be reported as that command's doing,
 * and a stale pending record must not outlive its relevance.
 */
export function navigationPending(tabId: number, sinceMs: number): { url: string } | null {
  const p = tabs.get(tabId)?.pending
  return p && p.at >= sinceMs ? { url: p.url } : null
}

/** A started navigation that died without committing at or after `sinceMs`. */
export function navigationError(tabId: number, sinceMs: number): NavErrorRecord | null {
  const e = tabs.get(tabId)?.lastError
  return e && e.at >= sinceMs ? e : null
}

/** The last same-document navigation at or after `sinceMs`, or null. */
export function sameDocumentSince(tabId: number, sinceMs: number): { url: string } | null {
  const d = tabs.get(tabId)?.lastSameDoc
  return d && d.at >= sinceMs ? { url: d.url } : null
}

/**
 * Ungated snapshots for the health read, which reports navigation state AS
 * state ("a navigation to X has been pending for 30s") rather than
 * attributing it to any command, so the `sinceMs` attribution filters above
 * deliberately do not apply.
 */
export function pendingNavigation(tabId: number): { url: string; at: number } | null {
  return tabs.get(tabId)?.pending ?? null
}

export function lastNavigationError(tabId: number): NavErrorRecord | null {
  return tabs.get(tabId)?.lastError ?? null
}

/**
 * Resolve with the next navigation signal, or null at the deadline.
 *
 * Pre-checks answer immediately when the signal already landed, so arming
 * after the trigger is safe as long as `sinceSeq`/`sinceMs` were sampled
 * before it. Priority when several already landed: a commit outranks a
 * same-document move outranks an error (a commit clears the error record,
 * so a stale error can never shadow an arrival).
 */
export function waitForNavSignal(
  tabId: number,
  sinceSeq: number,
  sinceMs: number,
  timeoutMs: number,
): Promise<NavSignal | null> {
  const commit = commitSince(tabId, sinceSeq)
  if (commit) return Promise.resolve({ kind: 'commit', url: commit.url, seq: commit.seq })
  const sameDoc = sameDocumentSince(tabId, sinceMs)
  if (sameDoc) return Promise.resolve({ kind: 'same-document', url: sameDoc.url })
  const err = navigationError(tabId, sinceMs)
  if (err) return Promise.resolve({ kind: 'error', error: err.error })
  if (timeoutMs <= 0) return Promise.resolve(null)
  return new Promise((resolve) => {
    let done = false
    const set = waiters.get(tabId) ?? new Set()
    waiters.set(tabId, set)
    const waiter = (s: NavSignal) => finish(s)
    const finish = (s: NavSignal | null) => {
      if (done) return
      done = true
      set.delete(waiter)
      if (set.size === 0 && waiters.get(tabId) === set) waiters.delete(tabId)
      clearTimeout(timer)
      resolve(s)
    }
    set.add(waiter)
    const timer = setTimeout(() => finish(null), timeoutMs)
  })
}

export function resetForTests(): void {
  tabs.clear()
  waiters.clear()
  installed = false
}
