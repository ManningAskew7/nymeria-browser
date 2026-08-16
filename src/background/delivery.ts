import { sendCommand, type Cdp } from './debuggerSession'
import { callOn } from './input'
import {
  cachedWorld,
  clearWorldEntry,
  createWorld,
  DELIVERY_WORLD,
  isContextGone,
  resetForTests as resetWorlds,
  worldFor,
} from './worlds'

/**
 * Did the input we dispatched actually reach the page?
 *
 * `Input.dispatchMouseEvent` / `dispatchKeyEvent` are accepted by CDP and acked
 * without error even when the browser discards them before the renderer. Chrome
 * does exactly that while a tab-modal dialog is showing: `TabDialogManager`
 * calls `IgnoreInputEvents` on the WebContents, and the events are dropped in
 * the browser process. Nothing mutates, so `settle` reports `quiet`, and the
 * action reports a clean success having done nothing at all.
 *
 * Measured live: a tab holding Chrome's password-breach warning recorded ZERO
 * events at a document capture listener while a fresh tab recorded all of them,
 * and both reported `input: "trusted"`, `settled: "quiet"`. The suppression is
 * per tab and rides through reloads.
 *
 * Recovery is PER CLASS, measured 2026-08-11, and NOT "only a fresh tab" as
 * this comment used to say: navigating the same tab elsewhere fully clears an
 * HTTP auth prompt, but leaves input dead after an `alert`, which needs the tab
 * closed. The suppression can also OUTLIVE the dialog, so a tab can discard
 * input with nothing left on screen to explain it.
 *
 * Whether the page can run script AT ALL is a different question and is not
 * asked here: `settle.ts::rendererResponsive` owns it, and the caller checks it
 * once up front rather than per probe.
 *
 * There is no CDP getter for that flag, and `Page.javascriptDialogOpening`
 * fires only for renderer-originated dialogs, so the cause cannot be checked
 * for. This module checks the CONSEQUENCE instead, which has the useful
 * property of catching causes we have not met: a page that swallows the event,
 * a disabled control, whatever Chrome does next.
 *
 * ISOLATED WORLD, deliberately. The counter lives in a world that shares the
 * DOM but not the globals, so a page can neither see the probe nor remove it.
 * A main-world probe would be a second instance of the weakness backlog #160
 * already calls the item "with real teeth".
 *
 * Only TRUSTED events count. An isolated world hides the counter but not the
 * DOM, so page script dispatching its own `mousedown` would otherwise read as
 * delivery and hand a hostile page the silent-success bug back. `isTrusted` is
 * set by the browser and cannot be forged from script.
 *
 * Listeners go on `window` in the CAPTURE phase, the first hop of the capture
 * path, so an ordinary page handler cannot pre-empt them with
 * `stopPropagation`. The residual hole is a page that registered its own
 * `window` capture listener at load time and calls `stopImmediatePropagation`:
 * ours is registered later on the same node, so it would be skipped.
 *
 * SCOPE, and why absence needs a second question. The probe covers ONE
 * document: the one belonging to the SESSION it is armed on. It is armed
 * where the input goes: the root session for main-document and coordinate
 * acts, the frame's own session for a frame ref, so an in-frame act gets a
 * real verdict from inside its frame instead of a permanent "unknown" (the
 * pre-2026-08-16 shape, which is exactly where the measured silent no-op
 * hid). Events inside a NESTED browsing context below the probed document
 * still never reach its window, so a zero count is not by itself proof:
 * `absenceIsConclusive` asks the follow-up, and only a conclusive absence is
 * allowed to fail a command. That ordering matters because a false "no" is
 * not cheap: it tells the agent to abandon a working tab, and it has no way
 * to discover the advice is wrong.
 */

/** `unknown` means we could not prove either way, and is NOT a failure. */
export type DeliveryOutcome = 'yes' | 'no' | 'unknown'

export interface DeliveryReading {
  outcome: DeliveryOutcome
  /** For `unknown` only: why nothing could be proven, payload-ready. */
  reason?: string
  /**
   * Trusted-event counts by type (#176). "Arrived" alone cannot tell a press
   * that never composed into a `click` from a click whose default action was
   * gated; the per-type breakdown can. Present when the counter was read
   * back intact, absent on the context-gone (navigated) path.
   */
  events?: Record<string, number>
  /**
   * `defaultPrevented` of the last COMPOSED click-family event (`click`,
   * `contextmenu`, `dblclick`), sampled a tick after dispatch so page
   * handlers have had their turn (our capture listener runs FIRST, before
   * any of them can call preventDefault). Absent when none composed.
   */
  clickDefaultPrevented?: boolean
  /** The probed frame's user-activation state at read time (#176: the gate
   * navigation-class default actions key on). */
  userActivation?: { active: boolean; hasBeenActive: boolean }
  /**
   * Identity of the last composed click-family event's target: tag name and,
   * when the target sits inside an anchor, that anchor's resolved href. The
   * one remaining in-frame measurable after the #176 round rejected the
   * simple hypotheses: a click composed on `body` instead of the anchor
   * would explain a defaultless click and implicate geometry.
   */
  clickTarget?: { tag: string; href?: string }
}

export interface DeliveryProbe {
  /** Read the count and disarm. Safe to call once; further calls report unknown. */
  read(): Promise<DeliveryReading>
  /**
   * Snapshot the counters WITHOUT disarming, and keep the snapshot inside
   * the handle. A navigation that follows a successful click destroys the
   * probe's world, so the final read can prove delivery but loses the
   * per-type counts; a peek taken right after dispatch preserves them for
   * that case (QA-operator rider, 2026-08-16: the SUCCESS payload was
   * data-poorer than the failure one). BEST EFFORT: an instantly-committing
   * navigation can kill the context before even this runs (measured live on
   * a hot-cache frame nav, 2026-08-16); the payload then simply omits the
   * counts, as before. Never throws; a peek that finds a dead context
   * stores nothing.
   */
  peek(): Promise<void>
}

/**
 * How long an unread probe may sit before the next arm sweeps it.
 *
 * Every early return inside an action leaves its probe armed and never read.
 * Without a sweep those listeners accumulate on a long-lived page for as long
 * as the tab is open.
 */
const ORPHAN_MS = 60_000

/**
 * Probes are keyed, not singular.
 *
 * A batch of tool calls in one assistant turn runs concurrently, so two
 * `chrome_act` calls on the same tab overlap routinely. With one shared
 * counter the second arm would zero the first's count and the first read would
 * delete the second's record, so a genuinely delivered action could read zero
 * and hard-fail. Each probe owns its own entry instead.
 */
let nextProbeId = 0

/**
 * Drop one session's cached delivery world. A committed navigation destroys
 * the isolated world along with the document, so the cached id would resolve
 * to nothing. The creation/caching machinery itself lives in `worlds.ts`
 * (shared with the trust probes' world); this module keeps only its POLICY.
 */
export function clearWorld(target: Cdp): void {
  clearWorldEntry(target, DELIVERY_WORLD)
}

/**
 * Counts events by type at window capture. Written as an IIFE returning a
 * boolean so a failure to install surfaces as `false` rather than as an
 * exception we would have to guess the meaning of.
 */
function armExpression(types: readonly string[], id: string): string {
  return `(function(types, id){
    try {
      var g = globalThis;
      var reg = g.__nymDelivery || (g.__nymDelivery = {});
      var now = Date.now();
      for (var k in reg) {
        if (reg[k] && now - reg[k].t > ${ORPHAN_MS}) {
          try { reg[k].off(); } catch (e) {}
          delete reg[k];
        }
      }
      var n = 0;
      var counts = {};
      var prevented = null;
      var clickTarget = null;
      var offs = [];
      for (var i = 0; i < types.length; i++) {
        (function(type){
          var composed = type === 'click' || type === 'contextmenu' || type === 'dblclick';
          var h = function(e){
            if (e && e.isTrusted) {
              n += 1;
              counts[type] = (counts[type] || 0) + 1;
              if (composed) {
                setTimeout(function(){ try { prevented = e.defaultPrevented === true; } catch (err) {} }, 0);
                try {
                  var t = e.target;
                  var info = { tag: t && t.tagName ? String(t.tagName).toLowerCase() : String(t) };
                  var a = t && t.closest ? t.closest('a[href]') : null;
                  if (a && a.href) info.href = String(a.href);
                  clickTarget = info;
                } catch (err) {}
              }
            }
          };
          window.addEventListener(type, h, true);
          offs.push(function(){ window.removeEventListener(type, h, true); });
        })(types[i]);
      }
      reg[id] = {
        t: now,
        snap: function(){ return { n: n, types: counts, prevented: prevented, target: clickTarget }; },
        off: function(){ for (var j = 0; j < offs.length; j++) { try { offs[j](); } catch (e) {} } }
      };
      return true;
    } catch (e) {
      return false;
    }
  })(${JSON.stringify(types)}, ${JSON.stringify(id)})`
}

function readExpression(id: string): string {
  return `(function(id){
    var g = globalThis;
    var reg = g.__nymDelivery;
    if (!reg) return null;
    var p = reg[id];
    if (!p) return null;
    var out = p.snap ? p.snap() : { n: 0 };
    try {
      var ua = navigator.userActivation;
      out.ua = ua ? { a: ua.isActive === true, h: ua.hasBeenActive === true } : null;
    } catch (e) { out.ua = null; }
    try { p.off(); } catch (e) {}
    delete reg[id];
    return out;
  })(${JSON.stringify(id)})`
}

/** The read's non-destructive twin (marker: nymPeek). Listeners stay armed
 * and the registry entry survives, so the authoritative read still happens. */
function peekExpression(id: string): string {
  return `(function(id){ /* nymPeek */
    var g = globalThis;
    var reg = g.__nymDelivery;
    if (!reg) return null;
    var p = reg[id];
    if (!p || !p.snap) return null;
    var out = p.snap();
    try {
      var ua = navigator.userActivation;
      out.ua = ua ? { a: ua.isActive === true, h: ua.hasBeenActive === true } : null;
    } catch (e) { out.ua = null; }
    return out;
  })(${JSON.stringify(id)})`
}

/** True when this document contains no nested browsing context. */
const FRAMELESS_EXPRESSION = `(function(){
  try { return document.querySelectorAll('iframe,frame').length === 0; }
  catch (e) { return false; }
})()`

async function evaluateInWorld<T>(
  target: Cdp,
  contextId: number,
  expression: string,
): Promise<{ ok: true; value: T } | { ok: false; contextGone: boolean }> {
  try {
    const resp = await sendCommand<{
      result?: { value?: T }
      exceptionDetails?: unknown
    }>(target, 'Runtime.evaluate', { expression, contextId, returnByValue: true })
    if (resp.exceptionDetails) return { ok: false, contextGone: false }
    return { ok: true, value: resp.result?.value as T }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return { ok: false, contextGone: isContextGone(message) }
  }
}

/** The raw shape the page-side snap()/read/peek expressions return. */
type RawSnap = {
  n: number
  types?: Record<string, number>
  prevented?: boolean | null
  ua?: { a?: boolean; h?: boolean } | null
  target?: { tag?: unknown; href?: unknown } | null
}

/** Fold a raw snapshot's optional diagnosis fields into a reading. */
function enrich(reading: DeliveryReading, value: RawSnap): DeliveryReading {
  if (value.types && typeof value.types === 'object') reading.events = value.types
  if (typeof value.prevented === 'boolean') reading.clickDefaultPrevented = value.prevented
  if (value.ua && typeof value.ua.a === 'boolean') {
    reading.userActivation = { active: value.ua.a, hasBeenActive: value.ua.h === true }
  }
  if (value.target && typeof value.target.tag === 'string') {
    reading.clickTarget = {
      tag: value.target.tag,
      ...(typeof value.target.href === 'string' ? { href: value.target.href } : {}),
    }
  }
  return reading
}

/** A probe that never armed. Reports `unknown`, never `yes`. */
const UNARMED: DeliveryProbe = {
  read: async () => ({
    outcome: 'unknown',
    reason: 'the delivery probe could not be armed in the target document',
  }),
  peek: async () => {},
}

/**
 * Install the counter and return a handle that reads it.
 *
 * Never throws and never returns null: a probe that could not be armed reports
 * `unknown` when read, because the entire point of this module is to stop the
 * payload claiming more than it knows.
 *
 * This probe once also watched for clicks reaching a file input. That job
 * moved to `Page.setInterceptFileChooserDialog` + `Page.fileChooserOpened`
 * (armed per attach in `debuggerSession.ts`, recorded in `dialogs.ts`), which
 * PREVENTS the chooser rather than reporting it and sees every route this
 * listener could not: iframes, closed shadow roots, `showPicker()`, and
 * page-deferred clicks. See the #169 pass record.
 */
export async function armDelivery(target: Cdp, types: readonly string[]): Promise<DeliveryProbe> {
  let contextId = await worldFor(target, DELIVERY_WORLD)
  if (contextId === null) return UNARMED

  nextProbeId += 1
  const id = `p${nextProbeId}`
  const arm = () => armExpression(types, id)
  let armed = await evaluateInWorld<boolean>(target, contextId, arm())
  if (!armed.ok && armed.contextGone) {
    // The cached world died with its document. Rebuild once and retry.
    clearWorld(target)
    contextId = await createWorld(target, DELIVERY_WORLD)
    if (contextId === null) return UNARMED
    armed = await evaluateInWorld<boolean>(target, contextId, arm())
  }
  if (!armed.ok || armed.value !== true) return UNARMED

  const world = contextId
  let spent = false
  let peeked: RawSnap | null = null
  return {
    async peek(): Promise<void> {
      if (spent) return
      const result = await evaluateInWorld<RawSnap | null>(target, world, peekExpression(id))
      if (result.ok && result.value && typeof result.value.n === 'number') {
        peeked = result.value
      }
    },
    async read(): Promise<DeliveryReading> {
      if (spent) return { outcome: 'unknown', reason: 'the delivery probe was already read' }
      spent = true
      const result = await evaluateInWorld<RawSnap | null>(target, world, readExpression(id))
      if (!result.ok) {
        // The context was destroyed between arming and reading, which means
        // the document went away: the action navigated it. A navigation is
        // proof the input landed, so this is delivery, not ignorance. The
        // peek's snapshot, taken just after dispatch, restores the per-type
        // counts the navigation destroyed.
        if (result.contextGone) {
          clearWorld(target)
          const reading: DeliveryReading = { outcome: 'yes' }
          return peeked ? enrich(reading, peeked) : reading
        }
        return { outcome: 'unknown', reason: 'the delivery probe could not be read back' }
      }
      const value = result.value
      if (!value || typeof value.n !== 'number') {
        return { outcome: 'unknown', reason: 'the delivery probe could not be read back' }
      }
      return enrich({ outcome: value.n > 0 ? 'yes' : 'no' }, value)
    },
  }
}

/**
 * Can a zero count be believed as "the document received nothing"?
 *
 * Only asked when the probe already counted zero, so it costs nothing on the
 * ordinary path. Two ways to be sure, in order of cost:
 *
 *  - The probed document has no nested frames at all, so there was nowhere
 *    else for the event to go.
 *  - There are nested frames, but the target element lives directly in the
 *    probed document (not in a nested context below it).
 *
 * `probeTarget` is the session the probe was armed on (root or a frame).
 * The direct-membership check compares the element's ownerDocument with the
 * `document` of its own trust world, in ONE world so wrapper identity holds:
 * the trust world is created on the session's root frame, which is exactly
 * the document the delivery world watches. This replaces the old
 * `w === w.top` expression, which could never be true for a frame element
 * and so silently disabled conclusiveness for every in-frame act.
 *
 * Anything else (an untargeted action on a framed page, or a target in a
 * nested context below the probed document) is genuinely unknown, and must
 * not be reported as a failure: a nested payment field would otherwise fail
 * every click with advice to abandon a working tab.
 */
export async function absenceIsConclusive(
  probeTarget: Cdp,
  target: { session: Cdp; objectId: string } | null,
): Promise<boolean> {
  const contextId = cachedWorld(probeTarget, DELIVERY_WORLD)
  if (contextId !== undefined) {
    const frameless = await evaluateInWorld<boolean>(probeTarget, contextId, FRAMELESS_EXPRESSION)
    if (frameless.ok && frameless.value === true) return true
  }
  if (!target) return false
  try {
    const direct = await callOn<boolean>(
      target.session,
      target.objectId,
      `function(){
        try { return this.ownerDocument === document; } catch (e) { return false; }
      }`,
    )
    return direct === true
  } catch {
    return false
  }
}

export function resetForTests(): void {
  resetWorlds()
}
