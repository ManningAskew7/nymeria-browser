/**
 * Per-tab cache mapping snapshot refs (`@e5`) to CDP `backendNodeId`s.
 *
 * Refs are minted by the snapshot formatter and are only meaningful for the
 * exact document they were read from. Three things invalidate them:
 *
 *  - navigation (committed navigation hooks in background/index.ts),
 *  - tab close,
 *  - the recorded URL no longer matching the tab's current URL, which is the
 *    backstop for the cases the hooks miss (a service-worker recycle between
 *    snapshot and act drops this map entirely, and a same-document history
 *    change may not commit).
 *
 * Callers never get a bare `null` back: `resolve` returns a typed reason so
 * the agent is told to re-read the page instead of being left to guess why a
 * ref stopped working. Acting on a stale ref must never silently mis-click.
 */

type Ref = string // "e1", "e2", ...

/**
 * Where a ref actually lives.
 *
 * `backendNodeId` is a PROCESS-global counter, not a page-global one, so the
 * same number identifies different elements in the main document and in a
 * cross-origin iframe. Storing the owning session alongside it is what stops
 * an iframe ref from silently resolving to an unrelated main-frame element.
 */
export interface RefTarget {
  backendNodeId: number
  /** Undefined means the root page session. */
  sessionId?: string
}

interface TabRefs {
  byRef: Map<Ref, RefTarget>
  urlAtSnapshot: string | null
  /** Bumped on every snapshot so callers can detect a re-read mid-sequence. */
  generation: number
}

export type StaleReason = 'no-snapshot' | 'unknown-ref' | 'navigated'

export type RefResolution =
  | { ok: true; backendNodeId: number; sessionId?: string; generation: number }
  | { ok: false; reason: StaleReason; detail: string }

const cache = new Map<number, TabRefs>()
let generationCounter = 0

export function set(tabId: number, refs: Map<Ref, RefTarget>, url: string | null = null): number {
  generationCounter += 1
  cache.set(tabId, { byRef: new Map(refs), urlAtSnapshot: url, generation: generationCounter })
  return generationCounter
}

/**
 * Resolve a `@eN` ref for a tab.
 *
 * `currentUrl` is compared against the URL the snapshot was taken from when
 * both are known; a mismatch is reported as `navigated` rather than resolving
 * a backendNodeId that now points into a different document.
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
  if (currentUrl && entry.urlAtSnapshot && currentUrl !== entry.urlAtSnapshot) {
    return {
      ok: false,
      reason: 'navigated',
      detail: `page moved from ${entry.urlAtSnapshot} to ${currentUrl} since the snapshot (re-read the page)`,
    }
  }
  const refTarget = entry.byRef.get(ref)
  if (refTarget == null) {
    return {
      ok: false,
      reason: 'unknown-ref',
      detail: `unknown ref @${ref} (re-read the page to refresh refs)`,
    }
  }
  return {
    ok: true,
    backendNodeId: refTarget.backendNodeId,
    sessionId: refTarget.sessionId,
    generation: entry.generation,
  }
}

export function clear(tabId: number): void {
  cache.delete(tabId)
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

export function generation(tabId: number): number | null {
  return cache.get(tabId)?.generation ?? null
}

export function resetForTests(): void {
  cache.clear()
  generationCounter = 0
}
