import { onCdpEvent, sendCommand, type Cdp } from './debuggerSession'
import { callOn } from './input'
import { sessionStamp } from './sessionStamp'
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
 * document: the one its WORLD lives in. It is armed where the input goes:
 * the root session for main-document and coordinate acts, the frame's own
 * session for an OOPIF ref, and the frame's own per-frame world (a
 * frameId-carrying root target, reads-honesty pass) for a same-process
 * frame ref, so an in-frame act gets a real verdict from inside its frame
 * instead of a permanent "unknown" (the pre-2026-08-16 shape, which is
 * exactly where the measured silent no-op
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
   * DETERMINISTIC since #180: the read itself yields one macrotask in the
   * page before snapping, and timer FIFO guarantees the handler's earlier
   * `setTimeout(0)` has run, so presence no longer depends on which
   * macrotask the read lands in.
   */
  clickDefaultPrevented?: boolean
  /** The probed frame's user-activation state (#176: the gate
   * navigation-class default actions key on). Sampled at EVENT time in the
   * handler since #180 (so a navigating click keeps it); read-time sample
   * kept as fallback when no trusted event fired. */
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
 * The teardown-proof channel (#180): a `Runtime.addBinding` function the
 * handler calls after every trusted event, delivered to the background as
 * `Runtime.bindingCalled` (the Runtime domain is enabled on every attach,
 * root and frame sessions alike). Scoped by `executionContextName` to the
 * delivery world, so page script never sees it. Installed on EVERY arm,
 * deliberately uncached: bindings die with the debugger session, and one
 * try/catch round trip per act is cheaper than session-end bookkeeping
 * that can go stale (re-adding an existing binding is harmless).
 */
const PUSH_BINDING = '__nymDeliveryPush'

/** Freshest pushed snapshot per live probe id. Entries are registered at
 * arm, consumed and dropped at read, and swept by the next arm when a
 * probe was abandoned unread (the page-side registry's ORPHAN_MS twin). */
const pushSlots = new Map<string, { at: number; snap: RawSnap | null }>()

let pushRoutingInstalled = false
function ensurePushRouting(): void {
  if (pushRoutingInstalled) return
  pushRoutingInstalled = true
  onCdpEvent((_tabId, method, params) => {
    if (method !== 'Runtime.bindingCalled') return
    const p = params as { name?: unknown; payload?: unknown } | undefined
    if (p?.name !== PUSH_BINDING || typeof p.payload !== 'string') return
    try {
      const parsed = JSON.parse(p.payload) as { id?: unknown } & RawSnap
      if (typeof parsed.id === 'string' && typeof parsed.n === 'number') {
        const slot = pushSlots.get(parsed.id)
        if (slot) slot.snap = parsed
      }
    } catch {
      /* A malformed payload is dropped: the push is evidence, not control. */
    }
  })
}

async function installPushBinding(target: Cdp): Promise<void> {
  try {
    await sendCommand(target, 'Runtime.addBinding', {
      name: PUSH_BINDING,
      executionContextName: DELIVERY_WORLD,
    })
  } catch {
    /* Best effort: without the binding the probe degrades to peek-only. */
  }
}

function sweepPushSlots(now: number): void {
  for (const [id, slot] of pushSlots) {
    if (now - slot.at > ORPHAN_MS) pushSlots.delete(id)
  }
}

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
 *
 * The handler also PUSHES its facts out of the page after every trusted
 * event (#180), through the `Runtime.addBinding` channel installed per
 * arm: the closure these facts live in dies with the document, and the
 * navigating click, the case the diagnosis matters most for, used to lose
 * them all because the read (and usually the peek) arrived after
 * teardown. The push is synchronous CDP event emission, so it lands
 * before a navigation can commit; the `setTimeout(0)` push after it
 * carries the settled `defaultPrevented`, which still beats a real
 * navigation's commit in practice (one macrotask vs at least a network
 * round trip). Best-effort throughout: no binding, no pushes, and the
 * probe degrades to exactly the peek-only behavior it had before.
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
      var uaEvent = null;
      var offs = [];
      var push = function(){
        try {
          if (typeof g.${PUSH_BINDING} === 'function') {
            g.${PUSH_BINDING}(JSON.stringify({ id: id, n: n, types: counts, prevented: prevented, target: clickTarget, uae: uaEvent }));
          }
        } catch (err) {}
      };
      for (var i = 0; i < types.length; i++) {
        (function(type){
          var composed = type === 'click' || type === 'contextmenu' || type === 'dblclick';
          var h = function(e){
            if (e && e.isTrusted) {
              n += 1;
              counts[type] = (counts[type] || 0) + 1;
              try {
                var u = navigator.userActivation;
                if (u) uaEvent = { a: u.isActive === true, h: u.hasBeenActive === true };
              } catch (err) {}
              if (composed) {
                setTimeout(function(){
                  try { prevented = e.defaultPrevented === true; } catch (err) {}
                  push();
                }, 0);
                try {
                  var t = e.target;
                  var info = { tag: t && t.tagName ? String(t.tagName).toLowerCase() : String(t) };
                  var a = t && t.closest ? t.closest('a[href]') : null;
                  if (a && a.href) info.href = String(a.href);
                  clickTarget = info;
                } catch (err) {}
              }
              push();
            }
          };
          window.addEventListener(type, h, true);
          offs.push(function(){ window.removeEventListener(type, h, true); });
        })(types[i]);
      }
      reg[id] = {
        t: now,
        snap: function(){ return { n: n, types: counts, prevented: prevented, target: clickTarget, uae: uaEvent }; },
        off: function(){ for (var j = 0; j < offs.length; j++) { try { offs[j](); } catch (e) {} } }
      };
      return true;
    } catch (e) {
      return false;
    }
  })(${JSON.stringify(types)}, ${JSON.stringify(id)})`
}

/**
 * The read yields ONE macrotask in the page before snapping (#180).
 * `setTimeout` callbacks run FIFO within the timer source, so the
 * handler's deferred `defaultPrevented` sample, queued at event time, has
 * provably run by the time this snap executes: the field's presence no
 * longer depends on how many CDP round trips happened to sit between
 * dispatch and read. Evaluated with `awaitPromise`; a document torn down
 * mid-yield rejects the evaluate with a context-destroyed error, which is
 * the same navigated-so-delivered path the sync read already took.
 */
function readExpression(id: string): string {
  return `(function(id){
    var g = globalThis;
    var reg = g.__nymDelivery;
    if (!reg) return null;
    var p = reg[id];
    if (!p) return null;
    return new Promise(function(resolve){ setTimeout(resolve, 0); }).then(function(){
      var out = p.snap ? p.snap() : { n: 0 };
      try {
        var ua = navigator.userActivation;
        out.ua = ua ? { a: ua.isActive === true, h: ua.hasBeenActive === true } : null;
      } catch (e) { out.ua = null; }
      try { p.off(); } catch (e) {}
      delete reg[id];
      return out;
    });
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
  opts: { awaitPromise?: boolean } = {},
): Promise<{ ok: true; value: T } | { ok: false; contextGone: boolean }> {
  try {
    const resp = await sendCommand<{
      result?: { value?: T }
      exceptionDetails?: unknown
    }>(target, 'Runtime.evaluate', {
      expression,
      contextId,
      returnByValue: true,
      ...(opts.awaitPromise ? { awaitPromise: true } : {}),
    })
    if (resp.exceptionDetails) return { ok: false, contextGone: false }
    return { ok: true, value: resp.result?.value as T }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return { ok: false, contextGone: isContextGone(message) }
  }
}

/** The raw shape the page-side snap()/read/peek/push expressions return.
 * `uae` is the handler's event-time user-activation sample (#180); `ua`
 * the read/peek-time one. */
type RawSnap = {
  n: number
  types?: Record<string, number>
  prevented?: boolean | null
  ua?: { a?: boolean; h?: boolean } | null
  uae?: { a?: boolean; h?: boolean } | null
  target?: { tag?: unknown; href?: unknown } | null
}

/** Fold a raw snapshot's optional diagnosis fields into a reading. */
function enrich(reading: DeliveryReading, value: RawSnap): DeliveryReading {
  if (value.types && typeof value.types === 'object') reading.events = value.types
  if (typeof value.prevented === 'boolean') reading.clickDefaultPrevented = value.prevented
  // Event-time activation outranks the read-time sample: it is the state
  // the input itself produced, and it is the one a navigating click keeps.
  const ua = value.uae && typeof value.uae.a === 'boolean' ? value.uae : value.ua
  if (ua && typeof ua.a === 'boolean') {
    reading.userActivation = { active: ua.a, hasBeenActive: ua.h === true }
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
  ensurePushRouting()
  let contextId = await worldFor(target, DELIVERY_WORLD)
  if (contextId === null) return UNARMED
  await installPushBinding(target)

  nextProbeId += 1
  const id = `p${nextProbeId}`
  sweepPushSlots(Date.now())
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

  pushSlots.set(id, { at: Date.now(), snap: null })
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
      const result = await evaluateInWorld<RawSnap | null>(target, world, readExpression(id), {
        awaitPromise: true,
      })
      const pushed = pushSlots.get(id)?.snap ?? null
      pushSlots.delete(id)
      if (!result.ok) {
        // The context was destroyed between arming and reading, which means
        // the document went away: the action navigated it. A navigation is
        // proof the input landed, so this is delivery, not ignorance. The
        // handler's own pushes, emitted at event time through the binding
        // channel, restore the diagnosis the navigation destroyed (#180);
        // the peek's post-dispatch snapshot backs them up where the binding
        // never installed. Pushed enriches LAST so event-time truth wins.
        if (result.contextGone) {
          clearWorld(target)
          let reading: DeliveryReading = { outcome: 'yes' }
          if (peeked) reading = enrich(reading, peeked)
          if (pushed) reading = enrich(reading, pushed)
          return reading
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

/**
 * Suppression EVIDENCE, per tab (#188): the last act whose probe concluded a
 * conclusive "no" (a trusted event was dispatched and provably swallowed).
 *
 * This is the honest substitute for a flag Chrome does not expose (see the
 * module docstring: there is no CDP getter for `IgnoreInputEvents`, only the
 * consequence is observable). Evidence, not state: recorded when an act
 * proves swallowing, cleared when a later act proves delivery, and reported
 * by the health read as "input was being swallowed as of T", never as "input
 * is suppressed now".
 *
 * Rides `sessionStamp.ts` (#204): storage-only in `chrome.storage.session`,
 * fire-and-forget writes, shape-validated reads, health the sole reader.
 * The suppression being evidenced SURVIVES navigation and outlives worker
 * recycles (measured, module docstring). The two evidence stores tell ONE
 * story, the last conclusive verdict: the cross-clears in BOTH directions
 * live side by side at the act.ts verdict site, where that story is
 * decided.
 */
export interface SuppressionEvidence {
  at: number
  action: string
}

const swallowStore = sessionStamp<SuppressionEvidence>('nymSwallow:', (raw) =>
  typeof raw.at === 'number' && typeof raw.action === 'string'
    ? { at: raw.at, action: raw.action }
    : null,
)

/** An act's trusted input was provably swallowed on this tab. */
export function recordSwallowedInput(tabId: number, action: string): void {
  swallowStore.record(tabId, { at: Date.now(), action })
}

/**
 * A later act's trusted input provably arrived, or the tab closed: the
 * evidence is spent either way (the onRemoved block calls this too, since
 * Chrome reuses tab ids).
 */
export function clearSwallowedInput(tabId: number): void {
  swallowStore.clear(tabId)
}

/** Last-known swallowed-input evidence for a tab, or null. */
export async function suppressionEvidence(tabId: number): Promise<SuppressionEvidence | null> {
  return swallowStore.read(tabId)
}

/**
 * Positive delivery EVIDENCE, per tab (#202): the last act whose trusted
 * input was proven delivered. The suppression store's twin, and it carries
 * the SAME verdict `input_delivered: "yes"` ships, context-gone included:
 * this module's own measured position is that a destroyed probe world
 * means the action navigated the document, which IS delivery (see read()).
 * A stricter counted-only gate shipped first and QA measured the
 * incoherence: the navigating click, the case the field was designed for,
 * never stamped (v0.13.0, operator-reproduced), while input_delivered
 * said yes beside it. One system, one verdict.
 *
 * `url` is the TAB URL the delivery was proven under (browser-API truth
 * from the act's own pre-dispatch read, null when that read failed; for an
 * in-frame act it is still the tab's top-level URL, not the frame's).
 * `navSeq` is the tab's commit seq sampled BEFORE the action: the proof
 * belongs to the pre-navigation document, so the click's own commit makes
 * the seq differ and health's `on_current_url` reads false immediately,
 * the designed good-news shape. It also kills the measured
 * coincidental-return lie: a later navigation BACK to the stamp's URL
 * matches on text but not on seq. Per-worker (navWatch is in-memory), so
 * health only judges identity for same-worker stamps.
 *
 * Rides `sessionStamp.ts` (#204), same shape as the suppression store
 * above; its validator REPAIRS rather than rejects a stamp whose optional
 * fields are malformed (`url`/`navSeq` coerce to null, which just means
 * health cannot judge document identity). Cross-cleared at the act.ts
 * verdict site; cleared on tab close beside the other per-tab stores.
 */
export interface DeliveryEvidence {
  at: number
  action: string
  url: string | null
  navSeq: number | null
}

const okStore = sessionStamp<DeliveryEvidence>('nymInputOk:', (raw) =>
  typeof raw.at === 'number' && typeof raw.action === 'string'
    ? {
        at: raw.at,
        action: raw.action,
        url: typeof raw.url === 'string' ? raw.url : null,
        navSeq: typeof raw.navSeq === 'number' ? raw.navSeq : null,
      }
    : null,
)

/** An act's trusted input was proven delivered. */
export function recordProvenDelivery(
  tabId: number,
  action: string,
  url: string | null,
  navSeq: number | null,
): void {
  okStore.record(tabId, { at: Date.now(), action, url, navSeq })
}

export function clearProvenDelivery(tabId: number): void {
  okStore.clear(tabId)
}

/** Last delivery-proof evidence for a tab, or null. */
export async function provenDelivery(tabId: number): Promise<DeliveryEvidence | null> {
  return okStore.read(tabId)
}

export function resetForTests(): void {
  resetWorlds()
  pushSlots.clear()
  // The debugger module's own reset clears its event handlers, so the
  // routing latch must drop too or no push would ever route again.
  pushRoutingInstalled = false
}
