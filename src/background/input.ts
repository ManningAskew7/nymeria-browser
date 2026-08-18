import { budgetSpent } from './budget'
import { sendCommand, sessionOf, tabOf, type Cdp, type SendCommandOpts } from './debuggerSession'
import { cssMatchCountExpression } from './shadowWalk'

/**
 * Trusted input primitives.
 *
 * The distinction this module exists for: events synthesized from page JS
 * (`el.click()`, `new MouseEvent(...)`) carry `isTrusted: false`. Real sites
 * notice. Payment forms, anti-bot layers, and plenty of ordinary widgets
 * either ignore untrusted events or flag them, which is exactly the class of
 * page the agent most needs to work on.
 *
 * `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` / `Input.insertText`
 * go in at the browser level, so the page cannot tell them from a human. They
 * are coordinate-based, hence the geometry helpers here.
 *
 * Geometry note: element rects come from `getBoundingClientRect()` rather than
 * CDP `DOM.getBoxModel`. Both are CSS pixels but they disagree on coordinate
 * space in ways that vary by Chrome version, whereas `getBoundingClientRect`
 * is unambiguously viewport-relative, which is what `Input.*` wants. Elements
 * inside an iframe report rects relative to THAT frame's viewport, which is
 * exactly the space the frame's own session's `Input.*` wants: cross-frame
 * input dispatches there with the frame-local rect, nothing composes.
 *
 * SAME-PROCESS frames are the one place the two spaces split (reads-honesty
 * pass). Their nodes have no session of their own, so dispatch rides the
 * ROOT session and wants MAIN-frame viewport coordinates, while every
 * in-world probe (hit test, geometry) still answers frame-locally. The root
 * space point comes from `sameProcessDispatchPoint` below: a browser-side
 * `DOM.getContentQuads` read that the root target reports already composed
 * to main-frame space, nested frames included. Two direct measurements, no
 * offset arithmetic, and the page cannot lie to either.
 */

export interface Point {
  x: number
  y: number
}

/**
 * Chrome acks an `Input.dispatch*` command only after the renderer has
 * PROCESSED the event, not when the browser accepts it. A handler that raises
 * a tab-modal dialog synchronously (`alert()` in a click handler is the
 * textbook case, measured live 2026-08-12) therefore blocks the ack itself,
 * and an unguarded await rides the backend's whole 30s transport timeout. No
 * post-dispatch liveness check can help: execution never returns from the
 * dispatch await to reach one.
 *
 * So every dispatch ack gets a wall-clock deadline. Expiry REJECTS with this
 * distinct type rather than resolving null (which is why settle.ts's
 * `withDeadline` is not reused): the event provably reached the page, since
 * its handler running is what suspended the renderer, and that is a different
 * fact with a different recovery than "never sent". A real protocol error
 * must stay distinguishable from it, so rejections pass through unchanged.
 *
 * Single attempt, no retry, for the same reason as RESPONSIVE_DEADLINE_MS: a
 * retried dispatch queues behind the same suspended renderer. The abandoned
 * ack promise keeps its handlers attached, so a late ack (the user dismissing
 * the dialog minutes later) settles silently instead of surfacing as an
 * unhandled rejection.
 */
export class InputDispatchStalled extends Error {
  /**
   * Did the event this stalled on carry the ACTION, or only set up for it?
   *
   * `trustedClick` and `trustedDrag` open with a pointer move, so the first
   * ack that can stall belongs to an event that is not the click. Reporting
   * "the click was sent, do not retry" for a gesture whose press never went
   * out would warn the agent off an action that never happened, which is the
   * same dishonesty in the other direction.
   */
  readonly landed: boolean

  constructor(landed: boolean) {
    super('the renderer did not finish processing the dispatched event')
    this.name = 'InputDispatchStalled'
    this.landed = landed
  }
}

/**
 * The command's wall-clock budget ran out between gestures (#162).
 *
 * Distinct from `InputDispatchStalled` in both mechanism and meaning: no
 * dispatch is hanging, the SUM of many healthy, individually-acked dispatches
 * simply reached the wire budget (`typeText` is two deadlined dispatches per
 * character, so a page spending a second per keystroke overruns a 30s budget
 * on a longish value with every single ack comfortably inside its deadline).
 * The progress fields are the honesty: input DID go in, and the failure copy
 * must say exactly how much, because "re-send the whole thing" against a
 * field holding a partial value is the double-entry bug this exists to
 * prevent.
 *
 * Thrown only at GESTURE BOUNDARIES (before a character, before a press,
 * between the clicks of a double-click), never mid-gesture: aborting between
 * a mousePressed and its mouseReleased would leave the button held in the
 * page, a worse state than spending one more bounded ack to finish cleanly.
 */
export class InputBudgetExhausted extends Error {
  readonly delivered: number
  readonly requested: number
  readonly unit: 'characters' | 'clicks'

  constructor(delivered: number, requested: number, unit: 'characters' | 'clicks') {
    super(`the command's time budget ran out after ${delivered} of ${requested} ${unit}`)
    this.name = 'InputBudgetExhausted'
    this.delivered = delivered
    this.requested = requested
    this.unit = unit
  }
}

/**
 * Deliberately LONGER than settle.ts's RESPONSIVE_DEADLINE_MS, which is the
 * mistake to avoid rather than the pattern to copy.
 *
 * The two look alike and time different quantities. `rendererResponsive` races
 * a trivial `Runtime.evaluate('1')`, which a healthy page answers in
 * single-digit milliseconds whatever it is doing. A dispatch ack does not
 * return until the renderer has run the PAGE'S OWN HANDLERS for that event, so
 * a heavy click handler on an ordinary SPA legitimately spends a second or
 * more here. Giving this the liveness deadline would fail actions that were
 * about to succeed, and inside a batch a false failure aborts every remaining
 * action, which #162 measured as the expensive direction.
 *
 * Still far enough inside the tool layer's 30s that the failure arrives as a
 * useful answer rather than a timeout.
 */
export const DISPATCH_ACK_DEADLINE_MS = 8_000

export function ackWithinDeadline<T>(
  work: Promise<T>,
  opts: { ms?: number; landed?: boolean } = {},
): Promise<T> {
  const ms = opts.ms ?? DISPATCH_ACK_DEADLINE_MS
  const landed = opts.landed ?? true
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new InputDispatchStalled(landed)), ms)
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

export type MouseButton = 'left' | 'right'

const MODIFIER_BITS: Record<string, number> = {
  Alt: 1,
  Ctrl: 2,
  Control: 2,
  Meta: 4,
  Cmd: 4,
  Command: 4,
  Shift: 8,
}

export function modifierMask(mods?: string[]): number {
  if (!mods) return 0
  return mods.reduce((acc, m) => acc | (MODIFIER_BITS[m] ?? 0), 0)
}

/**
 * Translate user-facing key names to the CDP `Input.dispatchKeyEvent` subset.
 * CDP wants a Windows virtual-key code for many control keys.
 */
/**
 * `text` is the CHARACTER the key produces, which is not the key's name.
 *
 * Most of these produce no character at all: Escape and the arrows move or
 * dismiss, they do not insert. Only Enter (a carriage return), Tab and Space
 * do. CDP rejects a `text` longer than one character outright, so sending the
 * NAME ("Enter") fails with `-32602 Invalid 'text' parameter` and the key
 * never reaches the page. Omitting `text` here is meaningful, not lazy.
 */
export const KEY_TABLE: Record<
  string,
  { code: string; key: string; windowsVirtualKeyCode: number; text?: string }
> = {
  Enter: { code: 'Enter', key: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Escape: { code: 'Escape', key: 'Escape', windowsVirtualKeyCode: 27 },
  Tab: { code: 'Tab', key: 'Tab', windowsVirtualKeyCode: 9, text: '\t' },
  Backspace: { code: 'Backspace', key: 'Backspace', windowsVirtualKeyCode: 8 },
  ArrowUp: { code: 'ArrowUp', key: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { code: 'ArrowDown', key: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', key: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { code: 'ArrowRight', key: 'ArrowRight', windowsVirtualKeyCode: 39 },
  PageUp: { code: 'PageUp', key: 'PageUp', windowsVirtualKeyCode: 33 },
  PageDown: { code: 'PageDown', key: 'PageDown', windowsVirtualKeyCode: 34 },
  Home: { code: 'Home', key: 'Home', windowsVirtualKeyCode: 36 },
  End: { code: 'End', key: 'End', windowsVirtualKeyCode: 35 },
  Delete: { code: 'Delete', key: 'Delete', windowsVirtualKeyCode: 46 },
  Space: { code: 'Space', key: ' ', windowsVirtualKeyCode: 32, text: ' ' },
}

/** CDP modifier bits. Shift still produces a character; the others do not. */
const SHIFT_BIT = 8

/**
 * `code` and `windowsVirtualKeyCode` for a single printable character.
 *
 * `KeyboardEvent.keyCode` and `.which` are derived from
 * `windowsVirtualKeyCode`, and omitting it lands them both at 0. A page that
 * gates on either then ignores an event that is trusted, delivered, and to
 * every other appearance correct: the same class of dishonesty as reporting
 * success for input that never arrived.
 *
 * Punctuation is deliberately left bare. Its virtual-key code depends on the
 * keyboard layout, and a wrong one names a different physical key, which is
 * worse than none. The previous fabrication (`Key@`, `Key1`) was never a real
 * `code` value in any layout.
 */
function charKeyInfo(ch: string): { code?: string; windowsVirtualKeyCode?: number } {
  if (/^[a-zA-Z]$/.test(ch)) {
    const upper = ch.toUpperCase()
    return { code: `Key${upper}`, windowsVirtualKeyCode: upper.charCodeAt(0) }
  }
  if (/^[0-9]$/.test(ch)) {
    return { code: `Digit${ch}`, windowsVirtualKeyCode: ch.charCodeAt(0) }
  }
  return {}
}

export async function callOn<T = unknown>(
  target: Cdp,
  objectId: string,
  fn: string,
  args: unknown[] = [],
  opts: SendCommandOpts = {},
): Promise<T> {
  const r = await sendCommand<{ result: { value?: T } }>(
    target,
    'Runtime.callFunctionOn',
    {
      objectId,
      functionDeclaration: fn,
      arguments: args.map((v) => ({ value: v })),
      returnByValue: true,
      awaitPromise: true,
    },
    opts,
  )
  return r.result.value as T
}

/** Scroll the element into view. Best-effort: a detached node just fails. */
export async function scrollIntoView(target: Cdp, objectId: string): Promise<void> {
  await callOn(
    target,
    objectId,
    'function(){ this.scrollIntoView({block: "center", inline: "center", behavior: "instant"}); }',
  )
}

/**
 * Viewport-relative centre of the element, or null when it has no layout box
 * (`display:none`, zero-size, detached). A null here is the signal to fall
 * back to synthetic dispatch rather than to fail: hidden file inputs are a
 * legitimate target and have no box by design.
 */
export async function elementGeometry(target: Cdp, objectId: string): Promise<{ point: Point } | null> {
  const rect = await callOn<{ x: number; y: number; w: number; h: number } | null>(
    target,
    objectId,
    `function(){
      const r = this.getBoundingClientRect();
      if (!r || r.width <= 0 || r.height <= 0) return null;
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
    }`,
  )
  if (!rect) return null
  return { point: { x: rect.x, y: rect.y } }
}

// Frame-offset composition (root-space point = frame-local rect + frame
// origin, dispatched on the ROOT session) lived here until 2026-08-16. It
// was removed, not refactored: root-session Input.* was measured live to
// NEVER reach OOPIF content however the point was composed (2026-08-15),
// and the replacement shape (dispatch on the frame's own session with
// frame-local coordinates) was then measured live to deliver, with the
// per-frame probe confirming arrival. Nothing composes offsets anymore; do
// not reintroduce composition for CROSS-PROCESS frame input.
// `sameProcessDispatchPoint` below is not that: same-process frames DO
// receive root-session input (Chrome routes by position within one
// renderer, measured in frames.test.ts's same-process coordinate case),
// and the root-space point is read directly from the browser, not composed.

/**
 * LOCAL-ROOT viewport centre of a node that lives in a SAME-PROCESS frame,
 * for dispatching that session's input at it. `DOM.getContentQuads` answers
 * in the CSS pixels of the viewport of the SESSION it is asked on, local
 * frames composed however deeply nested, because one renderer owns each
 * local tree; and that is exactly the space the same session's `Input.*`
 * speaks. Asked on the element's OWN session, never the root: backend node
 * ids are per-process, so a nested-in-OOPIF node's id asked on the root
 * session can name an unrelated root-process element and return its quads
 * (the wrong-click class, review round). Null when the node has no quads
 * (hidden, detached, display:none) or the read fails: the caller's
 * no-layout-box fallback (synthetic dispatch, honestly labelled) is
 * exactly the right degraded shape for both.
 */
export async function sameProcessDispatchPoint(
  target: Cdp,
  backendNodeId: number,
): Promise<Point | null> {
  try {
    const resp = await sendCommand<{ quads?: number[][] }>(target, 'DOM.getContentQuads', {
      backendNodeId,
    })
    const quad = resp.quads?.[0]
    if (!quad || quad.length < 8) return null
    const xs = [quad[0], quad[2], quad[4], quad[6]]
    const ys = [quad[1], quad[3], quad[5], quad[7]]
    const x = xs.reduce((a, b) => a + b, 0) / 4
    const y = ys.reduce((a, b) => a + b, 0) / 4
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null
    return { x, y }
  } catch {
    return null
  }
}

export interface HitTest {
  hit: boolean
  /** What the click would land on instead of the target. Set on a miss, and
   *  on an ANCESTOR hit, where it names the ancestor: a caller that treats a
   *  hit as success simply ignores it, and the one caller that cares (a
   *  target which ignores pointer events) needs to name the thing the event
   *  would actually target. */
  blocker?: string
  /** WHICH containment accepted the hit. `ancestor` is the loose one: a
   *  wrapper at the point is normally the same thing as the target for
   *  click purposes, but not when the target cannot receive the click. */
  via?: 'self' | 'descendant' | 'ancestor'
}

/** In-page body of `hitTest`, exported so its containment logic is testable
 *  as executed code rather than an unexercised string.
 *
 *  The point is tested in the TARGET'S OWN ROOT (`getRootNode()`, the
 *  `FOCUS_LANDED_FN` precedent), because `document.elementFromPoint`
 *  RETARGETS a shadow-DOM hit to the shadow HOST while `Node.contains` walks
 *  the node tree and never crosses that boundary: all three checks then fail
 *  and a button inside an open shadow root refuses as "covered by" its own
 *  host. A `ShadowRoot` and a `Document` both implement `elementFromPoint`,
 *  so one expression covers both; a detached node's root implements neither
 *  and falls back to the document, where the answer is a miss either way.
 *  An overlay in the light DOM still reads as a miss from inside a shadow
 *  root (retargeting leaves a document-tree element alone), so the refusal
 *  this exists for is untouched. */
export const HIT_TEST_FN = `function(x, y){
  const root = typeof this.getRootNode === 'function' ? this.getRootNode() : document;
  const scope = root && typeof root.elementFromPoint === 'function' ? root : document;
  const top = scope.elementFromPoint(x, y);
  if (!top) return { hit: false, blocker: 'nothing at point (offscreen?)' };
  const id = top.id ? '#' + top.id : '';
  const cls = typeof top.className === 'string' && top.className
    ? '.' + top.className.trim().split(/\\s+/).slice(0, 2).join('.')
    : '';
  const name = top.tagName.toLowerCase() + id + cls;
  // Guarded like getRootNode above and for the same reason: <form> with a
  // control NAMED contains shadows Node.prototype.contains with an element,
  // and calling it throws out of a probe whose answer gates a refusal.
  const holds = function(a, b){
    try { return typeof a.contains === 'function' && a.contains(b) === true; } catch (e) { return false; }
  };
  if (top === this) return { hit: true, via: 'self' };
  if (holds(this, top)) return { hit: true, via: 'descendant' };
  if (holds(top, this)) return { hit: true, via: 'ancestor', blocker: name };
  return { hit: false, blocker: name };
}`

/**
 * Does a click at `point` actually land on this element?
 *
 * An overlay (cookie banner, modal backdrop, sticky header) intercepting the
 * point is the difference between "clicked the thing" and "clicked the
 * overlay and reported success". Naming the interceptor lets the agent
 * dismiss it instead of retrying blindly.
 *
 * Containment in EITHER direction counts as a hit; what it cannot see is a
 * SIBLING that fronts for the target (a hidden-textarea editor's render
 * surface, a styled checkbox's span). The click guard in act.ts owns that
 * case: text-entry targets get the click delivered and verified by focus,
 * everything else gets a refusal that teaches the deliberate click-through.
 */
export async function hitTest(target: Cdp, objectId: string, point: Point): Promise<HitTest> {
  return callOn<HitTest>(target, objectId, HIT_TEST_FN, [point.x, point.y])
}

/** In-page body of `textEntryTarget`. Keys on what the AX tree can actually
 *  mint a ref to: tag semantics or an explicit role attribute (a div only
 *  computes to an AX textbox via role=), plus contenteditable, which covers
 *  CodeMirror 6. Only CodeMirror 5 still uses the hidden-textarea pattern;
 *  Monaco's EditContext div rides the role branch. The `=== true` on
 *  `isContentEditable` is the worlds.ts named-property rule, not style: a
 *  `<form>` holding a control NAMED `isContentEditable` answers that
 *  element here, which is truthy. */
export const TEXT_ENTRY_FN = `function(){
  const tag = (this.tagName || '').toLowerCase();
  if (tag === 'textarea') return true;
  
  if (tag === 'input') {
    const t = (this.type || 'text').toLowerCase();
    return ['button','submit','reset','checkbox','radio','image','file','range','color'].indexOf(t) === -1;
  }
  if (this.isContentEditable === true) return true;
  const role = ((this.getAttribute && this.getAttribute('role')) || '').toLowerCase();
  return ['textbox','searchbox','combobox'].indexOf(role) !== -1;
}`

/** Is this element a text-entry control (the class whose covered clicks are
 *  delivered and verified rather than refused)? */
export async function textEntryTarget(target: Cdp, objectId: string): Promise<boolean> {
  return callOn<boolean>(target, objectId, TEXT_ENTRY_FN)
}

/**
 * What the act layer needs to know about a target BEFORE it dispatches, all
 * from the one `callFunctionOn` the connectedness check already spends.
 *
 * Every field is OPTIONAL and unknown means unknown: a field the probe could
 * not compute is absent, and callers refuse only on an explicit answer (the
 * fail-open half of the gate contract). Booleans only, nothing page-derived,
 * because these ride out to a backend note that renders outside the
 * untrusted fence.
 */
export interface Actionability {
  /** `isConnected`: the node is still in a document. */
  connected?: boolean
  /** Matches `:disabled`, so the browser will not act on it at all. */
  disabled?: boolean
  /** `readOnly` on an input/textarea: text goes in nowhere. */
  readonly?: boolean
  /** TEXT_ENTRY_FN's verdict, which is what makes `readonly` meaningful. */
  textEntry?: boolean
  /** `checkVisibility({checkOpacity, checkVisibilityCSS})`: visible to the eye. */
  visible?: boolean
  /** The element's computed `pointer-events` is `none`. */
  pointerEventsNone?: boolean
  /** SELECTOR targets only (see `SELECTOR_FACTS_FN`): how many elements the
   *  same selector matches across the scopes the resolution searched. The
   *  selector-native analogue of a ref's mint fingerprint: a selector names a
   *  RULE, and the rule quietly matching fourteen buttons is its real failure
   *  mode. */
  matchCount?: number
  /** SELECTOR targets only: a bound cut the count short, so `matchCount` is a
   *  floor rather than a total. */
  matchCountCapped?: boolean
  /** SELECTOR targets only: the match came from inside a shadow root, so the
   *  document-level query missed and the walk found it. */
  shadowMatch?: boolean
}

/**
 * In-page body of `actionabilityBeforeActing`, exported so its per-field
 * logic runs as executed code in the tests rather than sitting unexercised
 * in a string (the HIT_TEST_FN precedent).
 *
 * Six facts, one call. Each is wrapped in its own try so an element whose
 * one getter throws still answers the rest, and each is written ONLY on a
 * definite answer, so an absent field always means "not known" and can
 * never be read as a refusal.
 *
 * Probe-body discipline (worlds.ts): prototype-backed access only, and every
 * comparison is `=== true` rather than truthiness, which is also what makes
 * named-property shadowing harmless (`<form>` with a control named
 * `readOnly` answers an ELEMENT here, never `true`).
 *
 * `:disabled` rather than `this.disabled`: the pseudo-class is the browser's
 * own computation, so it covers a control disabled by an ancestor
 * `<fieldset disabled>`, which the IDL attribute does not. `aria-disabled`
 * is deliberately NOT consulted: it is page-declared markup that plenty of
 * live widgets carry while still handling clicks, and refusing on it would
 * be a false refusal, where `:disabled` names a control the browser itself
 * will not deliver events to.
 */
export const ACTIONABILITY_FN = `function(){
  const out = { connected: this.isConnected === true };
  try { if (this.matches(':disabled') === true) out.disabled = true; } catch (e) {}
  try { if (this.readOnly === true) out.readonly = true; } catch (e) {}
  try { out.textEntry = (${TEXT_ENTRY_FN}).call(this) === true; } catch (e) {}
  try {
    if (typeof this.checkVisibility === 'function') {
      out.visible = this.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) === true;
    }
  } catch (e) {}
  try {
    const cs = getComputedStyle(this);
    if (cs && cs.pointerEvents === 'none') out.pointerEventsNone = true;
  } catch (e) {}
  return out;
}`

/** Ask the widened pre-dispatch probe. Raw: the caller owns the error policy
 *  (act.ts rethrows session-layer failures and treats everything else as
 *  "not known"). */
export async function actionabilityOf(target: Cdp, objectId: string): Promise<Actionability> {
  return callOn<Actionability>(target, objectId, ACTIONABILITY_FN)
}

/**
 * The same probe for a `css=` / `xpath=` target, plus the two facts only a
 * selector has.
 *
 * Composed from `ACTIONABILITY_FN` rather than duplicating it (the way that
 * function composes `TEXT_ENTRY_FN`), so a selector target gets the SAME six
 * pre-dispatch facts a `@ref` gets from the same one round trip, and the
 * extras ride along for free: the element already knows which root it came
 * from, and re-running the rule in that root counts what else it matched.
 *
 * `kind` decides how to count, because the two spellings have no shared
 * counting call: CSS counts over the scopes the RESOLUTION searched
 * (`cssMatchCountExpression`, the document plus, on a document miss, the
 * open shadow roots), XPath takes a snapshot of the document, which is the
 * only tree it can address and which no shadow boundary can be expressed in,
 * so an xpath target never reports a shadow match.
 *
 * The provenance comes from that same call rather than from the element's
 * `getRootNode()`: the document query is what the RESOLUTION branched on, and
 * a page cannot shadow it the way it can shadow a named DOM property (a
 * `<form>` with a control named `getRootNode` made the fact silently absent,
 * which the backend then rendered as a definite light-DOM match, review
 * round).
 */
export const SELECTOR_FACTS_FN = `function(query, kind){
  const out = (${ACTIONABILITY_FN}).call(this);
  try {
    if (kind === 'css') {
      const counted = ${cssMatchCountExpression('query')};
      out.matchCount = counted.n;
      // A bound cut the search, so the count is a FLOOR. Said out loud, or
      // the number reads as measured.
      if (counted.capped) out.matchCountCapped = true;
      if (counted.shadow) out.shadowMatch = true;
    } else {
      out.matchCount = document.evaluate(
        query, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null
      ).snapshotLength;
    }
  } catch (e) {}
  return out;
}`

/** Ask the selector variant of the pre-dispatch probe. Same error policy as
 *  `actionabilityOf`: the caller owns it. */
export async function selectorFactsOf(
  target: Cdp,
  objectId: string,
  query: string,
  kind: 'css' | 'xpath',
): Promise<Actionability> {
  return callOn<Actionability>(target, objectId, SELECTOR_FACTS_FN, [query, kind])
}

/** In-page body of `focusLandedIn`: did focus end up on, inside, or wrapping
 *  this element? `getRootNode()` first so a target inside a shadow root reads
 *  its own root's activeElement (document.activeElement stops at the host). */
export const FOCUS_LANDED_FN = `function(){
  const root = typeof this.getRootNode === 'function' ? this.getRootNode() : document;
  const a = (root && root.activeElement) || document.activeElement;
  if (!a || a === document.body || a === document.documentElement) return false;
  return a === this || this.contains(a) || a.contains(this);
}`

/**
 * The outcome check behind a clicked-through covered click: editors route a
 * click on their render surface to their real input themselves (CM5 focuses
 * its hidden textarea in its own mousedown handler), so focus landing in the
 * target is the click having worked, and focus anywhere else means the
 * covering element likely consumed it. Measured against Claude for Chrome's
 * harness 2026-08-14: its unverified version types into the void when an
 * editor mis-routes, with a confident success message.
 */
export async function focusLandedIn(target: Cdp, objectId: string): Promise<boolean> {
  return callOn<boolean>(target, objectId, FOCUS_LANDED_FN)
}

/** Bitfield of buttons currently HELD, which is not the same as the button
 *  this event is about. 1 = left, 2 = right, 4 = middle. */
const BUTTON_BIT: Record<string, number> = { left: 1, right: 2, middle: 4, none: 0 }

async function mouseEvent(
  target: Cdp,
  type: 'mouseMoved' | 'mousePressed' | 'mouseReleased',
  point: Point,
  opts: {
    button?: MouseButton
    clickCount?: number
    modifiers?: number
    held?: MouseButton
    /** This event only positions the pointer for the real one that follows. */
    preparatory?: boolean
  } = {},
): Promise<void> {
  const button = opts.button ?? (type === 'mouseMoved' ? 'none' : 'left')
  // Held during a press, and during a drag's intermediate moves; released by
  // definition on mouseReleased.
  const held = opts.held ?? (type === 'mousePressed' ? button : 'none')
  await ackWithinDeadline(
    sendCommand(target, 'Input.dispatchMouseEvent', {
      type,
      x: Math.round(point.x),
      y: Math.round(point.y),
      button,
      buttons: BUTTON_BIT[held] ?? 0,
      clickCount: opts.clickCount ?? (type === 'mouseMoved' ? 0 : 1),
      modifiers: opts.modifiers ?? 0,
    }),
    { landed: !opts.preparatory },
  )
}

/** Move the pointer first so hover handlers fire before the press. */
export async function trustedHover(target: Cdp, point: Point, modifiers = 0): Promise<void> {
  await mouseEvent(target, 'mouseMoved', point, { modifiers })
}

export async function trustedClick(
  target: Cdp,
  point: Point,
  opts: { button?: MouseButton; clickCount?: number; modifiers?: number; deadline?: number | null } = {},
): Promise<void> {
  const button = opts.button ?? 'left'
  const modifiers = opts.modifiers ?? 0
  const clickCount = opts.clickCount ?? 1
  // Preparatory: if a hover handler blocks the main thread here, no button has
  // been pressed yet, so this is a click that did NOT go out.
  await mouseEvent(target, 'mouseMoved', point, { modifiers, preparatory: true })
  for (let n = 1; n <= clickCount; n += 1) {
    // Checked before the press, never between press and release: a click is
    // atomic once its button is down. Between the clicks of a double-click is
    // a boundary, and one delivered click is what the thrown progress says.
    if (budgetSpent(opts.deadline)) throw new InputBudgetExhausted(n - 1, clickCount, 'clicks')
    await mouseEvent(target, 'mousePressed', point, { button, clickCount: n, modifiers })
    await mouseEvent(target, 'mouseReleased', point, { button, clickCount: n, modifiers })
  }
}

export interface DragOutcome {
  /** True when any of the glide moves were skipped for budget. */
  degraded: boolean
  /** Intermediate moves actually dispatched between press and release. */
  movesSent: number
}

export async function trustedDrag(
  target: Cdp,
  from: Point,
  to: Point,
  modifiers = 0,
  deadline?: number | null,
): Promise<DragOutcome> {
  // The caller owns the "can this drag afford to start" question (act.ts
  // refuses pre-dispatch); once the press below goes out, the only good exit
  // is a release, whatever the clock says: a held button is a worse state
  // than a degraded drag.
  await mouseEvent(target, 'mouseMoved', from, { modifiers, preparatory: true })
  await mouseEvent(target, 'mousePressed', from, { button: 'left', clickCount: 1, modifiers })
  // A couple of intermediate moves: drag implementations that listen for
  // movement deltas ignore a single teleporting move.
  const steps = 4
  let movesSent = 0
  for (let i = 1; i <= steps; i += 1) {
    // Budget spent mid-drag: skip the remaining glide moves and go straight
    // to the release at the destination. The degrade is REPORTED, never
    // hidden: with zero moves between press and release, a delta-listening
    // drag implementation sees no movement at all (the only earlier move is
    // the preparatory one at the origin), and Chrome can even read
    // press-here release-there as a plain click on the common ancestor. The
    // caller marks the payload so the agent verifies instead of trusting.
    if (budgetSpent(deadline)) break
    await mouseEvent(
      target,
      'mouseMoved',
      { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps },
      { button: 'left', held: 'left', modifiers },
    )
    movesSent += 1
  }
  await mouseEvent(target, 'mouseReleased', to, { button: 'left', clickCount: 1, modifiers })
  return { degraded: movesSent < steps, movesSent }
}

/**
 * Widgets whose wheel acks are known-desynced (#207). Chromium's
 * MouseWheelEventQueue coalesces a wheel when its queue is two deep, and a
 * coalesced-away wheel NEVER acks while its delta still lands (merged into
 * the queued event); DevTools' per-widget pending-callback FIFO then stays
 * desynced for that widget's lifetime, so every later wheel ack times out
 * too. No protocol command drains it (the Input domain has no disable).
 * The latch caps the cost: the first timeout pays the full deadline once,
 * later wheels on that widget wait only a short tolerance, and an ack
 * arriving again (a recreated widget) clears it.
 */
const wheelAckBroken = new Set<string>()
const WHEEL_ACK_RETRY_MS = 500

function wheelWidgetKey(target: Cdp): string {
  return `${tabOf(target)}:${sessionOf(target) ?? 'root'}`
}

export function resetWheelAckLatchForTests(): void {
  wheelAckBroken.clear()
}

/**
 * Wheel scroll. Lives here rather than at the call site so that every
 * `Input.*` dispatch in the extension goes through this module, and therefore
 * through the ack deadline: a call site that builds its own dispatch is the
 * one that gets forgotten.
 *
 * Unlike every other dispatch, the wheel's ack is NOT load-bearing (#207):
 * a missing ack is the browser mislaying the receipt, not the wheel (see
 * `wheelAckBroken`), so a timeout reports `'timeout'` instead of throwing
 * and the caller's offset verification carries the verdict. A suspended
 * renderer still fails the act at the caller's liveness gate. Non-timeout
 * errors rethrow unchanged.
 */
export async function trustedWheel(
  target: Cdp,
  point: Point,
  delta: { x: number; y: number },
  modifiers = 0,
): Promise<'acked' | 'timeout'> {
  const key = wheelWidgetKey(target)
  const opts = wheelAckBroken.has(key) ? { ms: WHEEL_ACK_RETRY_MS } : {}
  try {
    await ackWithinDeadline(
      sendCommand(target, 'Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: Math.round(point.x),
        y: Math.round(point.y),
        deltaX: delta.x,
        deltaY: delta.y,
        modifiers,
      }),
      opts,
    )
    wheelAckBroken.delete(key)
    return 'acked'
  } catch (e) {
    if (e instanceof InputDispatchStalled) {
      wheelAckBroken.add(key)
      return 'timeout'
    }
    throw e
  }
}

export async function focusElement(target: Cdp, objectId: string): Promise<void> {
  await sendCommand(target, 'DOM.focus', { objectId })
}

/**
 * Insert text as one edit. Generates a real `input` event but no per-character
 * key events, so it is fast and reliable for ordinary fields. Use
 * `typeText` for widgets that listen for keydown.
 */
export async function insertText(target: Cdp, text: string): Promise<void> {
  await ackWithinDeadline(sendCommand(target, 'Input.insertText', { text }))
}

/**
 * One keystroke: `keyDown` then `keyUp`, and nothing in between.
 *
 * Chrome derives the character insertion from `text` on the keyDown itself, so
 * a separate `char` event is not a belt-and-braces addition, it is a second
 * insertion: typing "hi" that way lands "hhii" in the field. A key that
 * produces no character uses `rawKeyDown`, which is how Chrome distinguishes
 * "a key was pressed" from "a character was entered".
 */
export async function dispatchKey(target: Cdp, key: string, modifiers = 0): Promise<void> {
  const entry = KEY_TABLE[key]
  const isChar = !entry && key.length === 1
  // A chord (ctrl+a) presses the key without entering its character; shift is
  // the exception, since shift is how you enter the uppercase one.
  const suppressed = (modifiers & ~SHIFT_BIT) !== 0
  const text = suppressed ? '' : entry ? (entry.text ?? '') : isChar ? key : ''
  const common = {
    modifiers,
    key: entry ? entry.key : key,
    ...(entry
      ? { code: entry.code, windowsVirtualKeyCode: entry.windowsVirtualKeyCode }
      : isChar
        ? charKeyInfo(key)
        : // A named key we do not carry (F1, Insert): its `code` IS its name,
          // so pass it through rather than inventing one.
          { code: key }),
  }
  await ackWithinDeadline(
    sendCommand(target, 'Input.dispatchKeyEvent', {
      type: text ? 'keyDown' : 'rawKeyDown',
      ...common,
      ...(text ? { text } : {}),
    }),
  )
  await ackWithinDeadline(sendCommand(target, 'Input.dispatchKeyEvent', { type: 'keyUp', ...common }))
}

/** Per-character key events, for widgets that need keydown/keyup per key. */
export async function typeText(target: Cdp, text: string, deadline?: number | null): Promise<void> {
  const chars = Array.from(text)
  for (let i = 0; i < chars.length; i += 1) {
    // The #162 case this whole mechanism was filed for: two deadlined
    // dispatches per character means a slow page overruns the wire budget
    // with every individual ack healthy. Checked per character so the throw
    // carries exactly how much of the value is now IN the field.
    if (budgetSpent(deadline)) throw new InputBudgetExhausted(i, chars.length, 'characters')
    await dispatchKey(target, chars[i])
  }
}

/** Select the whole current value so the next insert replaces it. */
export async function selectAllIn(target: Cdp, objectId: string): Promise<void> {
  await callOn(
    target,
    objectId,
    `function(){
      if (typeof this.select === 'function') { this.select(); return; }
      const range = document.createRange();
      range.selectNodeContents(this);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }`,
  )
}
