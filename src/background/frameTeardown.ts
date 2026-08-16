import { onCdpEvent } from './debuggerSession'
import { clearSessionWorlds } from './worlds'

/**
 * Per-frame WORLD teardown on session detach.
 *
 * A frame session detaching invalidates that session's cached isolated
 * worlds: execution context ids are strictly per-session, so a context
 * minted under a dead session id can never answer again, and the cache
 * entry would only produce context-gone errors on the next probe.
 *
 * Deliberately NOT ref invalidation any more. This module used to clear the
 * frame's refs here too, but sessions die routinely: the debugger detaches
 * from the whole tab after a 10s idle linger, taking every frame session
 * with it, and the same frames re-announce under new session ids on the
 * next attach. Session-keyed refs therefore died between one tool call and
 * the agent's next thought (measured 2026-08-16 live QA: three consecutive
 * stale reads to land one click). Refs now key on the frame's STABLE target
 * id (`snapshotRefs.RefTarget.frameTargetId`) and are resolved to the live
 * session at act time, so a detach costs nothing and a frame that truly
 * left the page refuses honestly at resolution
 * (`frameSessionByTargetId` finding nothing).
 *
 * debuggerSession's frame tracking consumes the same event for its own
 * session map; the two subscribers are independent. A module (not an inline
 * index.ts listener) for the same reason as installNavWatch and friends:
 * the behavior is load-bearing and must be testable without booting the
 * whole worker entrypoint.
 */

let installed = false

/** Idempotent; called once from the worker top level (index.ts). */
export function installFrameTeardown(): void {
  if (installed) return
  installed = true
  onCdpEvent((tabId, method, params) => {
    if (method !== 'Target.detachedFromTarget') return
    const p = params as { sessionId?: string }
    if (!p.sessionId) return
    clearSessionWorlds(tabId, p.sessionId)
  })
}

export function resetForTests(): void {
  installed = false
}
