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
 * MERGE SEMANTICS: a new read of the SAME document (urlMatch.sameDocumentUrl:
 * anchor fragments ignored, hash-ROUTE fragments count as moving) adds its
 * refs to the map instead of replacing it, so every ref minted since the
 * last navigation stays valid, including across scoped
 * (`scope_ref`/`scope_selector`) re-reads, which used to discard the
 * full-page map wholesale. A different URL replaces outright.
 *
 * Refs are invalidated by navigation (committed top-frame navigation hooks
 * in background/index.ts), by tab close, and by the recorded URL no longer
 * matching the tab's current URL, the backstop for the cases the hooks
 * miss. A frame SESSION detaching deliberately does NOT invalidate refs:
 * the debugger detaches from the whole tab after a 10s idle linger, taking
 * every frame session with it, and session-keyed frame refs therefore died
 * between one tool call and the agent's next thought (measured 2026-08-16
 * live QA: three consecutive stale reads to land one click). Frame refs
 * key on the frame's STABLE target id instead and are resolved to the live
 * session at act time; a frame that truly left the page simply never
 * re-announces, which the act layer reports honestly. Surviving the session
 * is not surviving the DOCUMENT: a frame that NAVIGATES keeps its target id,
 * and a cross-process swap gives the new document a fresh `backendNodeId`
 * counter that can collide with held numbers, so each frame ref also records
 * the frame URL it was minted under and the act layer refuses (`navigated`)
 * when the live frame's URL no longer names the same document. In-process
 * frame navigations need no URL check: the process counter is monotonic, so
 * a dead document's ids never resolve there. SAME-PROCESS frame refs
 * (reads-honesty pass) ride the identical contract: their token is the
 * frame's `Page.FrameId` (same token space), resolved at act time via
 * `locateFrame` to the shared session plus a per-frame isolated world, with
 * the same frame-gone and navigated refusals.
 *
 * Callers never get a bare `null` back: `resolve` returns a typed reason so
 * the agent is told to re-read the page instead of being left to guess why a
 * ref stopped working. Acting on a stale ref must never silently mis-click.
 *
 * THE MAP SURVIVES MV3 WORKER RECYCLES (#179), not just the counter. Chrome
 * idle-kills the worker ~30s after activity, which is exactly the pause an
 * agent takes to talk to the user, and refs dying there broke the documented
 * contract ("refs stay valid until the page navigates") in the commonest
 * flow. Every `RefTarget` is five durable JSON fields with no live handles
 * (sessions and objectIds are looked up at use time), so the whole per-tab
 * entry mirrors into chrome.storage.session beside the counter and hydrates
 * once per worker life (`refsReady`, awaited by the command dispatcher
 * before any executor runs). Writes are fire-and-forget with their own
 * `.catch`: storage bookkeeping must never sit in front of a command (the
 * v0.9.0 transport lesson), and a failed write only degrades that tab to
 * the pre-#179 behavior. Hydration never overwrites in-memory state, and a
 * `clear`/`dropTab` that lands while hydration is in flight tombstones the
 * tab so a navigated-away document's refs cannot be resurrected (the
 * resolve-time URL compare remains the second line of defense).
 */

import { backgroundLogger as logger } from '../utils/logger'
import { sameDocumentUrl } from './urlMatch'

type Ref = string // "e1", "e2", ...

/**
 * Normalize an AX name for fingerprint use: whitespace collapsed, bounded.
 * MINT and CHECK must both go through this (snapshot.ts's formatTree and
 * act.ts's drift check import it), or normalization drift alone would refuse
 * every fingerprinted verb.
 */
export function normalizeAxName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').slice(0, 200)
}

/**
 * The comparison key for a fingerprint name: digit runs collapsed to `#`, so
 * a label whose NUMBERS tick between mint and act ("Cart (3)" to "Cart (4)",
 * timers, prices, badge counts) still matches, while any TEXT change
 * ("Confirm" to "Delete", "Alice" to "Bob") still refuses. The placeholder
 * keeps "A1B" from colliding with "AB": digits are ignored, not deleted.
 */
export function fingerprintNameKey(name: string): string {
  return normalizeAxName(name).replace(/\d+/g, '#')
}

/**
 * Where a ref actually lives, plus what it MEANT when it was minted.
 *
 * `backendNodeId` is a PROCESS-global counter, not a page-global one, so the
 * same number identifies different elements in the main document and in a
 * cross-origin iframe. Storing the owning frame alongside it is what stops
 * an iframe ref from silently resolving to an unrelated main-frame element.
 *
 * The frame is identified by its TARGET id (== its `Page.FrameId`), never by
 * the debugger session id. Sessions are ephemeral: the tab detaches 10s
 * after its last command and every frame session dies with it, coming back
 * under NEW ids on the next attach, while the target id stays stable for the
 * frame element's lifetime. Session-keyed refs died whenever the agent
 * thought for longer than the linger between two commands, which live QA
 * measured as multiple forced re-reads per round (2026-08-16). The act layer
 * maps target id to the CURRENT session at use time
 * (`locateFrame`, either frame class); a frame that no longer exists maps
 * to nothing and refuses honestly there.
 *
 * `role`/`name` are the accessibility pair the ref was minted from: the
 * fingerprint act re-checks before dispatching input, so a live node whose
 * MEANING changed since the read ("Confirm" relabeled "Delete", a re-render
 * reusing the DOM node) refuses instead of firing (#160 review round).
 */
export interface RefTarget {
  backendNodeId: number
  /** Stable token of the owning frame; undefined means the root document.
   *  Target id and `Page.FrameId` are one token space, so this covers BOTH
   *  frame classes: the act layer's `locateFrame` maps it to a live session
   *  (OOPIF) or to the shared session plus per-frame world addressing
   *  (same-process) at use time, whichever the frame is today. */
  frameTargetId?: string
  /** URL of the owning frame's document at mint time. The act layer compares
   *  it (sameDocumentUrl) against the LIVE frame's URL: the target id
   *  survives the frame navigating, but the ref's backendNodeId belongs to
   *  the document it was minted in, and a cross-process swap can reuse the
   *  number for an unrelated element. */
  frameUrl?: string
  /** AX role at mint time ("button"). Empty string skips the role compare. */
  role: string
  /** Normalized AX name at mint time (normalizeAxName). Empty string skips
   *  the name compare. Required so no minting path can quietly opt a ref out
   *  of the drift check by omission. */
  name: string
}

interface TabRefs {
  byRef: Map<Ref, RefTarget>
  urlAtSnapshot: string | null
}

export type StaleReason = 'no-snapshot' | 'unknown-ref' | 'navigated' | 'stale-read' | 'frame-gone'

export type RefResolution =
  | {
      ok: true
      backendNodeId: number
      frameTargetId?: string
      frameUrl?: string
      role: string
      name: string
    }
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

const COUNTER_PREFIX = 'nymRefCounter:'
const REFS_PREFIX = 'nymRefs:'

function counterKey(tabId: number): string {
  return `${COUNTER_PREFIX}${tabId}`
}

function refsKey(tabId: number): string {
  return `${REFS_PREFIX}${tabId}`
}

/** Wire shape of a persisted per-tab entry (`nymRefs:<tabId>`). */
interface PersistedTabRefs {
  url: string | null
  refs: Record<string, RefTarget>
}

/**
 * Mirror a tab's map into storage.session. Fire-and-forget BY DESIGN: an
 * over-quota `set()` REJECTS (measured, the v0.9.0 transport incident), and
 * a rejection awaited anywhere near the command path would trade a working
 * command for bookkeeping. Failure cost is bounded and honest: that tab's
 * refs die with this worker, the pre-#179 status quo, and the log says so.
 */
function persistTab(tabId: number, entry: TabRefs): void {
  try {
    const payload: PersistedTabRefs = {
      url: entry.urlAtSnapshot,
      refs: Object.fromEntries(entry.byRef),
    }
    void chrome.storage.session.set({ [refsKey(tabId)]: payload }).catch((e) => {
      logger.warn(`ref map for tab ${tabId} not persisted (refs die with this worker):`, e)
    })
  } catch {
    // No storage.session (very old Chrome): refs live for this worker only.
  }
}

/** Best-effort storage removal; sync throw and async rejection both no-ops. */
function removeStored(keys: string[]): void {
  try {
    void chrome.storage.session.remove(keys).catch(() => {})
  } catch {
    // Best-effort.
  }
}

/**
 * One hydration per worker life. Restores every persisted counter and map
 * into module memory, skipping tabs that already have in-memory state (a
 * command that somehow minted first wins) and tabs tombstoned by a
 * `clear`/`dropTab` that fired while the storage read was in flight (their
 * documents are gone; resurrecting the map would hand back exactly the
 * wrong-element class monotonic numbering exists to prevent).
 *
 * Tombstones are FLAVORED because the two mutators disagree about the
 * counter. `clear` (navigation) keeps the counter, in memory and in
 * storage, so its tombstone blocks only the MAP: wake-BY-navigation is the
 * ordinary ordering (the commit event is what starts the worker, so the
 * clear routinely lands mid-hydration), and blocking the counter there
 * would answer the next resolve with "read the page first" on a tab that
 * was read, the exact copy lie this pass removes. `dropTab` (tab close)
 * blocks both. Total storage failure degrades to the pre-#179 status quo.
 */
let hydration: Promise<void> | null = null
let hydrationDone = false
const tombstones = new Map<number, 'map' | 'all'>()

export function refsReady(): Promise<void> {
  if (hydration === null) hydration = hydrate()
  return hydration
}

async function hydrate(): Promise<void> {
  try {
    const all = await chrome.storage.session.get(null)
    for (const [key, value] of Object.entries(all ?? {})) {
      if (key.startsWith(COUNTER_PREFIX)) {
        const tabId = Number(key.slice(COUNTER_PREFIX.length))
        if (!Number.isInteger(tabId) || tombstones.get(tabId) === 'all') continue
        if (typeof value === 'number' && !counters.has(tabId)) {
          counters.set(tabId, value)
          hydrated.add(tabId)
        }
      } else if (key.startsWith(REFS_PREFIX)) {
        const tabId = Number(key.slice(REFS_PREFIX.length))
        if (!Number.isInteger(tabId) || tombstones.has(tabId) || cache.has(tabId)) continue
        const entry = deserializeTabRefs(value)
        if (entry !== null) cache.set(tabId, entry)
      }
    }
  } catch {
    // No storage.session, or the read failed: refs from before the recycle
    // stay lost, which is the pre-#179 status quo.
  }
  hydrationDone = true
  tombstones.clear()
}

/**
 * Validate a stored entry field by field before trusting it. Storage is
 * extension-private, but a malformed entry (a schema change, a partial
 * write) must skip the WHOLE tab rather than seed a half-map that resolves
 * some refs and refuses others with a lying story.
 */
function deserializeTabRefs(value: unknown): TabRefs | null {
  if (typeof value !== 'object' || value === null) return null
  const { url, refs } = value as { url?: unknown; refs?: unknown }
  if (url !== null && typeof url !== 'string') return null
  if (typeof refs !== 'object' || refs === null || Array.isArray(refs)) return null
  const byRef = new Map<Ref, RefTarget>()
  for (const [ref, raw] of Object.entries(refs as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null) return null
    const t = raw as Partial<RefTarget>
    if (typeof t.backendNodeId !== 'number' || typeof t.role !== 'string' || typeof t.name !== 'string') return null
    if (t.frameTargetId !== undefined && typeof t.frameTargetId !== 'string') return null
    if (t.frameUrl !== undefined && typeof t.frameUrl !== 'string') return null
    byRef.set(ref, {
      backendNodeId: t.backendNodeId,
      frameTargetId: t.frameTargetId,
      frameUrl: t.frameUrl,
      role: t.role,
      name: t.name,
    })
  }
  return { byRef, urlAtSnapshot: url ?? null }
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

// URL comparison for ref validity is urlMatch.sameDocumentUrl: an in-page
// anchor click changes no document and must not bounce every held ref, but
// path, query, pushState, and hash-ROUTE changes all count as moving.

/**
 * Record a read's refs and advance the tab's counter.
 *
 * Same document (sameDocumentUrl): MERGE, so refs the caller is still
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
  const entry: TabRefs = { byRef, urlAtSnapshot: url }
  cache.set(tabId, entry)
  if (typeof nextCounterValue === 'number') {
    counters.set(tabId, nextCounterValue)
    try {
      // Deliberately a SEPARATE write from the map mirror below: quota is
      // per-area, but a write fails on the payload it carries, so the tiny
      // counter write can land where a big map write cannot. Bundled, the
      // counter would share the map's failure and numbering would restart
      // on the next recycle, the collision class.
      void chrome.storage.session.set({ [counterKey(tabId)]: nextCounterValue }).catch(() => {})
    } catch {
      // Best-effort mirror; memory stays authoritative for this worker.
    }
  }
  persistTab(tabId, entry)
}

/**
 * Resolve a `@eN` ref for a tab.
 *
 * `currentUrl` is compared (sameDocumentUrl) against the URL the
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
    // The counter splits two honestly different states the old single copy
    // conflated: a tab nobody ever read, and a tab whose refs were
    // invalidated (normally by navigation). Telling an agent that DID read
    // the page to "read the page first" reads as gaslighting (#179 QA).
    const mintedBefore = (counters.get(tabId) ?? 0) > 0
    return {
      ok: false,
      reason: 'no-snapshot',
      detail: mintedBefore
        ? `tab ${tabId} has no live snapshot: the refs minted earlier are gone ` +
          '(usually a navigation invalidated them). Re-read the page for fresh refs'
        : `no snapshot cached for tab ${tabId} (read the page first)`,
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
          `ref @${ref} is from before the last navigation; its element no longer ` +
          'exists here. Re-read the page and use a fresh ref',
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
    frameTargetId: refTarget.frameTargetId,
    frameUrl: refTarget.frameUrl,
    role: refTarget.role,
    name: refTarget.name,
  }
}

/** Invalidate the map (navigation), stored mirror included: a recycle must
 *  not resurrect a navigated-away document's refs. The COUNTER deliberately
 *  survives, in memory and in storage: it is what keeps a post-navigation
 *  read from re-minting held numbers. */
export function clear(tabId: number): void {
  cache.delete(tabId)
  if (!hydrationDone && !tombstones.has(tabId)) tombstones.set(tabId, 'map')
  removeStored([refsKey(tabId)])
}

/** Tab closed: everything goes, counter included (tab ids are not reused
 *  within a browser session in a way a held ref could survive). */
export function dropTab(tabId: number): void {
  cache.delete(tabId)
  counters.delete(tabId)
  hydrated.delete(tabId)
  mintLocks.delete(tabId)
  if (!hydrationDone) tombstones.set(tabId, 'all')
  removeStored([counterKey(tabId), refsKey(tabId)])
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
  hydration = null
  hydrationDone = false
  tombstones.clear()
}
