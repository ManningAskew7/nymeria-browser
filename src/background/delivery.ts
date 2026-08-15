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
 * document, the top one. Events dispatched inside an iframe never reach the
 * top window, and `chrome_act` deliberately targets iframes (the debugger
 * session module notes that payment fields and consent dialogs almost always
 * live in one). A zero count is therefore not by itself proof of anything: it
 * could mean the event was discarded, or that it landed in a frame this probe
 * never watched. `absenceIsConclusive` asks the follow-up, and only a
 * conclusive absence is allowed to fail a command. That ordering matters
 * because a false "no" is no longer cheap: it tells the agent to abandon a
 * working tab, and it has no way to discover the advice is wrong.
 */

/** `unknown` means we could not prove either way, and is NOT a failure. */
export type DeliveryOutcome = 'yes' | 'no' | 'unknown'

export interface DeliveryReading {
  outcome: DeliveryOutcome
}

export interface DeliveryProbe {
  /** Read the count and disarm. Safe to call once; further calls report unknown. */
  read(): Promise<DeliveryReading>
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
 * Drop a tab's cached world. A committed navigation destroys the isolated
 * world along with the document, so the cached id would resolve to nothing.
 * The creation/caching machinery itself lives in `worlds.ts` (shared with
 * the trust probes' world); this module keeps only its own POLICY.
 */
export function clearWorld(tabId: number): void {
  clearWorldEntry(tabId, DELIVERY_WORLD)
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
      var offs = [];
      for (var i = 0; i < types.length; i++) {
        (function(type){
          var h = function(e){ if (e && e.isTrusted) { n += 1; } };
          window.addEventListener(type, h, true);
          offs.push(function(){ window.removeEventListener(type, h, true); });
        })(types[i]);
      }
      reg[id] = {
        t: now,
        count: function(){ return n; },
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
    var out = { n: p.count() };
    try { p.off(); } catch (e) {}
    delete reg[id];
    return out;
  })(${JSON.stringify(id)})`
}

/** True when this document contains no nested browsing context. */
const FRAMELESS_EXPRESSION = `(function(){
  try { return document.querySelectorAll('iframe,frame').length === 0; }
  catch (e) { return false; }
})()`

async function evaluateInWorld<T>(
  tabId: number,
  contextId: number,
  expression: string,
): Promise<{ ok: true; value: T } | { ok: false; contextGone: boolean }> {
  try {
    const resp = await sendCommand<{
      result?: { value?: T }
      exceptionDetails?: unknown
    }>(tabId, 'Runtime.evaluate', { expression, contextId, returnByValue: true })
    if (resp.exceptionDetails) return { ok: false, contextGone: false }
    return { ok: true, value: resp.result?.value as T }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return { ok: false, contextGone: isContextGone(message) }
  }
}

/** A probe that never armed. Reports `unknown`, never `yes`. */
const UNARMED: DeliveryProbe = {
  read: async () => ({ outcome: 'unknown' }),
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
export async function armDelivery(tabId: number, types: readonly string[]): Promise<DeliveryProbe> {
  let contextId = await worldFor(tabId, DELIVERY_WORLD)
  if (contextId === null) return UNARMED

  nextProbeId += 1
  const id = `p${nextProbeId}`
  const arm = () => armExpression(types, id)
  let armed = await evaluateInWorld<boolean>(tabId, contextId, arm())
  if (!armed.ok && armed.contextGone) {
    // The cached world died with its document. Rebuild once and retry.
    clearWorld(tabId)
    contextId = await createWorld(tabId, DELIVERY_WORLD)
    if (contextId === null) return UNARMED
    armed = await evaluateInWorld<boolean>(tabId, contextId, arm())
  }
  if (!armed.ok || armed.value !== true) return UNARMED

  const world = contextId
  let spent = false
  return {
    async read(): Promise<DeliveryReading> {
      if (spent) return { outcome: 'unknown' }
      spent = true
      const result = await evaluateInWorld<{ n: number } | null>(tabId, world, readExpression(id))
      if (!result.ok) {
        // The context was destroyed between arming and reading, which means the
        // document went away: the action navigated the page. A navigation is
        // proof the input landed, so this is delivery, not ignorance.
        if (result.contextGone) {
          clearWorld(tabId)
          return { outcome: 'yes' }
        }
        return { outcome: 'unknown' }
      }
      const value = result.value
      if (!value || typeof value.n !== 'number') {
        return { outcome: 'unknown' }
      }
      return { outcome: value.n > 0 ? 'yes' : 'no' }
    },
  }
}

/**
 * Can a zero count be believed as "the page received nothing"?
 *
 * Only asked when the probe already counted zero, so it costs nothing on the
 * ordinary path. Two ways to be sure, in order of cost:
 *
 *  - The document has no frames at all, so there was nowhere else for the
 *    event to go.
 *  - There are frames, but the target element is in the top document, which is
 *    the one the probe was watching.
 *
 * Anything else (an untargeted action on a framed page, or a target inside an
 * iframe) is genuinely unknown, and must not be reported as a failure: a
 * cross-origin payment field would otherwise fail every click with advice to
 * open a fresh tab, where it would fail again.
 */
export async function absenceIsConclusive(
  tabId: number,
  target: { session: Cdp; objectId: string } | null,
): Promise<boolean> {
  const contextId = cachedWorld(tabId, DELIVERY_WORLD)
  if (contextId !== undefined) {
    const frameless = await evaluateInWorld<boolean>(tabId, contextId, FRAMELESS_EXPRESSION)
    if (frameless.ok && frameless.value === true) return true
  }
  if (!target) return false
  try {
    const inTop = await callOn<boolean>(
      target.session,
      target.objectId,
      `function(){
        try {
          var w = this.ownerDocument && this.ownerDocument.defaultView;
          return !!w && w === w.top;
        } catch (e) { return false; }
      }`,
    )
    return inTop === true
  } catch {
    return false
  }
}

export function resetForTests(): void {
  resetWorlds()
}
