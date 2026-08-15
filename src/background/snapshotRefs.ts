/**
 * Per-tab cache mapping snapshot refs (`@e5`) to CDP `backendNodeId`s.
 *
 * NUMBERING IS MONOTONIC PER TAB and never restarts inside a browser
 * session: the first read mints e1..eN, the next mints eN+1.., whatever
 * document the tab is on. That is the whole staleness mechanism (#160): the
 * extension cannot know which read an agent's "@e5" came from, so if
 * numbers were reused a held ref would silently resolve to a DIFFERENT
 * element, the wrong-click disaster class. With monotonic numbers a ref
 * from a dead read is structurally absent and refuses honestly. The
 * counter survives MV3 worker recycles via chrome.storage.session (in-memory
 * browser-side, cleared on browser restart, when tab ids change anyway), so
 * a recycle cannot resurrect collisions.
 *
 * MERGE SEMANTICS: a new read of the SAME document (URL compared without its
 * fragment) adds its refs to the map instead of replacing it, so every ref
 * minted since the last navigation stays valid, including across scoped
 * (`scope_ref`/`scope_selector`) re-reads, which used to discard the
 * full-page map wholesale. A different URL replaces outright.
 *
 * Refs are invalidated by navigation (committed top-frame navigation hooks
 * in background/index.ts), by their frame session detaching (an OOPIF that
 * navigated cross-process; also index.ts), by tab close, and by the
 * recorded URL no longer matching the tab's current URL, the backstop for
 * the cases the hooks miss.
 *
 * Callers never get a bare `null` back: `resolve` returns a typed reason so
 * the agent is told to re-read the page instead of being left to guess why a
 * ref stopped working. Acting on a stale ref must never silently mis-click.
 */

type Ref = string // "e1", "e2", ...

/**
 * Where a ref actually lives, plus what it MEANT when it was minted.
 *
 * `backendNodeId` is a PROCESS-global counter, not a page-global one, so the
 * same number identifies different elements in the main document and in a
 * cross-origin iframe. Storing the owning session alongside it is what stops
 * an iframe ref from silently resolving to an unrelated main-frame element.
 *
 * `role`/`name` are the accessibility pair the ref was minted from: the
 * fingerprint act re-checks before dispatching input, so a live node whose
 * MEANING changed since the read ("Confirm" relabeled "Delete", a re-render
 * reusing the DOM node) refuses instead of firing (#160 review round).
 */
export interface RefTarget {
  backendNodeId: number
  /** Undefined means the root page session. */
  sessionId?: string
  /** AX role at mint time ("button"). Empty/absent skips the role compare. */
  role?: string
  /** Normalized AX name at mint time. Empty/absent skips the name compare. */
  name?: string
}

interface TabRefs {
  byRef: Map<Ref, RefTarget>
  urlAtSnapshot: string | null
}

export type StaleReason = 'no-snapshot' | 'unknown-ref' | 'navigated' | 'stale-read'

export type RefResolution =
  | { ok: true; backendNodeId: number; sessionId?: string; role?: string; name?: string }
  | { ok: false; reason: StaleReason; detail: string }

const cache = new Map<number, TabRefs>()

/**
 * Next-ref counters, per tab. The in-memory map is the working copy; every
 * update is mirrored fire-and-forget into chrome.storage.session so a worker
 * recycle resumes numbering instead of restarting at e1 (which would hand a
 * recycled session the collision class back, with refs now TRUSTED).
 */
const counters = new Map<number, number>()
const hydrated = new Set<number>()

function counterKey(tabId: number): string {
  return `nymRefCounter:${tabId}`
}

/**
 * The tab's next mint floor. Async because the first call after a worker
 * recycle reads storage.session; later calls answer from memory.
 */
export async function nextCounter(tabId: number): Promise<number> {
  const inMemory = counters.get(tabId)
  if (inMemory !== undefined) return inMemory
  if (!hydrated.has(tabId)) {
    hydrated.add(tabId)
    try {
      const got = await chrome.storage.session.get(counterKey(tabId))
      const stored = got?.[counterKey(tabId)]
      if (typeof stored === 'number' && !counters.has(tabId)) {
        counters.set(tabId, stored)
        return stored
      }
    } catch {
      // No storage.session (very old Chrome): numbering still works within
      // one worker lifetime, which is the pre-#160 status quo.
    }
  }
  return counters.get(tabId) ?? 0
}

/**
 * Per-tab mint serialization. Two concurrent reads of one tab (parallel tool
 * calls in one turn) would otherwise both start from the same counter and
 * mint colliding numbers, which is the exact class monotonic numbering
 * exists to remove.
 */
const mintLocks = new Map<number, Promise<unknown>>()

export async function withMintLock<T>(tabId: number, fn: () => Promise<T>): Promise<T> {
  const prev = mintLocks.get(tabId) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  mintLocks.set(
    tabId,
    run.then(
      () => undefined,
      () => undefined,
    ),
  )
  return run
}

/** URL comparison for ref validity ignores the fragment: an in-page anchor
 *  click changes no document and must not bounce every held ref. Path and
 *  query changes (pushState included) still count as moving. */
function sameDocumentUrl(a: string | null, b: string | null): boolean {
  if (!a || !b) return false
  if (a === b) return true
  const strip = (u: string): string => {
    const hash = u.indexOf('#')
    return hash === -1 ? u : u.slice(0, hash)
  }
  return strip(a) === strip(b)
}

/**
 * Record a read's refs and advance the tab's counter.
 *
 * Same document (fragment-insensitive): MERGE, so refs the caller is still
 * holding from earlier reads survive. Different document: replace. The
 * recorded URL always updates to the latest read's.
 */
export function set(
  tabId: number,
  refs: Map<Ref, RefTarget>,
  url: string | null = null,
  nextCounterValue?: number,
): void {
  const existing = cache.get(tabId)
  const merge = existing !== undefined && sameDocumentUrl(existing.urlAtSnapshot, url)
  const byRef = merge ? new Map([...existing.byRef, ...refs]) : new Map(refs)
  cache.set(tabId, { byRef, urlAtSnapshot: url })
  if (typeof nextCounterValue === 'number') {
    counters.set(tabId, nextCounterValue)
    try {
      void chrome.storage.session.set({ [counterKey(tabId)]: nextCounterValue })
    } catch {
      // Best-effort mirror; memory stays authoritative for this worker.
    }
  }
}

/**
 * Resolve a `@eN` ref for a tab.
 *
 * `currentUrl` is compared (fragment-insensitively) against the URL the
 * snapshot was taken from when both are known; a mismatch is reported as
 * `navigated` rather than resolving a backendNodeId that now points into a
 * different document. An absent key splits honestly on the counter: a
 * number this tab has minted refuses as a stale read, a number it never
 * minted refuses as unknown.
 */
export function resolve(tabId: number, target: string, currentUrl?: string | null): RefResolution {
  const ref = target.startsWith('@') ? target.slice(1) : target
  const entry = cache.get(tabId)
  if (!entry) {
    return {
      ok: false,
      reason: 'no-snapshot',
      detail: `no snapshot cached for tab ${tabId} (read the page first)`,
    }
  }
  if (currentUrl && entry.urlAtSnapshot && !sameDocumentUrl(entry.urlAtSnapshot, currentUrl)) {
    return {
      ok: false,
      reason: 'navigated',
      detail: `page moved from ${entry.urlAtSnapshot} to ${currentUrl} since the snapshot (re-read the page)`,
    }
  }
  const refTarget = entry.byRef.get(ref)
  if (refTarget == null) {
    const num = /^e(\d+)$/.exec(ref)
    const minted = num !== null && Number(num[1]) >= 1 && Number(num[1]) <= (counters.get(tabId) ?? 0)
    if (minted) {
      return {
        ok: false,
        reason: 'stale-read',
        detail:
          `ref @${ref} is from before the last navigation (or from a frame that has ` +
          'since gone away); its element no longer exists here. Re-read the page and ' +
          'use a fresh ref',
      }
    }
    return {
      ok: false,
      reason: 'unknown-ref',
      detail: `unknown ref @${ref}: this tab has never minted it (re-read the page to see current refs)`,
    }
  }
  return {
    ok: true,
    backendNodeId: refTarget.backendNodeId,
    sessionId: refTarget.sessionId,
    role: refTarget.role,
    name: refTarget.name,
  }
}

/** Invalidate the map (navigation). The COUNTER deliberately survives: it is
 *  what keeps a post-navigation read from re-minting held numbers. */
export function clear(tabId: number): void {
  cache.delete(tabId)
}

/** Drop refs belonging to one frame session (its target detached: the OOPIF
 *  navigated cross-process or was removed). Top-frame refs stay valid. */
export function clearSession(tabId: number, sessionId: string): void {
  const entry = cache.get(tabId)
  if (!entry) return
  for (const [ref, target] of Array.from(entry.byRef)) {
    if (target.sessionId === sessionId) entry.byRef.delete(ref)
  }
}

/** Tab closed: everything goes, counter included (tab ids are not reused
 *  within a browser session in a way a held ref could survive). */
export function dropTab(tabId: number): void {
  cache.delete(tabId)
  counters.delete(tabId)
  hydrated.delete(tabId)
  mintLocks.delete(tabId)
  try {
    void chrome.storage.session.remove(counterKey(tabId))
  } catch {
    // Best-effort.
  }
}

export function clearAll(): void {
  cache.clear()
}

export function size(tabId: number): number {
  return cache.get(tabId)?.byRef.size ?? 0
}

export function snapshotUrl(tabId: number): string | null {
  return cache.get(tabId)?.urlAtSnapshot ?? null
}

export function resetForTests(): void {
  cache.clear()
  counters.clear()
  hydrated.clear()
  mintLocks.clear()
}
