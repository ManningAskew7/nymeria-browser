/**
 * Per-tab cache mapping snapshot refs (`@e5`) to CDP `backendNodeId`s.
 *
 * Refs are assigned by `chrome_snapshot`'s AX-tree formatter and stay
 * valid until the page mutates significantly. We invalidate on
 * navigation via the chrome.webNavigation / chrome.tabs.onUpdated hooks
 * registered in background/index.ts.
 */

type Ref = string // "e1", "e2", ...
type BackendNodeId = number

interface TabRefs {
  byRef: Map<Ref, BackendNodeId>
  urlAtSnapshot: string | null
}

const cache = new Map<number, TabRefs>()

export function set(tabId: number, refs: Map<Ref, BackendNodeId>, url: string | null = null): void {
  cache.set(tabId, { byRef: new Map(refs), urlAtSnapshot: url })
}

export function resolve(tabId: number, target: string): BackendNodeId | null {
  // target may be "@e5", "e5", or unrelated.
  const ref = target.startsWith('@') ? target.slice(1) : target
  const entry = cache.get(tabId)
  if (!entry) return null
  return entry.byRef.get(ref) ?? null
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
