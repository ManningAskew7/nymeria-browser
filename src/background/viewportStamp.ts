/**
 * The viewport each tab's last SCREENSHOT was aimed in (#191).
 *
 * A coordinate act's [x, y] is read off a capture, and the viewport under it
 * is not stable: Chrome's "being debugged" infobar lands and un-lands with
 * the debugger attach (~56 CSS px, both directions, measured live), and
 * zoom, window resizes and DevTools docking move it too. A coordinate aimed
 * before any of those clicks the neighbour AND reports success (the #191
 * Google Flights misclick). So the capture path stamps the viewport it
 * answered in, and the coordinate path refuses when the live viewport no
 * longer matches, which turns the silent misclick into a refusal that says
 * to re-capture.
 *
 * Rides `sessionStamp.ts` (#204) like the other per-tab evidence stamps;
 * the storage rationale lives there. Specific to THIS stamp:
 *  - Only CAPTURES write it (the stamp means "what the agent last aimed
 *    from"), and the write is a PROBE-WORLD read taken AFTER the shutter,
 *    through `viewportReadExpression` below: the same source, same world
 *    and same hardened lookup the act-side gate reads, so neither a
 *    metrics fallback (`cssVisualViewport` excludes the scrollbar) nor a
 *    page that patches `window.innerWidth` in the main world can put the
 *    two sides in permanent disagreement (both were review findings).
 *    Post-shutter because `captureBeyondViewport` reflows the page, and
 *    the stamp must be the truth the agent is now aiming in.
 *  - A refusal that TEACHES a coordinate (pointer-events click-through,
 *    covered-point advice) clears it: the taught point comes from live
 *    geometry in the CURRENT viewport, not from a capture, and gating the
 *    very follow-up the refusal asked for would refuse its own advice.
 *    Accepted residual: the clear ungates the whole TAB until the next
 *    capture, not just the taught point.
 *  - No stamp, or an unreadable read, means fail OPEN: a coordinate act on
 *    a never-captured tab keeps today's behavior. The gate is a capability
 *    aid, not a wall. The stamp itself rides `chrome.storage.session`, so
 *    an MV3 worker recycle does NOT drop it; only tab close, an unreadable
 *    capture-time read, or a teaching refusal do.
 */

import { sessionStamp } from './sessionStamp'

export interface ViewportStamp {
  width: number
  height: number
}

/**
 * The ONE in-page expression both sides of the gate read the viewport with:
 * probe world, own-descriptor-first lookup (`GLOBAL_READ_SNIPPET` shape,
 * inlined so this module stays import-light), null when unreadable. The
 * capture side wraps it alone; the act side splices it into the
 * `describePoint` probe so the gate costs no extra round trip.
 */
export const viewportReadExpression = `(function () {
  var read = function (name) {
    var d = null;
    try { d = Object.getOwnPropertyDescriptor(globalThis, name); } catch (e) {}
    if (!d) { try { d = Object.getOwnPropertyDescriptor(Window.prototype, name); } catch (e) {} }
    if (!d) return undefined;
    try { return d.get ? d.get.call(globalThis) : d.value; } catch (e) { return undefined; }
  };
  var w = read('innerWidth');
  var h = read('innerHeight');
  return (typeof w === 'number' && isFinite(w) && typeof h === 'number' && isFinite(h))
    ? { width: w, height: h } : null;
})()`

const store = sessionStamp<ViewportStamp>('nymViewport:', (raw) =>
  typeof raw.width === 'number' &&
  Number.isFinite(raw.width) &&
  typeof raw.height === 'number' &&
  Number.isFinite(raw.height)
    ? { width: raw.width, height: raw.height }
    : null,
)

/** Record the viewport a capture answered in. Fire-and-forget. */
export function recordViewport(tabId: number, width: number, height: number): void {
  store.record(tabId, { width, height })
}

/** The tab's aim-time viewport, or null (never captured / cleared / lost). */
export async function readViewportStamp(tabId: number): Promise<ViewportStamp | null> {
  return store.read(tabId)
}

/** Drop the stamp: tab closed, viewport unreadable at capture time, or a
 *  refusal just taught a live-geometry coordinate. Fire-and-forget. */
export function dropViewportStamp(tabId: number): void {
  store.clear(tabId)
}
