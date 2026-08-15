import { onCdpEvent } from './debuggerSession'
import { clearSession as clearSessionRefs } from './snapshotRefs'
import { clearSessionWorlds } from './worlds'

/**
 * Per-FRAME ref and world invalidation, the piece of the staleness story
 * that tab-level hooks cannot carry (#160): a frame session detaching means
 * that OOPIF navigated cross-process or left the page, so its refs and its
 * cached probe world are dead while the top document lives on. Whole-map
 * clearing here would make ad-heavy pages unusable (their iframes churn
 * constantly); the in-process remainder is covered at act time by the
 * detached and fingerprint checks. debuggerSession's frame tracking consumes
 * the same event for its own session map; the two subscribers are
 * independent.
 *
 * A module (not an inline index.ts listener) for the same reason as
 * installNavWatch and friends: the behavior is load-bearing and must be
 * testable without booting the whole worker entrypoint.
 */

let installed = false

/** Idempotent; called once from the worker top level (index.ts). */
export function installRefInvalidation(): void {
  if (installed) return
  installed = true
  onCdpEvent((tabId, method, params) => {
    if (method !== 'Target.detachedFromTarget') return
    const p = params as { sessionId?: string }
    if (!p.sessionId) return
    clearSessionRefs(tabId, p.sessionId)
    clearSessionWorlds(tabId, p.sessionId)
  })
}

export function resetForTests(): void {
  installed = false
}
