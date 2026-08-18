/**
 * The capture-honesty flags shared by every buffer-reading command (#183).
 *
 * One sampler, because the network and console reads must tell the same
 * story or one of them lies by omission: v0.9.0 gave network the
 * started-now/resumed split and left console silent, and the console read
 * had the identical ambiguity (an empty list that says nothing about the
 * page). The flags read the SESSION layer, never the buffer, for the
 * reasons network.ts documents: an emptied buffer is not a tab that was
 * never watched.
 *
 * MUST be sampled BEFORE the command's own `withSession` call: that call
 * re-attaches the tab, which flips `isAttached` and ends the very lapse
 * `capture_gap_ms` measures.
 *
 * `capture_gap_ms` rides only beside `capture_resumed`: it is the duration
 * of the lapse being resumed (how long the tab went unwatched, #183). It is
 * absent when the detach stamp is gone (a worker recycle wipes it with the
 * buffers it describes), and absent means unknown, never zero.
 */

import { everAttached, isAttached, lastDetachAt } from '../debuggerSession'

export interface CaptureSample {
  /** Was capture already running when the question was asked? */
  wasAttached: boolean
  /** Payload-ready honesty flags; spread into the command's data. */
  flags: Record<string, unknown>
}

/**
 * Milliseconds this tab has gone unwatched: only when it is detached after
 * having captured this worker life, and only while the detach stamp
 * survives (a recycle wipes it with the buffers). The ONE definition of the
 * gap rule; the health read shares it so the two cannot drift.
 */
export function captureGapMs(tabId: number): number | null {
  if (isAttached(tabId) || !everAttached(tabId)) return null
  const detachedAt = lastDetachAt(tabId)
  return detachedAt !== null ? Math.max(0, Date.now() - detachedAt) : null
}

export function sampleCaptureFlags(tabId: number): CaptureSample {
  const wasAttached = isAttached(tabId)
  const wasCapturedBefore = everAttached(tabId)
  const gapMs = captureGapMs(tabId)
  const flags = wasAttached
    ? {}
    : wasCapturedBefore
      ? { capture_resumed: true, ...(gapMs !== null ? { capture_gap_ms: gapMs } : {}) }
      : { capture_started_now: true }
  return { wasAttached, flags }
}
