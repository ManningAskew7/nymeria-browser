import type { CommandResult } from '../../shared/types'
import { readSince as consoleSince } from '../consoleBuffer'
import {
  CdpCallTimeout,
  frameSessionByTargetId,
  frameSessions,
  sendCommand,
  TabUnusable,
  type Cdp,
} from '../debuggerSession'
import { absenceIsConclusive, armDelivery, type DeliveryOutcome } from '../delivery'
import {
  budgetLabel,
  budgetLeft,
  budgetSpent,
  clampToDeadline,
  type ExecContext,
} from '../budget'
import {
  ackWithinDeadline,
  callOn,
  dispatchKey,
  elementGeometry,
  focusElement,
  focusLandedIn,
  hitTest,
  InputBudgetExhausted,
  InputDispatchStalled,
  textEntryTarget,
  insertText,
  modifierMask,
  scrollIntoView,
  selectAllIn,
  trustedClick,
  trustedDrag,
  trustedHover,
  trustedWheel,
  typeText,
  type Point,
} from '../input'
import { commitSeq, commitSince, navigationPending, waitForNavSignal } from '../navWatch'
import {
  evaluateInProbeWorld,
  probeWorldUnavailableError,
  resolveNodeInProbeWorld,
  withProbeWorld,
} from '../worlds'
import { failuresSince as networkFailuresSince } from '../networkBuffer'
import {
  fingerprintNameKey,
  normalizeAxName,
  resolve as resolveRef,
  type StaleReason,
} from '../snapshotRefs'
import { sameDocumentUrl } from '../urlMatch'
import { DEFAULT_MAX_MS, rendererResponsive, settle, type SettleResult } from '../settle'
import {
  chooserInterceptedSince,
  describeResolution,
  dialogAnswerSentence,
  raceStandingDialog,
  resolvedDialogSince,
  standingDialog,
  standingDialogPayload,
  type StandingDialog,
} from '../dialogs'

/**
 * The one action executor.
 *
 * Consolidating click/type/key/scroll/drag/wait into a single command keeps
 * the agent's decision space small (the measured win behind every "fewer
 * tools" result) while the wire stays one round trip per action.
 *
 * Three things every action does that the previous implementation did not:
 * input goes in as TRUSTED browser-level events, the page is allowed to
 * SETTLE before the result returns, and the result carries a VERIFICATION
 * payload so "the click worked" and "the click silently threw" are
 * distinguishable without a second round trip.
 */

export type ActionName =
  | 'click'
  | 'double_click'
  | 'right_click'
  | 'hover'
  | 'fill'
  | 'select'
  | 'check'
  | 'uncheck'
  | 'type'
  | 'key'
  | 'scroll'
  | 'scroll_to'
  | 'drag'
  | 'upload'
  | 'wait'

interface WaitFor {
  text?: string
  ref?: string
  url_contains?: string
}

interface ActArgs {
  tab_id: number
  action: ActionName
  ref?: string
  coordinate?: [number, number]
  value?: string
  modifiers?: string[]
  direction?: 'up' | 'down' | 'left' | 'right'
  amount_px?: number
  to_ref?: string
  wait_for?: WaitFor
  timeout_ms?: number
  // upload
  file_name?: string
  file_mime?: string
  file_base64?: string
}

const DEFAULT_WAIT_MS = 5_000
const WAIT_POLL_MS = 100
const MAX_CONSOLE_IN_RESULT = 5
/**
 * How long verification waits for a STARTED navigation to commit before
 * reporting it as pending instead. Paid only when a navigation the action
 * itself started is in flight at verification time, which is exactly the
 * case where the old payload was garbage (settle resolves 'quiet' on the
 * outgoing document at ~250ms, long before a real commit, so `url_changed`
 * read false on effectively every navigating click). The common
 * non-navigating act never enters this wait. Wait-carrying calls (#168,
 * `action: "wait"` included) pay it like everyone else: the act transport
 * budget reserves +15s beyond the agent's own timeout (chrome_browser.py
 * sizes the override), so the bounded +3s fits, and exempting them was
 * reviewed to cost exactly the honesty this record exists for (a navigating
 * click with a met condition would report `navigation_pending` where its
 * wait-less twin reports `navigated: true`).
 */
const NAV_COMMIT_WAIT_MS = 3_000

/** Actions that operate on an element and therefore need a resolvable target. */
const NEEDS_TARGET: ReadonlySet<ActionName> = new Set<ActionName>([
  'click',
  'double_click',
  'right_click',
  'hover',
  'fill',
  'select',
  'check',
  'uncheck',
  'scroll_to',
  'drag',
  'upload',
])

/** Actions that focus a target first when given one, but work without. */
const OPTIONAL_TARGET: ReadonlySet<ActionName> = new Set<ActionName>(['type', 'key'])

/**
 * Verbs that can act on a bare coordinate. The rest of `NEEDS_TARGET` reject
 * a coordinate-only call further down, so describing the point for them would
 * spend a round trip on a call that is about to be refused.
 */
const ACCEPTS_COORDINATE: ReadonlySet<ActionName> = new Set<ActionName>([
  'click',
  'double_click',
  'right_click',
  'hover',
  'drag',
])

/**
 * Actions that ACTIVATE their target, which is what makes a file input
 * dangerous rather than merely awkward.
 *
 * Membership is about activation, not about pointers: `key` earns a place
 * because Enter or Space on a focused `input[type=file]` opens the chooser
 * exactly as a click does, and `right_click` is absent because a context menu
 * is ordinary browser UI the user can dismiss. `upload` is absent because it
 * is the route this guard exists to send people to.
 */
const ACTIVATES_TARGET: ReadonlySet<ActionName> = new Set<ActionName>([
  'click',
  'double_click',
  'key',
  // These dispatch a real click of their own before falling back, so a file
  // input reached through one opens the chooser just the same.
  'check',
  'uncheck',
])

/**
 * The events each verb must produce in the page, for the delivery probe.
 *
 * Only the verbs that go in through `Input.dispatch*` appear here, because only
 * those traverse the browser-process input gate that a tab-modal dialog closes.
 * `fill` uses `Input.insertText`, an IME commit on a path that does not consult
 * that gate (it demonstrably kept working while every other verb was
 * suppressed), and `select` / `upload` / `scroll_to` run in-page through
 * `Runtime.callFunctionOn` and never touch it. `check` and `uncheck` do dispatch
 * a real click first, but they already verify their own outcome by re-reading
 * the control, which is the precedent this whole mechanism generalises.
 *
 * `mousedown` rather than `click` for the click family: it is the one event
 * every button variant produces, including `right_click`, which yields
 * `contextmenu` instead of `click`.
 *
 * `hover` and `scroll` are deliberately ABSENT. Their events (`mousemove`,
 * `wheel`) are coalesced and frame-aligned rather than discrete, so Blink can
 * dispatch them to the DOM after we have already read the counter, especially
 * in a background or occluded tab, which an agent's tab usually is. A false
 * "no" now fails the command, so a verb that cannot be timed reliably is worse
 * off checked than unchecked.
 */
const PROBE_EVENTS: Partial<Record<ActionName, readonly string[]>> = {
  click: ['mousedown'],
  double_click: ['mousedown'],
  right_click: ['mousedown'],
  drag: ['mousedown'],
  key: ['keydown'],
  type: ['keydown'],
}

/**
 * Verbs whose ref target gets the mint-fingerprint re-check before input is
 * dispatched (#160 review round): everything that ENTERS input or activates
 * the element the agent chose BY MEANING. `hover` and `scroll_to` move
 * nothing into the page; `upload` deliberately targets AX-hidden inputs, so
 * an AX re-read would refuse its legitimate everyday case; `wait` never
 * touches a target.
 */
const FINGERPRINT_VERBS: ReadonlySet<ActionName> = new Set<ActionName>([
  'click',
  'double_click',
  'right_click',
  'fill',
  'type',
  'key',
  'check',
  'uncheck',
  'select',
  'drag',
])

/**
 * What to tell an agent whose input vanished.
 *
 * It cannot see browser UI: a native dialog is invisible to the accessibility
 * tree, to `chrome_console`, to `chrome_network`, and to `chrome_screenshot`
 * (which captures the page compositor surface, not the browser frame). Without
 * being told the recovery it retries the same dead tab indefinitely.
 *
 * The wording hedges on the cause deliberately. Suppression is the likeliest
 * explanation but a disabled control produces the same reading, and asserting a
 * dialog that is not there would send the agent hunting for nothing.
 */
function undeliveredError(action: ActionName): string {
  return (
    `the ${action} was dispatched but the page received no event, so it did nothing. ` +
    'Input to this tab is most likely suppressed, which a browser dialog causes (a ' +
    'password warning, an HTTP auth prompt) and which can OUTLIVE the dialog: the ' +
    'tab keeps discarding input with nothing left on screen to explain it, so do ' +
    'not go looking for one. Recovery, in order: navigate this tab somewhere else, ' +
    'which clears it when a browser dialog is the cause, and if input is still not ' +
    'delivered after that, close the tab and redo the work in a fresh one, which ' +
    'always clears it. Reloading does not help, and never dismiss browser security ' +
    'UI yourself. If the page is fine, the target may instead be disabled or ' +
    'swallowing the event.'
  )
}

/**
 * What to tell an agent whose page will not run a script.
 *
 * Separate from `undeliveredError` because the cause and the recovery both
 * differ: nothing was dispatched here, the page is suspended rather than
 * discarding, and navigating away does NOT reliably fix it (measured
 * 2026-08-11: after navigating away from an `alert()`, scripts ran again but
 * input stayed undelivered).
 *
 * Both candidates are named and neither is asserted. A dialog and a
 * long-running script are indistinguishable from out here, and the compared
 * Chrome extension's equivalent messages each assert one wrong cause
 * ("showing error page", "page still loading"), which its own operator had to
 * decode. Say what was observed, list what does it, give both recoveries.
 */
/**
 * Resource types that are telemetry-shaped: their failures are routine on
 * busy sites (beacons show up as Ping, tracker pixels as Image) and must
 * never crowd a broken first-party POST out of the capped report.
 */
const TELEMETRY_TYPES = new Set(['Ping', 'Beacon', 'Image', 'Media', 'Font', 'Prefetch', 'CSPViolationReport'])

/**
 * How many recent failures the ranking considers before the cap is applied.
 * Wider than the cap so a data-class failure buried under a burst of
 * telemetry noise is still in the pool to be ranked above it; bounded so a
 * pathological page cannot make every act result O(all failures ever).
 */
const FAILURE_RANK_POOL = 50

function sameOriginAs(url: string, pageUrl: string | null): boolean | undefined {
  if (!pageUrl) return undefined
  try {
    return new URL(url).origin === new URL(pageUrl).origin
  } catch {
    // Either side unparseable: say nothing rather than guess (#166).
    return undefined
  }
}

/**
 * The capped failed-requests report, classified and ranked (#166, from the
 * 2026-08-15 QA round: a successful upload's payload carried five failed
 * third-party telemetry beacons in the field where a broken first-party POST
 * would show, drowning the one signal that matters).
 *
 * Each entry is annotated `same_origin` against the page URL (omitted when
 * either side does not parse), and the cap is filled by RANK, not recency
 * alone: data-class failures (XHR, Fetch, Document...) before
 * telemetry-shaped types, same-origin before cross-origin within the class.
 * Origin alone would demote a first-party API on its own api.* domain; type
 * alone would keep third-party fetch beacons; the combination plus the
 * visible annotations covers both. Most-recent wins within a rank, and the
 * final list reads chronologically.
 */
function classifiedFailures(
  tabId: number,
  since: number,
  pageUrl: string | null,
): Record<string, unknown>[] {
  const raw = networkFailuresSince(tabId, since, FAILURE_RANK_POOL)
  const annotated = raw.map((e) => {
    const so = sameOriginAs(e.url, pageUrl)
    return {
      entry: { ...e, ...(so === undefined ? {} : { same_origin: so }) },
      rank: (TELEMETRY_TYPES.has(e.resource_type ?? '') ? 2 : 0) + (so === false ? 1 : 0),
    }
  })
  annotated.sort((a, b) => a.rank - b.rank || b.entry.ts - a.entry.ts)
  const chosen = annotated.slice(0, MAX_CONSOLE_IN_RESULT)
  chosen.sort((a, b) => a.entry.ts - b.entry.ts)
  return chosen.map((c) => c.entry as unknown as Record<string, unknown>)
}

/**
 * The evidence a stalled page cannot stop us collecting.
 *
 * Console lines and failed requests come from local buffers fed by CDP events,
 * so they need nothing from the suspended renderer. They are also the only
 * thing that separates the two causes the stall message refuses to choose
 * between: an uncaught page error next to a stall points at a script, silence
 * points at a dialog. A failure that drops them is a worse trade than the
 * silent success this whole mechanism replaced. `pageUrl` feeds the
 * same-origin classification; null (not yet known) just omits it.
 */
function localDiagnostics(
  tabId: number,
  startedAt: number,
  pageUrl: string | null,
): Record<string, unknown> {
  const errors = consoleSince(tabId, startedAt, { only_errors: true, limit: MAX_CONSOLE_IN_RESULT })
  const failedRequests = classifiedFailures(tabId, startedAt, pageUrl)
  return {
    ...(errors.length ? { console_errors: errors } : {}),
    ...(failedRequests.length ? { failed_requests: failedRequests } : {}),
  }
}

/**
 * What to tell an agent whose action landed and then killed the page.
 *
 * Distinct from `stalledError` in the one way that matters: the input WAS
 * dispatched, so the action may well have taken effect. Telling the agent
 * nothing was sent would invite a retry that double-submits.
 */
function dispatchedThenStalledError(action: ActionName): string {
  return (
    `the ${action} was sent, and the page then stopped running scripts, so what it ` +
    'did could not be verified. Two things do that, and this does not say which: the ' +
    'action raised a dialog (a "Leave site?" on a form with unsaved changes, or a ' +
    "confirm() in the page's own handler), or its own handler is still running and " +
    'has blocked the page for several seconds. DO NOT simply retry either way: the ' +
    'action may already have taken effect, and repeating it could submit twice. Read ' +
    'the tab to see what happened, in a fresh one if this one stays stuck, or ask the ' +
    'user what is on their screen.'
  )
}

/**
 * Is this element the one control that can wedge the user's whole browser?
 *
 * Activating an `input[type=file]` opens the NATIVE OS file chooser. That is
 * not browser UI: no CDP domain sees it, no extension API dismisses it, and
 * on Windows it blocks the owning browser window until a human clicks it. It
 * is the only element on a page whose activation is unrecoverable from here,
 * which is why it earns a check the rest do not.
 *
 * The chooser is ALSO intercepted page-wide while attached (#169:
 * `Page.setInterceptFileChooserDialog`, armed per attach in
 * `debuggerSession.ts`), so this element check is no longer the only wall.
 * It stays because refusing BEFORE dispatch is strictly better where it can
 * see the input: the refusal teaches the upload route without spending the
 * action, where interception can only report after the click already ran.
 */
async function isFileInput(session: Cdp, objectId: string): Promise<boolean> {
  return (
    (await callOn<boolean>(session, objectId, `function(){ ${OPENS_FILE_CHOOSER} }`)) === true
  )
}

/**
 * Does activating this element open the file chooser?
 *
 * Three routes, and the direct one is the LEAST likely to be met. An agent
 * reads the accessibility tree, and a `display:none` input is absent from it,
 * so what the agent gets a ref for is the visible affordance in front of the
 * input. A `<label for=...>` is therefore checked through `.control`, and an
 * ancestor label through `.closest`, because activating either forwards to the
 * input exactly as clicking it does.
 *
 * The route this CANNOT see is `<button onclick="input.click()">`: nothing
 * static distinguishes it from any other button. That one is caught by the
 * page-wide chooser interception instead (#169), which PREVENTS the picker
 * and reports it after the fact (see `fileChooserInterceptedError`).
 */
const OPENS_FILE_CHOOSER = `
  const isFile = (el) => !!el && el.tagName === 'INPUT' && el.type === 'file';
  if (isFile(this)) return true;
  if (this.tagName === 'LABEL' && isFile(this.control)) return true;
  const label = this.closest && this.closest('label');
  return !!label && isFile(label.control);
`

/**
 * Name an element the way a human would point at it: `button "Sign in"`,
 * `input#email`, `div.cookie-banner`, or bare `body`.
 *
 * Text is the trap here, and the first version fell into it. `innerText` is
 * SUBTREE text, so a click on empty background produced
 * `body "Acme Home About Contact Sign in ..."`: the words of everything the
 * click did NOT hit, which reads as a confident hit on real content and
 * inverts the field's whole purpose. Hence three rules: never take text from
 * `body`/`html`, prefer explicit labelling attributes, and accept text only
 * when it is short enough to BE a label (a container's text runs long, a
 * button's does not). `textContent` rather than `innerText` also avoids
 * forcing a synchronous layout in the user's page.
 *
 * Structure carries the rest, following `hitTest`'s precedent of identifying
 * a blocker by tag/id/class rather than by prose.
 */
const DESCRIBE_ELEMENT = `
  try {
    const tag = this.tagName.toLowerCase();
    let raw = this.getAttribute('aria-label') || this.getAttribute('name')
      || this.getAttribute('placeholder') || this.getAttribute('alt')
      || this.getAttribute('title') || '';
    if (!raw && tag !== 'body' && tag !== 'html') {
      const text = String(this.textContent || '').trim().replace(/\\s+/g, ' ');
      if (text && text.length <= 60) raw = text;
    }
    const label = String(raw || '').trim().replace(/\\s+/g, ' ').slice(0, 60).replace(/"/g, "'");
    const id = this.id ? '#' + String(this.id).slice(0, 40) : '';
    const cls = (!id && this.classList && this.classList.length)
      ? '.' + String(this.classList[0]).slice(0, 40) : '';
    return label ? tag + id + cls + ' "' + label + '"' : tag + id + cls;
  } catch (e) {
    return 'unknown';
  }
`

interface PointTarget {
  /** Human-readable: `button "Sign in"`, or just `body`. */
  description: string
  opensFileChooser: boolean
  /** The point stopped at an `<iframe>`/`<frame>` element: the root document
   *  cannot see inside it, and if it is CROSS-ORIGIN the coordinate act can
   *  never reach it either (root-session input was measured never to arrive
   *  there, 2026-08-15). */
  frameOwner: boolean
}

/**
 * What is actually under a coordinate, and whether activating it opens the
 * file chooser. One evaluate answers both, so the description is free.
 *
 * The description exists because `input_delivered` cannot answer the question
 * an agent asks after a coordinate click. The delivery counter listens at
 * `window` in the capture phase, so a click on empty page background produces
 * a trusted `click` event that reaches it and COUNTS: the report is
 * `input_delivered: "yes"`, true by its own definition and useless. Measured
 * on the official Claude in Chrome extension 2026-08-12 (comparison doc,
 * experiment 2): its viewport resized itself between turns, a click at a
 * now-stale coordinate landed on blank margin, and the payload said only
 * "Clicked at (65, 146)". Naming what was under the point makes that
 * self-evident (`hit: "body"`) instead of a confident nothing.
 *
 * Runs in the PROBE WORLD (#160), so `elementFromPoint` and the getters the
 * description reads are the pristine built-ins: a page that overrides them in
 * its own world can no longer delete the coordinate-path file-input refusal
 * or forge what the point landed on. Failing to answer still counts as NOT a
 * file input (a probe that cannot run must not block an otherwise valid
 * click; the page-wide chooser interception is the backstop), and it never
 * re-runs in the main world.
 */
async function describePoint(tabId: number, point: Point | null): Promise<PointTarget | null> {
  if (!point) return null
  // The verdict is computed FIRST and the description is separately guarded,
  // so an element whose getters throw loses the label and keeps the safety
  // answer. The other order let a hostile `textContent` getter delete the
  // file-input refusal (pre-world history, kept on principle: the world
  // protects the PRIMITIVES, not a page-defined getter the description walks
  // into via named access).
  const value = await evaluateInProbeWorld<PointTarget | null>(
    tabId,
    `(() => {
      const el = document.elementFromPoint(${Math.round(point.x)}, ${Math.round(point.y)});
      if (!el) return null;
      const opens = (function(){ ${OPENS_FILE_CHOOSER} }).call(el) === true;
      const description = (function(){ ${DESCRIBE_ELEMENT} }).call(el);
      const frameOwner = /^(iframe|frame)$/i.test(el.tagName || '');
      return { description: String(description || 'unknown'), opensFileChooser: opens, frameOwner: frameOwner };
    })()`,
  )
  return value ?? null
}

/**
 * Which ATTACHED cross-origin frame satisfies `ownerPredicate` about its
 * `<iframe>` owner element in the ROOT document, or null (a frame owner that
 * matches no attached session is same-process, whose input still rides the
 * root). Owner handles are minted in the root PROBE world, so a page cannot
 * forge the answer that gates a refusal. `ownerPredicate` receives the extra
 * args after the owner element as `this`.
 */
async function matchFrameOwner(
  tabId: number,
  ownerPredicate: string,
  args: unknown[] = [],
): Promise<{ sessionId: string; targetId: string; url: string } | null> {
  for (const frame of frameSessions(tabId)) {
    try {
      const owner = await sendCommand<{ backendNodeId?: number }>(tabId, 'DOM.getFrameOwner', {
        frameId: frame.targetId,
      })
      if (!owner.backendNodeId) continue
      const resolved = await resolveNodeInProbeWorld(tabId, owner.backendNodeId)
      if (!resolved.ok) continue
      const hit = await callOn<boolean>(tabId, resolved.objectId, ownerPredicate, args)
      if (hit === true) return frame
    } catch (e) {
      // Session-layer failures rethrow like everywhere else in this file: a
      // timed-out or unusable tab answering NO frame checks is not "no frame
      // matched", and swallowing it here made the coordinate refusal fail
      // OPEN (dispatching root input into an OOPIF it could not rule out).
      if (e instanceof CdpCallTimeout || e instanceof TabUnusable) throw e
      // One unanswerable frame must not veto the others.
    }
  }
  return null
}

/** Does a ROOT-document point land on this frame's owner element? */
const OWNER_AT_POINT_FN = 'function(x, y){ return document.elementFromPoint(x, y) === this; }'

/** Does the ROOT document's focus rest on this frame's owner element? */
const OWNER_HAS_FOCUS_FN = 'function(){ return document.activeElement === this; }'

/**
 * A coordinate act aimed into a cross-origin frame: refused BEFORE dispatch.
 * Bare coordinates ride the root session, which was measured (2026-08-15,
 * twice, eyewitness-confirmed) never to deliver into an out-of-process
 * frame, so proceeding would be a knowing no-op wearing a trusted success.
 * The working route always exists: the frame's contents have their own refs.
 */
function crossOriginFrameCoordinateError(action: ActionName, frameUrl: string): string {
  return (
    `the ${action} coordinate lands inside a cross-origin frame (${frameUrl}), ` +
    'which receives its own input separately from the page around it: a bare ' +
    'coordinate cannot reach it and the event would silently vanish. Nothing ' +
    'was dispatched. Read the page and use the element\'s @ref instead (the ' +
    "frame's contents appear as their own labelled section with refs)."
  )
}

/**
 * The signature here is the AGENT-FACING one (`path`), not the wire args this
 * file receives. `file_name`/`file_base64` exist only after the backend has
 * read the workspace file, so naming them would send the agent to a call that
 * is rejected for an unknown parameter, in the one message whose entire job is
 * to redirect it onto the route that works.
 */
function fileInputRefusal(target: string | null): string {
  return (
    `refusing to click ${target ?? 'that element'}: it is a file input, and clicking ` +
    'one opens the operating system\'s file chooser. That window is not part of the ' +
    'browser, nothing here can close it, and it blocks the user until they dismiss it ' +
    'themselves. Use chrome_act(action="upload", ref=..., path="...") instead, which ' +
    'puts the file straight into the input and works even when it is hidden behind a ' +
    'styled button.'
  )
}

/**
 * What to tell an agent whose action tried to open the OS file chooser and
 * was stopped by the page-wide interception (#169).
 *
 * `Page.setInterceptFileChooserDialog` is armed for the whole attach (it
 * needs the same `Page.enable` the dialog ownership rides, which is what
 * kept it a silent no-op before this pass), so while the agent is driving,
 * NO picker can open in this tab: Chrome emits `Page.fileChooserOpened`
 * instead, whatever the route (a JS-driven upload button, an iframe, a
 * closed shadow root, `showPicker()`, a click the page deferred). The
 * wording can therefore say the picker did NOT open, which the old
 * detection-only message had to hedge on; what it must still say is that
 * the action itself ran, so repeating it is the wrong move.
 */
function fileChooserInterceptedError(action: ActionName, target: string | null): string {
  return (
    `the ${action} on ${target ?? 'that element'} tried to open the operating ` +
    "system's file chooser. It was intercepted: no picker opened and the user's " +
    'browser is fine, but the page is now waiting for a file selection that will ' +
    `never arrive. Do not repeat the ${action}; it already ran and each repeat ` +
    'just re-triggers the chooser. To attach a file, find the file input behind ' +
    'this control (usually hidden, so pass a css= ref) and use ' +
    'chrome_act(action="upload", ref=..., path="..."), which puts the file ' +
    'straight into the input.'
  )
}

/**
 * A covered point on a target that is NOT text entry: refuse, but teach both
 * exits (#174). The blocker may be a genuine overlay, or it may be the
 * target's own widget fronting for it (a styled checkbox's span, an editor
 * render surface on a target the classifier missed), and the guard cannot
 * tell those apart, so the copy names both and hands over the exact
 * coordinate for a deliberate click-through instead of dead-ending.
 *
 * `point` is null for a target inside a cross-origin frame: a bare-coordinate
 * act dispatches on the root session, which was measured (2026-08-15, live)
 * never to reach OOPIF content, so handing over a coordinate there would
 * teach a guaranteed no-op. The frame exit is the covering element's own ref.
 */
function coveredPointError(
  action: ActionName,
  target: string | null,
  blocker: string | undefined,
  point: { x: number; y: number } | null,
): string {
  let override: string
  if (!point) {
    override =
      're-read the page and target the covering element by its own @ref ' +
      '(coordinate clicks cannot reach inside a cross-origin frame)'
  } else {
    const x = Math.round(point.x)
    const y = Math.round(point.y)
    // check/uncheck are ref-only verbs, so "repeat with coordinate" would be
    // refused on arrival; their exit is a plain click plus a state read.
    override =
      action === 'check' || action === 'uncheck'
        ? `click it deliberately with action="click" and coordinate=[${x}, ${y}] ` +
          '(no ref), then re-read the control to confirm its state changed'
        : `repeat the ${action} with coordinate=[${x}, ${y}] and no ref to ` +
          'click it deliberately. For text entry, fill or type on the ref ' +
          'works without any click'
  }
  return (
    `the ${action} point for ${target ?? 'that element'} is covered by ` +
    `${blocker ?? 'another element'}. If that is a real overlay (cookie ` +
    'banner, modal, sticky header), dismiss it or scroll it out of the way ' +
    "and retry. If it looks like part of the target's own widget (a styled " +
    `control, an editor surface), the covering element is what a person ` +
    `would click: ${override}.`
  )
}

/**
 * A drag whose source and destination live in different documents (one in a
 * cross-origin frame, the other outside it, or in a different frame). One
 * pointer stream goes to ONE session, and the root-session alternative was
 * measured never to deliver into an OOPIF, so there is no honest way to
 * perform this drag. Refused with nothing dispatched.
 */
function crossFrameDragError(source: string | null, destRef: string): string {
  return (
    `drag cannot cross a frame boundary: ${source ?? 'the source'} and ` +
    `${destRef} live in different documents (a cross-origin frame receives ` +
    'its own input, separately from the page around it). Nothing was ' +
    'dispatched. Drag between two elements inside the same document, or use ' +
    "the page's own move/reorder controls if it offers them."
  )
}

/**
 * The covered click on a TEXT-ENTRY target was delivered (editors route a
 * surface click to their real input themselves, so refusing was the wrong
 * move) but focus did not land in the target, which is the one observable
 * that separates "the editor took it" from "the covering element consumed
 * it". Honest failure, side effect included: the click happened.
 */
function clickedThroughButFocusMissedError(
  action: ActionName,
  target: string | null,
  blocker: string | undefined,
): string {
  return (
    `the ${action} was delivered at ${target ?? 'the target'}'s point, but ` +
    `${blocker ?? 'a covering element'} was over it and focus did not land ` +
    'in the target, so the covering element likely received the click. ' +
    'Re-read the page to see what changed before retrying or typing.'
  )
}

/**
 * The act was blocked BEFORE dispatch by a dialog we own (#169). Unlike
 * `stalledError`, the cause is known by name, and so is the remedy.
 */
function dialogBlockedActError(action: ActionName, tabId: number, d: StandingDialog): string {
  return (
    `the ${action} was NOT sent: the tab is showing a ${d.type} dialog: ` +
    `"${d.message}". The page is paused until it is answered. ` +
    `${dialogAnswerSentence(tabId, d)}, then retry.`
  )
}

/**
 * A dialog opened DURING the dispatch and the ack stalled before the event
 * carrying the action was confirmed. Delivery is genuinely UNKNOWN here: ack
 * order is not a delivery oracle (measured live in the #169 QA run, where a
 * click whose confirm() opened mid-dispatch stalled the MOVE ack while the
 * press had plainly been processed). Claiming NOT-sent invites a
 * double-submit; claiming delivered invites skipping a needed redo. So this
 * copy says the truth: answer, re-read, then decide.
 */
function dialogInterruptedActError(action: ActionName, tabId: number, d: StandingDialog): string {
  return (
    `the ${action} was dispatched exactly as a ${d.type} dialog opened: ` +
    `"${d.message}". The page paused before Chrome confirmed the input, so ` +
    `whether the ${action} was processed first is unknown. ` +
    `${dialogAnswerSentence(tabId, d)}. Then RE-READ the page to see whether ` +
    `the ${action} took effect, and only repeat it if it did not.`
  )
}

/**
 * The act itself raised a dialog we now own, and the dialog is standing.
 *
 * A SUCCESS, deliberately: the input was delivered and did what inputs do,
 * and the next move (answer the dialog) is named in the payload. Failing the
 * act here would tell the agent its click did not work, inviting the retry
 * that double-submits; the #162 precedent is that the payload distinguishes
 * delivery from outcome.
 */
function pendingDialogResult(
  action: ActionName,
  target: string | null,
  tabId: number,
  d: StandingDialog,
  inputMode: 'trusted' | 'synthetic' | 'none',
  startedAt: number,
  pageUrl: string | null,
  extra: Record<string, unknown>,
): CommandResult {
  return {
    ok: true,
    status: 'success',
    data: {
      action,
      ...(target ? { target } : {}),
      input: inputMode,
      dialog: {
        ...standingDialogPayload(tabId, d),
        note:
          `your ${action} raised this ${d.type} dialog and the page is paused ` +
          `on it. ${dialogAnswerSentence(tabId, d)}. Do not repeat the ` +
          `${action}; it was delivered.`,
      },
      ...extra,
      ...localDiagnostics(tabId, startedAt, pageUrl),
    },
  }
}

/**
 * A ref that resolves to a node no longer in the document.
 *
 * Blink's `DOMNodeId` map holds a `WeakRef` keyed on GC LIVENESS, not on
 * attachment, so `DOM.resolveNode` succeeds for a node the page removed but
 * still holds a reference to (React caching a component's element is the
 * everyday case). Acting on it runs the page's own handler against a detached
 * node: the handler fires, CDP reports success, and nothing changes on
 * screen. That is the silent-success shape this whole arc exists to remove,
 * so the check moved BEFORE the action; `target_exists` still reports the
 * same fact afterwards for the cases that detach mid-action.
 */
function detachedRefError(target: string | null, action: ActionName): string {
  return (
    `${target ?? 'that element'} still resolves, but the element is no longer in the ` +
    'page: it was removed after the page was read (a re-render, a closed modal, a list ' +
    `that reloaded). The ${action} was NOT sent, because acting on a detached node ` +
    'does not do what you meant: the page handler runs against nothing, and for a ' +
    'typing action the text goes to whatever else holds focus. Re-read the page and ' +
    'use a fresh ref.'
  )
}

interface FingerprintDrift {
  kind: 'changed' | 'hidden'
  was: string
  now: string
}

function axString(v?: { value?: unknown }): string {
  if (!v || v.value == null) return ''
  return typeof v.value === 'string' ? v.value : String(v.value)
}

function describeAxPair(role: string, name: string): string {
  if (role && name) return `${role} "${name}"`
  return role || (name ? `"${name}"` : 'an unnamed element')
}

/**
 * Has the element's MEANING changed since the ref was minted (#160 review
 * round)? `isConnected` catches a node the page removed; it cannot catch a
 * LIVE node the page repurposed: a framework re-render reusing the DOM node
 * for a different list row, a "Confirm" relabeled "Delete". The mint-time
 * accessibility role+name is re-read here through the SAME browser-side
 * computation that minted it (`Accessibility.getPartialAXTree`), and a
 * mismatch refuses before any input goes out.
 *
 * Fail-open on probe ERROR (a probe that cannot run must not block; the
 * detached and delivery checks still stand), fail-closed on MISMATCH.
 * Session-layer failures (`CdpCallTimeout`, `TabUnusable`) RETHROW: they are
 * about the tab, not the probe, and swallowing them here would let a dying
 * tab's action proceed to dispatch with the honest copy those classes carry
 * discarded. An empty mint name compares role only, so unnamed controls are
 * not bounced on the label they never had. Names compare DIGIT-INSENSITIVELY
 * (`fingerprintNameKey`): a counter or price ticking between read and act is
 * the same element, a reworded label is not.
 */
async function fingerprintDrift(
  session: Cdp,
  backendNodeId: number,
  mintRole: string,
  mintName: string,
): Promise<FingerprintDrift | null> {
  try {
    const resp = await sendCommand<{
      nodes?: {
        backendDOMNodeId?: number
        ignored?: boolean
        role?: { value?: unknown }
        name?: { value?: unknown }
      }[]
    }>(session, 'Accessibility.getPartialAXTree', { backendNodeId, fetchRelatives: false })
    const nodes = resp.nodes ?? []
    const node = nodes.find((n) => n.backendDOMNodeId === backendNodeId) ?? nodes[0]
    if (!node) return null
    const was = describeAxPair(mintRole, mintName)
    if (node.ignored) return { kind: 'hidden', was, now: 'hidden' }
    const role = axString(node.role)
    const name = normalizeAxName(axString(node.name))
    const roleChanged = Boolean(mintRole) && Boolean(role) && role !== mintRole
    const nameChanged = Boolean(mintName) && fingerprintNameKey(name) !== fingerprintNameKey(mintName)
    if (!roleChanged && !nameChanged) return null
    return { kind: 'changed', was, now: describeAxPair(role, name) }
  } catch (e) {
    if (e instanceof CdpCallTimeout || e instanceof TabUnusable) throw e
    return null
  }
}

/**
 * A ref that resolves to a live element whose accessibility identity no
 * longer matches its mint. Refusing here is the strict half of the ref
 * contract: a false bounce costs one re-read, a false pass clicks the wrong
 * MEANING with full confidence.
 */
function refChangedError(
  target: string | null,
  action: ActionName,
  drift: FingerprintDrift,
): string {
  return (
    `${target ?? 'that ref'} still exists, but the element changed since you read the ` +
    `page: it was ${drift.was}, it is now ${drift.now}. The ${action} was NOT sent, ` +
    'because acting on an element whose meaning changed is how the wrong thing gets ' +
    'clicked. Re-read the page and use the ref for what you now mean to act on. ' +
    '(Purely numeric ticks are tolerated; if this label legitimately rewords itself ' +
    'continuously, target the element with css= instead of a ref.)'
  )
}

function refHiddenError(target: string | null, action: ActionName): string {
  return (
    `${target ?? 'that ref'} still exists, but the element is no longer visible to ` +
    'the accessibility tree (hidden or collapsed since you read the page). The ' +
    `${action} was NOT sent. Re-read the page and use a fresh ref.`
  )
}

/**
 * The one fingerprint gate, shared by the main target and the drag
 * destination so the refusal shape cannot drift between them. Returns the
 * refusal to send, or null when the target may be acted on (including refs
 * minted without a fingerprint: css=/xpath= targets have none to compare).
 * `refName` is the ref the copy blames; `label` prefixes it for secondary
 * targets ("drag destination: "); `data.target` stays the command's primary
 * target either way, matching the pre-existing payload shape.
 */
async function fingerprintRefusal(
  resolution: Extract<TargetResolution, { ok: true }>,
  action: ActionName,
  primaryTarget: string | null,
  refName: string,
  label = '',
): Promise<CommandResult | null> {
  if (resolution.backendNodeId === undefined || (!resolution.mintRole && !resolution.mintName)) {
    return null
  }
  const drift = await fingerprintDrift(
    resolution.session,
    resolution.backendNodeId,
    resolution.mintRole ?? '',
    resolution.mintName ?? '',
  )
  if (!drift) return null
  const base =
    drift.kind === 'hidden' ? refHiddenError(refName, action) : refChangedError(refName, action, drift)
  return {
    ok: false,
    status: 'error',
    error: `${label}${base}`,
    data: {
      action,
      target: primaryTarget,
      stale_refs: true,
      reason: drift.kind,
      element_was: drift.was,
      element_now: drift.now,
    },
  }
}

function stalledError(action: ActionName): string {
  // Reached only when NO owned dialog is recorded for the tab: an owned one
  // returns `dialogBlockedActError` with the dialog named instead. So if a
  // dialog is the cause here, it predates the attach and chrome_dialog
  // genuinely cannot answer it (ownership cannot be taken retroactively).
  return (
    `the ${action} was NOT sent: this tab did not run a script for several seconds, ` +
    'so it could not have received input. Two things do that. A dialog raised ' +
    'BEFORE this session touched the tab (alert, confirm, prompt, or a "Leave ' +
    'site?") suspends it until answered, and chrome_dialog cannot answer that ' +
    'one (dialogs are only answerable when raised while the extension is ' +
    'attached): close the tab and redo the work in a fresh one. A long-running ' +
    'script suspends it temporarily: wait a few seconds and retry, and if the ' +
    'retry reports this again it is the dialog.'
  )
}

/**
 * Failure copy for a mid-gesture budget overrun (#162). The whole point of
 * the wall-clock budget is that this copy arrives INSTEAD of the backend's
 * payload-less transport timeout, so it must carry what that timeout could
 * not: exactly how much input is now in the page, and what to do about it.
 */
function budgetExhaustedMidActionError(
  action: ActionName,
  e: InputBudgetExhausted,
  budgetMs: number | null,
): string {
  const budget = budgetLabel(budgetMs)
  if (e.unit === 'characters') {
    return (
      `${budget} ran out while typing: ${e.delivered} of ${e.requested} characters were ` +
      'delivered, so the field now holds a PARTIAL value. Re-read it before continuing, ' +
      'and finish the remainder rather than re-sending the whole text. If the page is ' +
      'just slow, retry with a larger timeout_ms.'
    )
  }
  // clicks. Zero delivered means the budget died on the FIRST press check:
  // nothing went out, and "mid-action" or "what state that left the control
  // in" would both be claims about input that never happened.
  if (e.delivered === 0) {
    return (
      `${budget} ran out before the ${action}'s click was pressed: nothing was ` +
      'delivered. The pre-flight steps consumed it, which usually means the tab is ' +
      'responding very slowly. Retry, with a larger timeout_ms if it persists.'
    )
  }
  return (
    `${budget} ran out mid-${action}: ${e.delivered} of ${e.requested} clicks were ` +
    'delivered. Re-read the page to see what state that left the control in before retrying.'
  )
}

/** The pre-dispatch twin: the budget went on pre-flight, so nothing went out. */
function budgetExhaustedBeforeDispatchError(action: ActionName, budgetMs: number | null): string {
  return (
    `${budgetLabel(budgetMs)} ran out before the ${action}'s input was sent: NOTHING was ` +
    'delivered. The pre-flight steps (attach, liveness, target resolution) consumed it, ' +
    'which usually means the tab is responding very slowly. Retry, with a larger ' +
    'timeout_ms if it persists.'
  )
}

type TargetResolution =
  /** `session` is the CDP addressee that OWNS the node: a cross-origin frame
   *  has its own session, and its objectIds are meaningless anywhere else.
   *  `backendNodeId` and the mint fingerprint ride along for `@` refs only,
   *  so the pre-dispatch drift check can re-ask the AX tree about the SAME
   *  node the ref was minted from. */
  | {
      ok: true
      objectId: string
      session: Cdp
      /** Stable target id of the owning cross-origin frame (refs only). */
      frameTargetId?: string
      backendNodeId?: number
      mintRole?: string
      mintName?: string
    }
  | { ok: false; error: string; stale?: StaleReason }

async function currentUrl(tabId: number): Promise<string | null> {
  try {
    const tab = await chrome.tabs.get(tabId)
    return tab?.url ?? null
  } catch {
    return null
  }
}

// The probe world could not be created: fail CLOSED, never fall back to the
// main world (a main-world resolution is exactly the steerable read #160
// exists to remove). Copy lives in worlds.ts beside the rule.

/**
 * Resolve a target to a CDP Runtime objectId, minted IN the probe world.
 *
 * `@e5`      -> snapshot ref, validated against the URL it was minted on
 * `css=...`  -> document.querySelector, evaluated in the probe world
 * `xpath=...`-> document.evaluate, evaluated in the probe world
 *
 * The world is the point (#160): every later read AND mutation runs through
 * `Runtime.callFunctionOn` on this one handle, so minting it in the isolated
 * world gives the whole act pristine primitives a hostile page cannot
 * override. A stale ref returns a typed error naming the fix rather than
 * resolving a backendNodeId that now points into a different document.
 */
async function resolveTarget(
  tabId: number,
  target: string,
  url: string | null,
): Promise<TargetResolution> {
  if (target.startsWith('@')) {
    const resolution = resolveRef(tabId, target, url)
    if (!resolution.ok) {
      return { ok: false, error: resolution.detail, stale: resolution.reason }
    }
    // A frame ref names its frame by STABLE target id; the ephemeral session
    // is looked up here, at use time, because the idle detach kills sessions
    // between commands while the frame (and the ref) live on. A frame that
    // never re-announces within the wait is genuinely gone.
    let session: Cdp = tabId
    if (resolution.frameTargetId) {
      const live = await frameSessionByTargetId(tabId, resolution.frameTargetId)
      if (!live) {
        return {
          ok: false,
          error:
            `the frame that ${target} lives in is no longer part of the page ` +
            '(it navigated away or was removed). Re-read the page for current refs.',
          stale: 'frame-gone',
        }
      }
      // Same target id, different document: the frame NAVIGATED since the
      // mint. The ref's backendNodeId belongs to the document it was minted
      // in, and a cross-process swap starts a fresh counter that can hand
      // the same number to an unrelated element, so resolving it would risk
      // the wrong-click class this store exists to prevent. (In-process
      // navigations need no check here: the old ids simply stop resolving.)
      if (resolution.frameUrl && live.url && !sameDocumentUrl(resolution.frameUrl, live.url)) {
        return {
          ok: false,
          error:
            `the frame that ${target} lives in navigated from ${resolution.frameUrl} ` +
            `to ${live.url} since the page was read. Re-read the page for current refs.`,
          stale: 'navigated',
        }
      }
      session = { tabId, sessionId: live.sessionId }
    }
    try {
      const resolved = await resolveNodeInProbeWorld(session, resolution.backendNodeId)
      if (!resolved.ok) {
        // The two failures tell DIFFERENT stories: no-node is about the ref
        // (the element is gone, re-reading helps), no-world is about the
        // probe infrastructure (nothing about the element was learned, and a
        // stale_refs flag here would send the agent re-reading in a loop).
        // Naming the frame case matters (2026-08-15 QA): a persistent frame
        // failure read as "mid-navigation" gets dismissed as transient.
        if (resolved.reason === 'no-world') {
          const what = resolution.frameTargetId
            ? 'resolving the element inside its cross-origin frame'
            : 'resolving the element'
          return { ok: false, error: probeWorldUnavailableError(what) }
        }
        return {
          ok: false,
          error: `ref ${target} no longer exists in the page (re-read the page)`,
          stale: 'unknown-ref',
        }
      }
      return {
        ok: true,
        objectId: resolved.objectId,
        session,
        frameTargetId: resolution.frameTargetId,
        backendNodeId: resolution.backendNodeId,
        mintRole: resolution.role,
        mintName: resolution.name,
      }
    } catch (e) {
      // A session-layer failure is about the TAB, not the ref: telling the
      // agent to re-read the page would send it into the same wall with worse
      // advice appended. Rethrow and let the dispatch layer surface the
      // message these classes already carry (which names the actual remedy).
      // The css=/xpath= branch below does not catch at all, so this keeps the
      // two branches consistent for these errors.
      if (e instanceof CdpCallTimeout || e instanceof TabUnusable) throw e
      return {
        ok: false,
        error: `ref ${target} no longer resolves (${String(e)}); re-read the page`,
        stale: 'unknown-ref',
      }
    }
  }
  if (target.startsWith('css=') || target.startsWith('xpath=')) {
    const isCss = target.startsWith('css=')
    const query = isCss ? target.slice(4) : target.slice(6)
    const expression = isCss
      ? `document.querySelector(${JSON.stringify(query)})`
      : `document.evaluate(${JSON.stringify(query)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue`
    const evald = await withProbeWorld(tabId, (contextId) =>
      sendCommand<{ result: { objectId?: string; subtype?: string } }>(tabId, 'Runtime.evaluate', {
        expression,
        returnByValue: false,
        contextId,
      }),
    )
    if (evald === null) {
      return { ok: false, error: probeWorldUnavailableError(`the ${isCss ? 'css' : 'xpath'} lookup`) }
    }
    if (!evald.result.objectId || evald.result.subtype === 'null') {
      return { ok: false, error: `${isCss ? 'css selector' : 'xpath'} matched no element: ${query}` }
    }
    return { ok: true, objectId: evald.result.objectId, session: tabId }
  }
  return {
    ok: false,
    error: `target must start with @, css=, or xpath= (got: ${target.slice(0, 40)})`,
  }
}

interface FocusedDescription {
  tag: string
  label: string
  /** Set when focus rests on a cross-origin frame: the description above is
   *  then the FRAME'S OWN focused element, read through its session, and
   *  this names which frame. Without the descent the payload stopped at
   *  `tag: "iframe"`, which live QA misread twice as a failed click. */
  frame_url?: string
}

const DESCRIBE_FOCUSED_EXPRESSION = `(function(){
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return null;
  const raw = el.getAttribute('aria-label') || el.getAttribute('name')
    || el.getAttribute('placeholder') || (el.innerText || '');
  return { tag: el.tagName.toLowerCase(), label: String(raw || '').trim().slice(0, 60) };
})()`

async function describeFocused(tabId: number): Promise<FocusedDescription | null> {
  try {
    const resp = await sendCommand<{ result?: { value?: FocusedDescription | null } }>(
      tabId,
      'Runtime.evaluate',
      { expression: DESCRIBE_FOCUSED_EXPRESSION, returnByValue: true },
    )
    const top = resp.result?.value ?? null
    if (!top || (top.tag !== 'iframe' && top.tag !== 'frame')) return top
    // Focus rests on a frame owner: descend ONE level when it is an attached
    // cross-origin frame, so the payload names the element that actually
    // holds focus instead of the wall in front of it.
    const frame = await matchFrameOwner(tabId, OWNER_HAS_FOCUS_FN)
    if (!frame) return top
    const inner = await sendCommand<{ result?: { value?: FocusedDescription | null } }>(
      { tabId, sessionId: frame.sessionId },
      'Runtime.evaluate',
      { expression: DESCRIBE_FOCUSED_EXPRESSION, returnByValue: true },
    )
    const innerValue = inner.result?.value
    return innerValue
      ? { ...innerValue, frame_url: frame.url }
      : { ...top, frame_url: frame.url }
  } catch {
    return null
  }
}

/** Where ref-less keystrokes go: the frame holding focus, else the root.
 *  Keyboard input has no coordinates; what it has is a focused element, and
 *  when that element lives in a cross-origin frame, root-session key events
 *  never arrive (the measured wall). Following focus keeps the "type
 *  continues at the caret" contract across the frame boundary. */
async function keyboardSessionForFocus(tabId: number): Promise<Cdp> {
  // Cheap gate before the per-frame scan: only when the ROOT document's own
  // focus rests on a frame owner can the caret be inside a cross-origin
  // frame, so anything else answers with one evaluate instead of three CDP
  // calls per attached frame.
  try {
    const resp = await sendCommand<{ result?: { value?: FocusedDescription | null } }>(
      tabId,
      'Runtime.evaluate',
      { expression: DESCRIBE_FOCUSED_EXPRESSION, returnByValue: true },
    )
    const top = resp.result?.value ?? null
    if (!top || (top.tag !== 'iframe' && top.tag !== 'frame')) return tabId
  } catch (e) {
    if (e instanceof CdpCallTimeout || e instanceof TabUnusable) throw e
    // An unanswerable gate keeps the pre-frames behavior: type at the root.
    return tabId
  }
  const frame = await matchFrameOwner(tabId, OWNER_HAS_FOCUS_FN)
  return frame ? { tabId, sessionId: frame.sessionId } : tabId
}

async function stillConnected(session: Cdp, objectId: string | null): Promise<boolean | null> {
  if (!objectId) return null
  try {
    return await callOn<boolean>(session, objectId, 'function(){ return this.isConnected === true; }')
  } catch {
    // The context went away (navigation). Not an error, just unknowable.
    return null
  }
}

/**
 * The same question, asked BEFORE acting, where a session-layer failure must
 * not be swallowed.
 *
 * `stillConnected` is deliberately tolerant because it also runs after the
 * action, where an unanswerable probe is just a missing field. Here it gates
 * a dispatch: if the tab went unusable or the call rode its full 15s deadline
 * between resolution and now, "unknown, carry on" would send input into a tab
 * we already know is not answering, and burn most of the command's budget
 * first. Same rule `resolveTarget` follows for the same two classes.
 */
async function connectedBeforeActing(session: Cdp, objectId: string): Promise<boolean | null> {
  try {
    return await callOn<boolean>(session, objectId, 'function(){ return this.isConnected === true; }')
  } catch (e) {
    if (e instanceof CdpCallTimeout || e instanceof TabUnusable) throw e
    return null
  }
}

interface VerificationInput {
  action: ActionName
  target: string | null
  tabId: number
  startedAt: number
  urlBefore: string | null
  /** `commitSeq(tabId)` sampled beside `urlBefore`, before the action. */
  navSeqBefore: number
  objectId: string | null
  elementSession: Cdp
  inputMode: 'trusted' | 'synthetic' | 'none'
  settleResult: SettleResult | null
  /** The command's wall-clock deadline (#162), or null. Required so a new
   *  call site cannot silently opt out of the budget. */
  budgetDeadline: number | null
  previousValue?: string | null
  extra?: Record<string, unknown>
}

async function buildVerification(v: VerificationInput): Promise<Record<string, unknown>> {
  // The browser-process navigation record is what makes `url_changed`
  // truthful: settle resolves on the OUTGOING document, so without this a
  // navigating click reads its own old URL back and reports false. A commit
  // that already landed needs no wait; a navigation STARTED SINCE THE ACT
  // BEGAN (the time filter is the attribution: an unrelated load already in
  // flight is not this action's doing) gets a bounded one; everything else
  // pays nothing. Any non-commit signal (abort, same-document move, tab
  // close) ends the wait early rather than riding it out.
  let commit = commitSince(v.tabId, v.navSeqBefore)
  if (!commit && navigationPending(v.tabId, v.startedAt)) {
    // Clamped to the remaining budget (#162): the commit wait is bounded
    // anyway, but past the deadline every millisecond here is one the honest
    // payload does not have.
    const commitWait =
      v.budgetDeadline === null
        ? NAV_COMMIT_WAIT_MS
        : Math.max(0, Math.min(NAV_COMMIT_WAIT_MS, v.budgetDeadline - Date.now()))
    const signal = await waitForNavSignal(v.tabId, v.navSeqBefore, v.startedAt, commitWait)
    if (signal?.kind === 'commit') commit = { url: signal.url, seq: signal.seq }
  }
  const pending = commit ? null : navigationPending(v.tabId, v.startedAt)
  const urlAfter = await currentUrl(v.tabId)
  // Budget spent AFTER the input went in: verification gets cheaper, the
  // delivered action is never failed for it (#162). The renderer-bound
  // enrichment probes are skipped; everything local (url, nav record,
  // console, network) still reports, and `budget_clamped` marks the skip so
  // the absent fields read as "not asked", never "not there".
  const enrichmentSkipped = budgetSpent(v.budgetDeadline)
  const [targetExists, focused] = enrichmentSkipped
    ? [null, null]
    : await Promise.all([
        stillConnected(v.elementSession, v.objectId),
        describeFocused(v.tabId),
      ])
  const errors = consoleSince(v.tabId, v.startedAt, {
    only_errors: true,
    limit: MAX_CONSOLE_IN_RESULT,
  })
  // A request that came back 500 without throwing is the commonest silent
  // failure on a real site, and it never reaches the console. Classified and
  // ranked against the page the action ran ON (#166): the failures in this
  // window were issued by the urlBefore document, so when the action
  // navigated, judging them against urlAfter would misclassify the very POST
  // whose failure explains the move (review round).
  const failedRequests = classifiedFailures(v.tabId, v.startedAt, v.urlBefore ?? urlAfter)
  return {
    action: v.action,
    ...(v.target ? { target: v.target } : {}),
    url: urlAfter,
    // Post-commit, so a navigating click reports true. The plain comparison
    // also keeps SPA pushState URL changes truthful (they change the tab URL
    // with no cross-document commit).
    url_changed: Boolean(v.urlBefore && urlAfter && v.urlBefore !== urlAfter),
    // A cross-document commit `url_changed` cannot see (same-URL
    // re-navigation) still reads `navigated: true`.
    ...(commit ? { navigated: true } : {}),
    // Started, not yet committed at the bound: the honest in-between. Never
    // asserted as arrived; re-read shortly.
    ...(pending ? { navigation_pending: pending.url } : {}),
    ...(targetExists === null ? {} : { target_exists: targetExists }),
    ...(v.previousValue === undefined ? {} : { previous_value: v.previousValue }),
    ...(focused ? { focused } : {}),
    input: v.inputMode,
    ...(v.settleResult ? { settled: v.settleResult } : {}),
    ...(errors.length ? { console_errors: errors } : {}),
    ...(failedRequests.length ? { failed_requests: failedRequests } : {}),
    ...(enrichmentSkipped ? { budget_clamped: true } : {}),
    ...(v.extra ?? {}),
  }
}

function pointFrom(coordinate?: [number, number]): Point | null {
  if (!coordinate || coordinate.length !== 2) return null
  const [x, y] = coordinate
  if (typeof x !== 'number' || typeof y !== 'number') return null
  return { x, y }
}

/** Read the current value of a form control before we change it. */
async function readValue(session: Cdp, objectId: string): Promise<string | null> {
  try {
    return await callOn<string | null>(
      session,
      objectId,
      `function(){
        if (this.type === 'checkbox' || this.type === 'radio') return String(this.checked);
        if (this.value !== undefined && this.value !== null) return String(this.value);
        return this.textContent === null ? null : String(this.textContent).slice(0, 200);
      }`,
    )
  } catch {
    return null
  }
}

async function performWait(
  tabId: number,
  waitFor: WaitFor | undefined,
  timeoutMs: number,
): Promise<{ found: boolean; condition: string }> {
  const deadline = Date.now() + timeoutMs
  // Conditions are OR'd: the first to hold wins and is the one NAMED, so a
  // `found: true` is never a claim about a condition that was not met. Only
  // a timeout names them all.
  const parts: string[] = []
  if (waitFor?.text) parts.push(`text:${waitFor.text}`)
  if (waitFor?.ref) parts.push(`ref:${waitFor.ref}`)
  if (waitFor?.url_contains) parts.push(`url_contains:${waitFor.url_contains}`)

  if (!waitFor || parts.length === 0) {
    const result = await settle(tabId, { maxMs: timeoutMs })
    return { found: result.settled, condition: 'settle' }
  }
  const allConditions = parts.join(' | ')

  for (;;) {
    if (waitFor.url_contains) {
      const url = await currentUrl(tabId)
      if (url && url.includes(waitFor.url_contains)) {
        return { found: true, condition: `url_contains:${waitFor.url_contains}` }
      }
    }
    if (waitFor.text) {
      // Probe world (#160): this answer GATES a batch, so a page faking the
      // condition met would charge a whole batch onward. A failed evaluate
      // (world churn mid-wait) keeps polling until the deadline.
      const seen = await evaluateInProbeWorld<boolean>(
        tabId,
        `document.body ? document.body.innerText.includes(${JSON.stringify(waitFor.text)}) : false`,
      )
      if (seen === true) return { found: true, condition: `text:${waitFor.text}` }
    }
    if (waitFor.ref) {
      try {
        const url = await currentUrl(tabId)
        const target = await resolveTarget(tabId, waitFor.ref, url)
        if (target.ok) {
          const connected = await stillConnected(target.session, target.objectId)
          if (connected !== false) return { found: true, condition: `ref:${waitFor.ref}` }
        }
      } catch {
        // Same class as the text branch, and it matters more here: a `css=`
        // resolve is a bare evaluate that rejects during a navigation or a
        // debugger detach, and post-#168 this loop runs AFTER input was
        // dispatched, so a throw escaping it would lose the verification
        // payload and read as "nothing was sent". Keep polling instead.
      }
    }
    if (Date.now() >= deadline) return { found: false, condition: allConditions }
    await new Promise((r) => setTimeout(r, WAIT_POLL_MS))
  }
}

export async function execAct(args: unknown, ctx?: ExecContext): Promise<CommandResult> {
  const a = args as ActArgs
  if (typeof a.tab_id !== 'number') return { ok: false, status: 'error', error: 'tab_id required' }
  if (!a.action) return { ok: false, status: 'error', error: 'action required' }

  const tabId = a.tab_id
  const startedAt = Date.now()
  // #162: the wire budget as one wall clock over the whole command. Every
  // stage below is individually bounded, but bounds are ADDITIVE: a cold
  // attach plus geometry plus per-character dispatches plus settle plus the
  // verification probes can each stay inside its own deadline and still sum
  // past the transport timeout, whose backend copy carries NO payload. The
  // budget converts that into an in-time honest answer: input helpers throw
  // `InputBudgetExhausted` at gesture boundaries (a failure naming exact
  // progress), and post-dispatch stages clamp or skip (a delivered action is
  // never failed by its verification getting cheaper).
  const budgetDeadline = ctx?.deadline ?? null
  const budgetMs = ctx?.budgetMs ?? null
  const budgetLeftMs = () => budgetLeft(budgetDeadline)
  const clampToBudget = (ms: number) => clampToDeadline(ms, budgetDeadline)

  // FIRST, before anything that touches the renderer.
  //
  // A dialog the page raised suspends the renderer, and every step below queues
  // behind it: target resolution (`DOM.resolveNode`, or a bare `Runtime.evaluate`
  // for a `css=`/`xpath=` selector), the delivery arm, and settle, whose own
  // deadline is IN-PAGE and therefore never ticks. A dialog WE own (#169) is
  // named outright with its answer route; the liveness probe stays behind it
  // for the causes ownership cannot see (a pre-attach dialog, a long-running
  // script). It covers every action, not just the ones with probeable events.
  const preDialog = standingDialog(tabId)
  if (preDialog) {
    return {
      ok: false,
      status: 'error',
      error: dialogBlockedActError(a.action, tabId, preDialog),
      data: {
        action: a.action,
        dialog: standingDialogPayload(tabId, preDialog),
        ...localDiagnostics(tabId, startedAt, null),
      },
    }
  }
  if (!(await rendererResponsive(tabId))) {
    return {
      ok: false,
      status: 'error',
      error: stalledError(a.action),
      data: { action: a.action, ...localDiagnostics(tabId, startedAt, null) },
    }
  }

  const urlBefore = await currentUrl(tabId)
  const navSeqBefore = commitSeq(tabId)
  const modifiers = modifierMask(a.modifiers)
  const target = a.ref ?? null

  // `wait` never mutates the page, so it skips target resolution and settle.
  if (a.action === 'wait') {
    // #162: this branch returns before the pre-dispatch checkpoint below, so
    // it carries its own. A spent clock is named as the BUDGET: "wait timed
    // out" would blame the page for a wait that never ran.
    if (budgetLeftMs() <= 0) {
      return {
        ok: false,
        status: 'error',
        error: budgetExhaustedBeforeDispatchError('wait', budgetMs),
        data: {
          action: 'wait',
          url: urlBefore,
          budget_exhausted: true,
          input: 'none',
          ...localDiagnostics(tabId, startedAt, urlBefore),
        },
      }
    }
    // timeout_ms <= 0 is treated as unset, matching the backend's reading.
    // Clamped to the command budget (#162): outside a batch the backend
    // sizes the budget to fit the wait, so the clamp is a no-op; inside
    // one, the shared clock is the honest bound, and a clamped window that
    // misses is marked so the miss is never read as the page's failure.
    const askedWaitMs =
      typeof a.timeout_ms === 'number' && a.timeout_ms > 0 ? a.timeout_ms : DEFAULT_WAIT_MS
    const waitWindowMs = clampToBudget(askedWaitMs)
    // Raced against a dialog opening mid-wait (#169): the poll loop's
    // evaluates would otherwise queue behind the suspended renderer and burn
    // the whole timeout learning nothing, when the cause is known by name
    // the moment it opens.
    const raced = await raceStandingDialog(tabId, performWait(tabId, a.wait_for, waitWindowMs))
    if (raced.kind === 'dialog') {
      const d = raced.dialog
      return {
        ok: false,
        status: 'error',
        error:
          `the wait was interrupted: a ${d.type} dialog opened: "${d.message}". ` +
          `The page is paused on it. ${dialogAnswerSentence(tabId, d)}.`,
        data: {
          action: 'wait',
          dialog: standingDialogPayload(tabId, d),
          ...localDiagnostics(tabId, startedAt, urlBefore),
        },
      }
    }
    const { found, condition } = raced.value
    const waitClamped = waitWindowMs < askedWaitMs
    const data = await buildVerification({
      action: 'wait',
      target: null,
      tabId,
      startedAt,
      urlBefore,
      navSeqBefore,
      objectId: null,
      elementSession: tabId,
      inputMode: 'none',
      settleResult: null,
      budgetDeadline,
      extra: {
        condition,
        found,
        waited_ms: Date.now() - startedAt,
        ...(waitClamped && !found ? { budget_clamped: true } : {}),
      },
    })
    return {
      ok: found,
      status: found ? 'success' : 'error',
      data,
      ...(found
        ? {}
        : {
            error: waitClamped
              ? `wait timed out on ${condition} after ~${waitWindowMs}ms: the window was ` +
                `clamped from ${askedWaitMs}ms by the command's time budget, so the ` +
                'condition may not have been watched long enough to appear'
              : `wait timed out on ${condition}`,
          }),
    }
  }

  let objectId: string | null = null
  // Default addressee is the root page session; a ref inside a cross-origin
  // frame swaps this for that frame's session.
  let elementSession: Cdp = tabId
  let elementFrameTargetId: string | undefined
  /** What a bare coordinate landed on, for the verification payload. */
  let pointTarget: PointTarget | null = null
  if (NEEDS_TARGET.has(a.action) || (OPTIONAL_TARGET.has(a.action) && target)) {
    const explicitPoint = pointFrom(a.coordinate)
    if (NEEDS_TARGET.has(a.action) && !target && !explicitPoint) {
      return { ok: false, status: 'error', error: `action "${a.action}" requires ref or coordinate` }
    }
    if (target) {
      const resolution = await resolveTarget(tabId, target, urlBefore)
      if (!resolution.ok) {
        return {
          ok: false,
          status: 'error',
          error: resolution.error,
          data: resolution.stale ? { stale_refs: true, reason: resolution.stale } : undefined,
        }
      }
      // BEFORE anything is sent: a resolvable ref is not a live one. See
      // `detachedRefError`. `null` (the context went away) is unknowable, not
      // a refusal, and falls through to the action's own honest failure.
      // Only for `@` refs: `css=`/`xpath=` go through `querySelector`, which
      // returns connected nodes by construction, so the check would spend a
      // round trip to say what the resolution already proved, and its
      // "use a fresh ref" advice names something the caller never used.
      if (
        target.startsWith('@') &&
        (await connectedBeforeActing(resolution.session, resolution.objectId)) === false
      ) {
        return {
          ok: false,
          status: 'error',
          error: detachedRefError(target, a.action),
          data: { action: a.action, target, stale_refs: true, reason: 'detached' },
        }
      }
      // The mint-fingerprint re-check, for the verbs that dispatch input into
      // the element the agent chose by meaning. Only refs minted WITH a
      // fingerprint are checked (css=/xpath= targets have none to compare),
      // and only before dispatch, where refusing still honestly means
      // nothing was sent.
      if (FINGERPRINT_VERBS.has(a.action)) {
        const refusal = await fingerprintRefusal(resolution, a.action, target, target)
        if (refusal) return refusal
      }
      objectId = resolution.objectId
      elementSession = resolution.session
      elementFrameTargetId = resolution.frameTargetId
    }

    // Checked HERE rather than inside the click case, so it covers every verb
    // that activates a target rather than the one that happens to be commonest.
    // Coordinate targets are checked too: a vision-fallback click onto a
    // visible "Choose File" button reaches the same chooser, and is the shape
    // most likely to hit one, since a coordinate is used precisely when the
    // agent could not resolve a ref to look at.
    // One evaluate for a coordinate target, answering both the guard below and
    // `hit` in the payload. Run for the coordinate-capable verbs whether or
    // not they activate: knowing a hover landed on `body` is the same
    // information, and it is the same call either way.
    if (!objectId && ACCEPTS_COORDINATE.has(a.action)) {
      pointTarget = await describePoint(tabId, explicitPoint)
    }

    // A coordinate whose point stops at a frame owner: if that frame is an
    // attached CROSS-ORIGIN one, the trusted pointer verbs refuse before
    // dispatch (known no-op, see crossOriginFrameCoordinateError). A frame
    // owner matching no attached session is same-process and proceeds as
    // always; scroll stays exempt (its miss is a visible root-scroll, not a
    // silent nothing).
    // pointTarget only exists for ACCEPTS_COORDINATE verbs (the guard above),
    // which is exactly the refusable set; scroll is not among them, so its
    // exemption is structural, not a listed-out condition.
    if (!objectId && explicitPoint && pointTarget?.frameOwner) {
      const frame = await matchFrameOwner(tabId, OWNER_AT_POINT_FN, [
        Math.round(explicitPoint.x),
        Math.round(explicitPoint.y),
      ])
      if (frame) {
        return {
          ok: false,
          status: 'error',
          error: crossOriginFrameCoordinateError(a.action, frame.url),
          data: {
            action: a.action,
            refused: 'cross_origin_frame_coordinate',
            hit: pointTarget.description,
            frame_url: frame.url,
            input: 'none',
          },
        }
      }
    }

    if (ACTIVATES_TARGET.has(a.action)) {
      const onFileInput = objectId
        ? await isFileInput(elementSession, objectId)
        : pointTarget?.opensFileChooser === true
      if (onFileInput) {
        return {
          ok: false,
          status: 'error',
          // A coordinate refusal has no ref to quote, but it does know what
          // it found there, which is the whole point of having looked.
          error: fileInputRefusal(target ?? pointTarget?.description ?? null),
          data: {
            action: a.action,
            target,
            refused: 'file_input',
            ...(pointTarget ? { hit: pointTarget.description } : {}),
          },
        }
      }
    }
  }

  // Input for a ref dispatches on the ELEMENT'S OWN session with the
  // element's own frame-local coordinates: `elementSession` is the root for
  // a main-document ref and the frame's flattened session for an OOPIF ref,
  // and `elementGeometry` reads the rect in that same session, so geometry
  // and dispatch share one coordinate space end to end and nothing composes.
  // The old shape (root-session dispatch at root coordinates composed via
  // `frameOffset`, trusting Chrome to hit-test the point into the frame's
  // widget) was measured live 2026-08-15 to NEVER deliver into an OOPIF on
  // the user's Chrome: every event acked ok and nothing arrived, while
  // main-document input landed concurrently in the same tab.

  let inputMode: 'trusted' | 'synthetic' | 'none' = 'none'
  let previousValue: string | null | undefined
  const extra: Record<string, unknown> = {}
  // Only ever set for a coordinate act: a ref act already names its target,
  // and `target_exists` answers the same question for it more directly. On a
  // drag the point is the SOURCE, so it is named as such rather than left to
  // read as "what the drag hit".
  if (pointTarget) extra[a.action === 'drag' ? 'hit_from' : 'hit'] = pointTarget.description

  // #162: the last pre-dispatch checkpoint. Pre-flight (attach, liveness,
  // resolution, geometry) spends against the same wall clock as everything
  // else; when it consumed the whole budget, say NOTHING was delivered and
  // mean it, before a probe is armed or any input goes out.
  if (budgetLeftMs() <= 0) {
    return {
      ok: false,
      status: 'error',
      error: budgetExhaustedBeforeDispatchError(a.action, budgetMs),
      data: {
        action: a.action,
        ...(target ? { target } : {}),
        url: urlBefore,
        budget_exhausted: true,
        input: 'none',
        ...localDiagnostics(tabId, startedAt, urlBefore),
      },
    }
  }

  // Armed AFTER target resolution so the probe cannot count our own setup: the
  // geometry and hit-test reads run in-page, and neither produces any of the
  // event types above. (The chooser watcher that used to ride this probe is
  // gone: `Page.fileChooserOpened` + interception cover every route it could
  // see and the ones it could not; see `fileChooserInterceptedError`.)
  const probeTypes = PROBE_EVENTS[a.action]
  // Ref-less keystrokes follow the page's FOCUS, including into a
  // cross-origin frame (keyboardSessionForFocus in the type/key cases).
  // Resolved here, before the probe arms, so the probe watches the same
  // document the keys actually enter; armed at the root, an in-frame
  // ref-less type would count zero and shrug "unknown" forever.
  const keyboardSession: Cdp | null =
    !objectId && (a.action === 'type' || a.action === 'key')
      ? await keyboardSessionForFocus(tabId)
      : null
  // Armed on the session the input will ride: the frame's own for a frame
  // ref, the focused frame's for ref-less keystrokes, the root otherwise.
  // Arming the root for an in-frame act was the pre-2026-08-16 shape, and
  // it made every in-frame verdict a permanent "unknown": the exact blind
  // spot the measured silent no-op hid behind.
  const probeTarget: Cdp = objectId ? elementSession : keyboardSession ?? tabId
  const probe = probeTypes ? await armDelivery(probeTarget, probeTypes) : null

  try {
    switch (a.action) {
      case 'click':
      case 'double_click':
      case 'right_click': {
        const button = a.action === 'right_click' ? 'right' : 'left'
        const clickCount = a.action === 'double_click' ? 2 : 1
        const explicitPoint = pointFrom(a.coordinate)
        if (objectId) {
          await scrollIntoView(elementSession, objectId)
          const geo = await elementGeometry(elementSession, objectId)
          if (geo) {
            const ht = await hitTest(elementSession, objectId, geo.point)
            let clickThrough: string | null = null
            if (!ht.hit) {
              // #174: a hidden-input editor's render surface (CodeMirror 5,
              // Monaco) is a SIBLING of the real input, so containment can
              // never accept it. A click there is exactly what a person
              // does, and the editor routes it to its input itself; for
              // text-entry targets deliver the click and verify by focus.
              // Everything else keeps the refusal, which now teaches the
              // deliberate click-through instead of dead-ending.
              const textEntry = await textEntryTarget(elementSession, objectId)
              if (!textEntry) {
                return {
                  ok: false,
                  status: 'error',
                  error: coveredPointError(
                    a.action,
                    target,
                    ht.blocker,
                    elementFrameTargetId ? null : geo.point,
                  ),
                  data: {
                    intercepted_by: ht.blocker ?? null,
                    // A frame-local coordinate is useless to the agent (bare
                    // coordinates are root-space), so a frame target gets no
                    // click_point rather than a mixed-space one.
                    ...(elementFrameTargetId
                      ? {}
                      : { click_point: [Math.round(geo.point.x), Math.round(geo.point.y)] }),
                  },
                }
              }
              clickThrough = ht.blocker ?? 'a covering element'
            }
            await trustedClick(elementSession, geo.point, {
              button,
              clickCount,
              modifiers,
              deadline: budgetDeadline,
            })
            inputMode = 'trusted'
            if (clickThrough) {
              // A beat first: editors focus their input synchronously in
              // their own mousedown handler, but some defer to a queued
              // task, and reading focus before it runs would fail an
              // otherwise-good click.
              await new Promise((resolve) => setTimeout(resolve, 100))
              // Deadlined like the check/uncheck read-back: a click that
              // raises a dialog asynchronously would park this read for the
              // whole transport timeout, and a stall here means the click
              // landed, which is what the caught error reports.
              let landed: boolean
              try {
                landed = await ackWithinDeadline(focusLandedIn(elementSession, objectId))
              } catch (e) {
                if (e instanceof InputDispatchStalled) throw e
                // The context died under the read (a navigation or re-render,
                // possibly caused by the click itself). The click went out;
                // the outcome is unknown; blaming the blocker would be a
                // guess. Say exactly what is known.
                return {
                  ok: false,
                  status: 'error',
                  error:
                    `the ${a.action} was delivered, but the page changed before its ` +
                    'outcome could be verified (a navigation or re-render). Re-read ' +
                    `the page to see what happened before repeating the ${a.action}.`,
                  data: { intercepted_by: ht.blocker ?? null, click_delivered: true },
                }
              }
              if (!landed) {
                return {
                  ok: false,
                  status: 'error',
                  error: clickedThroughButFocusMissedError(a.action, target, ht.blocker),
                  data: { intercepted_by: ht.blocker ?? null, click_delivered: true },
                }
              }
              extra.clicked_through = clickThrough
            }
          } else {
            // No layout box (hidden, zero-size). Synthetic dispatch is the only
            // way in, and the result says so rather than implying a real click.
            await callOn(elementSession, objectId, 'function(){ this.click(); }')
            inputMode = 'synthetic'
            extra.synthetic_reason = 'element has no layout box (hidden or zero-size)'
          }
        } else if (explicitPoint) {
          await trustedClick(tabId, explicitPoint, {
            button,
            clickCount,
            modifiers,
            deadline: budgetDeadline,
          })
          inputMode = 'trusted'
        }
        break
      }
      case 'hover': {
        const explicitPoint = pointFrom(a.coordinate)
        if (objectId) {
          await scrollIntoView(elementSession, objectId)
          const geo = await elementGeometry(elementSession, objectId)
          if (geo) {
            await trustedHover(elementSession, geo.point, modifiers)
            inputMode = 'trusted'
          } else {
            await callOn(
              elementSession,
              objectId,
              'function(){ this.dispatchEvent(new MouseEvent("mouseover", {bubbles:true})); this.dispatchEvent(new MouseEvent("mouseenter", {bubbles:true})); }',
            )
            inputMode = 'synthetic'
          }
        } else if (explicitPoint) {
          await trustedHover(tabId, explicitPoint, modifiers)
          inputMode = 'trusted'
        }
        break
      }
      case 'fill': {
        if (a.value == null) return { ok: false, status: 'error', error: 'fill requires value' }
        if (!objectId) return { ok: false, status: 'error', error: 'fill requires ref' }
        previousValue = await readValue(elementSession, objectId)
        await scrollIntoView(elementSession, objectId)
        await focusElement(elementSession, objectId)
        await selectAllIn(elementSession, objectId)
        // `Input.insertText` commits into the SESSION's focused element, so
        // it must ride the same session the focus call just went to: the
        // root's IME cannot reach a field inside a cross-origin frame.
        await insertText(elementSession, a.value)
        inputMode = 'trusted'
        break
      }
      case 'type': {
        if (a.value == null) return { ok: false, status: 'error', error: 'type requires value' }
        if (objectId) {
          await focusElement(elementSession, objectId)
          previousValue = await readValue(elementSession, objectId)
        }
        if (a.value) {
          // With a ref this is the element's own session (key events follow
          // the focus set above); without one, keystrokes follow the FOCUS,
          // including into a cross-origin frame the agent just clicked
          // (keyboardSession, resolved before the probe armed so the two
          // agree on the document being watched).
          await typeText(keyboardSession ?? elementSession, a.value, budgetDeadline)
          inputMode = 'trusted'
        }
        break
      }
      case 'key': {
        if (!a.value) return { ok: false, status: 'error', error: 'key requires value (the key name)' }
        if (objectId) await focusElement(elementSession, objectId)
        await dispatchKey(keyboardSession ?? elementSession, a.value, modifiers)
        inputMode = 'trusted'
        break
      }
      case 'select': {
        if (a.value == null) return { ok: false, status: 'error', error: 'select requires value' }
        if (!objectId) return { ok: false, status: 'error', error: 'select requires ref' }
        previousValue = await readValue(elementSession, objectId)
        // Native <select> popups cannot be driven through CDP input, so this
        // is a deliberate synthetic path. Match on option value first, then on
        // visible label, which is what a human is reading.
        const matched = await callOn<boolean>(
          elementSession,
          objectId,
          `function(v){
            const options = Array.from(this.options || []);
            const hit = options.find((o) => o.value === v)
              || options.find((o) => (o.label || o.text || '').trim() === v)
              || options.find((o) => (o.label || o.text || '').trim().toLowerCase() === String(v).toLowerCase());
            if (!hit) return false;
            this.value = hit.value;
            this.dispatchEvent(new Event('input', {bubbles: true}));
            this.dispatchEvent(new Event('change', {bubbles: true}));
            return true;
          }`,
          [a.value],
        )
        if (!matched) {
          return {
            ok: false,
            status: 'error',
            error: `no option matching "${a.value}" (matched on value, then on visible label)`,
          }
        }
        inputMode = 'synthetic'
        extra.synthetic_reason = 'native select popups cannot receive browser-level input'
        break
      }
      case 'check':
      case 'uncheck': {
        if (!objectId) return { ok: false, status: 'error', error: `${a.action} requires ref` }
        const want = a.action === 'check'
        previousValue = await readValue(elementSession, objectId)
        const already = previousValue === String(want)
        if (!already) {
          // Click it like a person would; only force the property if the real
          // click did not take (some custom widgets swallow it).
          await scrollIntoView(elementSession, objectId)
          const geo = await elementGeometry(elementSession, objectId)
          if (geo) {
            const ht = await hitTest(elementSession, objectId, geo.point)
            if (!ht.hit) {
              // Checkboxes are not text entry, so no click-through here; the
              // styled-checkbox pattern (hidden input behind a styled span)
              // exits via the taught coordinate click instead, and the state
              // read that follows any check verifies the outcome.
              return {
                ok: false,
                status: 'error',
                error: coveredPointError(
                  a.action,
                  target,
                  ht.blocker,
                  elementFrameTargetId ? null : geo.point,
                ),
                data: {
                  intercepted_by: ht.blocker ?? null,
                  ...(elementFrameTargetId
                    ? {}
                    : { click_point: [Math.round(geo.point.x), Math.round(geo.point.y)] }),
                },
              }
            }
            await trustedClick(elementSession, geo.point, { modifiers, deadline: budgetDeadline })
            inputMode = 'trusted'
          }
          // Deadlined for the same reason the dispatch itself is, and this is
          // the only verb that needs it said separately: its verification runs
          // HERE, inside the action, rather than after the switch where the
          // post-dispatch liveness check sits. A click that raises a dialog
          // asynchronously (a setTimeout'ed alert, a queued beforeunload) acks
          // fine and then suspends the renderer, and this read would queue
          // behind it for the whole transport timeout. A stall here means the
          // click landed, which is exactly what the caught error reports.
          const now = await ackWithinDeadline(readValue(elementSession, objectId))
          if (now !== String(want)) {
            await callOn(
              elementSession,
              objectId,
              `function(want){
                if (this.checked !== want) {
                  this.checked = want;
                  this.dispatchEvent(new Event('input', {bubbles: true}));
                  this.dispatchEvent(new Event('change', {bubbles: true}));
                }
              }`,
              [want],
            )
            inputMode = 'synthetic'
            extra.synthetic_reason = 'the real click did not change the control state'
          }
        }
        break
      }
      case 'scroll_to': {
        if (!objectId) return { ok: false, status: 'error', error: 'scroll_to requires ref' }
        await scrollIntoView(elementSession, objectId)
        break
      }
      case 'upload': {
        if (!objectId) return { ok: false, status: 'error', error: 'upload requires ref' }
        if (!a.file_base64 || !a.file_name) {
          return { ok: false, status: 'error', error: 'upload requires file_name and file_base64' }
        }
        // Necessarily synthetic: CDP's DOM.setFileInputFiles takes a path on
        // the machine running the browser, and the file lives in the user's
        // Nymeria workspace, which may be on a different host entirely. So the
        // bytes ride the wire and a File is constructed in the page. This also
        // reaches display:none inputs, which coordinates never could.
        const outcome = await callOn<{ ok: boolean; mode: string } | null>(
          elementSession,
          objectId,
          `function(b64, name, mime){
            const bin = atob(b64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            const file = new File([bytes], name, { type: mime || 'application/octet-stream' });
            const dt = new DataTransfer();
            dt.items.add(file);
            if (this.tagName === 'INPUT' && this.type === 'file') {
              this.files = dt.files;
              this.dispatchEvent(new Event('input', { bubbles: true }));
              this.dispatchEvent(new Event('change', { bubbles: true }));
              return { ok: true, mode: 'file-input' };
            }
            const opts = { bubbles: true, cancelable: true, dataTransfer: dt };
            this.dispatchEvent(new DragEvent('dragenter', opts));
            this.dispatchEvent(new DragEvent('dragover', opts));
            this.dispatchEvent(new DragEvent('drop', opts));
            return { ok: true, mode: 'drop-target' };
          }`,
          [a.file_base64, a.file_name, a.file_mime ?? ''],
        )
        if (!outcome?.ok) {
          return { ok: false, status: 'error', error: 'upload did not take on that element' }
        }
        inputMode = 'synthetic'
        extra.uploaded = { file_name: a.file_name, mode: outcome.mode }
        extra.synthetic_reason = 'file contents must be injected; CDP file input needs a local path'
        break
      }
      case 'scroll': {
        const amount = a.amount_px ?? 500
        const direction = a.direction ?? 'down'
        const deltaX = direction === 'left' ? -amount : direction === 'right' ? amount : 0
        const deltaY = direction === 'up' ? -amount : direction === 'down' ? amount : 0
        const at = pointFrom(a.coordinate) ?? (await viewportCentre(tabId, budgetDeadline))
        await trustedWheel(tabId, at, { x: deltaX, y: deltaY }, modifiers)
        inputMode = 'trusted'
        extra.scrolled = { direction, amount_px: amount }
        break
      }
      case 'drag': {
        const from = objectId
          ? (await elementGeometry(elementSession, objectId))?.point ?? null
          : pointFrom(a.coordinate)
        // The document the whole pointer stream rides in: the source
        // element's frame for a ref, the root for a coordinate source. A
        // drag is ONE stream (press, glide, release) dispatched on one
        // session, so both ends must live in the same frame.
        const dragFrameId = objectId ? elementFrameTargetId : undefined
        let to: Point | null = null
        if (a.to_ref) {
          const dest = await resolveTarget(tabId, a.to_ref, urlBefore)
          if (!dest.ok) return { ok: false, status: 'error', error: `drag destination: ${dest.error}` }
          // The destination gets the same liveness gate as the source. Without
          // it a detached to_ref fell through to the generic "needs a
          // resolvable destination" below (a detached node has a zero rect, so
          // geometry returns null), which is false: it resolved fine, it is
          // just gone, and only one of those two messages tells the agent to
          // re-read the page.
          if (
            a.to_ref.startsWith('@') &&
            (await connectedBeforeActing(dest.session, dest.objectId)) === false
          ) {
            return {
              ok: false,
              status: 'error',
              error: `drag destination: ${detachedRefError(a.to_ref, 'drag')}`,
              data: { action: 'drag', target, stale_refs: true, reason: 'detached' },
            }
          }
          // The destination's meaning matters as much as the source's:
          // dropping onto a repurposed "Trash" is the same wrong-click class.
          const destRefusal = await fingerprintRefusal(
            dest,
            'drag',
            target,
            a.to_ref,
            'drag destination: ',
          )
          if (destRefusal) return destRefusal
          if ((dest.frameTargetId ?? null) !== (dragFrameId ?? null)) {
            return {
              ok: false,
              status: 'error',
              error: crossFrameDragError(target, a.to_ref),
              data: {
                action: 'drag',
                ...(target ? { target } : {}),
                cross_frame: true,
                input: 'none',
              },
            }
          }
          to = (await elementGeometry(dest.session, dest.objectId))?.point ?? null
        }
        if (!from || !to) {
          return {
            ok: false,
            status: 'error',
            error: 'drag needs a resolvable source (ref or coordinate) and a to_ref destination',
          }
        }
        // The destination resolution above can eat the remaining budget, and
        // once the press goes out the drag MUST complete (a held button is
        // worse). So the can-this-afford-to-start question is answered here,
        // where refusing still honestly means nothing was delivered.
        if (budgetLeftMs() <= 0) {
          return {
            ok: false,
            status: 'error',
            error: budgetExhaustedBeforeDispatchError('drag', budgetMs),
            data: {
              action: 'drag',
              ...(target ? { target } : {}),
              url: urlBefore,
              budget_exhausted: true,
              input: 'none',
              ...localDiagnostics(tabId, startedAt, urlBefore),
            },
          }
        }
        const dragOutcome = await trustedDrag(elementSession, from, to, modifiers, budgetDeadline)
        inputMode = 'trusted'
        if (dragOutcome.degraded) {
          // A zero-glide drag may not have registered as a drag at all; the
          // marker is what keeps `ok: true` from being an unverified claim.
          extra.drag_degraded = true
          extra.drag_moves_sent = dragOutcome.movesSent
        }
        break
      }
      default:
        return { ok: false, status: 'error', error: `unknown action: ${String(a.action)}` }
    }
  } catch (e) {
    if (e instanceof InputBudgetExhausted) {
      // #162: the sum of healthy dispatches reached the wire budget. This is
      // the failure that replaces the backend's payload-less transport
      // timeout, so the payload carries the exact progress: with
      // `delivered_count > 0` the page HOLDS partial input (a half-typed
      // field), and re-sending the whole value is the bug the copy warns off.
      return {
        ok: false,
        status: 'error',
        error: budgetExhaustedMidActionError(a.action, e, budgetMs),
        data: {
          action: a.action,
          ...(target ? { target } : {}),
          url: urlBefore,
          budget_exhausted: true,
          delivered_count: e.delivered,
          requested_count: e.requested,
          progress_unit: e.unit,
          input: e.delivered > 0 ? 'trusted' : 'none',
          ...localDiagnostics(tabId, startedAt, urlBefore),
        },
      }
    }
    if (e instanceof InputDispatchStalled) {
      // The synchronous twin of the post-dispatch check below: an event
      // reached the page and its handler suspended the renderer BEFORE Chrome
      // could ack the dispatch, so execution never gets as far as that check.
      //
      // The stall's cause may already be known BY NAME: a handler that calls
      // `confirm()` synchronously suspends the renderer mid-dispatch, and the
      // dialog's opening event has long arrived by the time the ack deadline
      // fires. Measured live in the #169 QA run: this, not the post-dispatch
      // checks, is the branch a confirm-in-click-handler actually takes, and
      // without this check it returned the two-guesses copy with the answer
      // standing right there.
      const stallDialog = standingDialog(tabId)
      if (stallDialog) {
        if (e.landed) {
          return pendingDialogResult(
            a.action,
            target,
            tabId,
            stallDialog,
            'trusted',
            startedAt,
            urlBefore,
            extra,
          )
        }
        // The stall hit before the action-carrying event was confirmed, so
        // delivery is unknown, and the copy says so instead of guessing in
        // either direction (see dialogInterruptedActError).
        return {
          ok: false,
          status: 'error',
          error: dialogInterruptedActError(a.action, tabId, stallDialog),
          data: {
            action: a.action,
            url: urlBefore,
            dialog: standingDialogPayload(tabId, stallDialog),
          },
        }
      }
      //
      // `landed` decides WHICH failure this is, and the distinction is not
      // cosmetic. A click opens with a pointer move, so a stall on that first
      // ack means no button was ever pressed: telling the agent the click
      // landed would warn it off retrying something that never happened. Only
      // a stall on the event carrying the action earns the do-not-retry
      // message, and only that case is `trusted`, since nothing else went out.
      const landed = e.landed
      return {
        ok: false,
        status: 'error',
        error: landed ? dispatchedThenStalledError(a.action) : stalledError(a.action),
        data: {
          action: a.action,
          url: urlBefore,
          ...(landed ? { input: 'trusted' } : {}),
          ...localDiagnostics(tabId, startedAt, urlBefore),
        },
      }
    }
    return { ok: false, status: 'error', error: `${a.action} failed: ${String(e)}` }
  }

  // The act itself can raise a dialog we now own (#169: a click whose handler
  // calls `confirm()`, a submit into a "Leave site?"). Checked FIRST, before
  // the liveness probe: when the dialog event has already arrived, the cause
  // is known by name and the probe would spend 4s confirming what is known.
  // An `alert` never appears here (it is auto-acknowledged at open and shows
  // up as `extra.dialog` below, after settle).
  {
    const raised = standingDialog(tabId)
    if (raised) {
      return pendingDialogResult(a.action, target, tabId, raised, inputMode, startedAt, urlBefore, extra)
    }
  }
  // The pre-flight cleared the page BEFORE the action, and the check above
  // covers the dialogs we own; this one covers what ownership cannot see (a
  // handler still blocking the page, an event Chrome has not delivered yet).
  // Everything below here is renderer-bound, including settle, whose own
  // deadline is IN-PAGE and so never ticks on a suspended page. Ask again
  // before spending any of it.
  if (!(await rendererResponsive(tabId))) {
    // The dialog event can land while the liveness probe is in flight: prefer
    // the named cause over the guess when it did.
    const lateDialog = standingDialog(tabId)
    if (lateDialog) {
      return pendingDialogResult(a.action, target, tabId, lateDialog, inputMode, startedAt, urlBefore, extra)
    }
    return {
      ok: false,
      status: 'error',
      error: dispatchedThenStalledError(a.action),
      data: { action: a.action, url: urlBefore, input: inputMode, ...localDiagnostics(tabId, startedAt, urlBefore) },
    }
  }

  let delivered: DeliveryOutcome | null = null
  if (probe) {
    // Read on every armed path, so the probe is always disarmed; only ACTED
    // on for trusted input (the synthetic fallbacks produce no trusted event
    // by definition, and `type ""` dispatches nothing at all).
    const reading = await probe.read()
    if (inputMode === 'trusted') {
      delivered = reading.outcome
      let unknownReason = reading.reason
      // The probe watches ONE document (the one it was armed in). A zero
      // count with a nested browsing context below the target could mean the
      // event landed there instead, so it is downgraded unless the absence
      // is conclusive; the reason is NAMED rather than left as a bare
      // "unknown" (2026-08-15 QA-operator rider).
      if (delivered === 'no') {
        const conclusive = await absenceIsConclusive(
          probeTarget,
          objectId ? { session: elementSession, objectId } : null,
        )
        if (!conclusive) {
          delivered = 'unknown'
          unknownReason =
            'the probe counted nothing, but a nested frame below the target ' +
            'could have received it (the probe watches the target document only)'
        }
      }
      extra.input_delivered = delivered
      if (delivered === 'unknown' && unknownReason) {
        extra.input_delivered_reason = unknownReason
      }
    }
  }

  // #168: `timeout_ms` WITHOUT a condition is a patience knob, not a named
  // outcome. It widens this one settle window (one probe, one verdict, under
  // `settled`) and deliberately emits no `condition`/`found`, so mere page
  // quiescence can never gate a batch. Raced because the widened window is
  // agent-sized: a dialog opening mid-settle would otherwise block its whole
  // length before being named. timeout_ms <= 0 is treated as unset, matching
  // the backend's own reading. Not widened when delivery already conclusively
  // failed: the failure below is the story.
  const hasWaitCondition = Boolean(
    a.wait_for && (a.wait_for.text || a.wait_for.ref || a.wait_for.url_contains),
  )
  const agentTimeoutMs = typeof a.timeout_ms === 'number' && a.timeout_ms > 0 ? a.timeout_ms : null
  let settleResult: SettleResult
  let settleAskedMs: number
  let settleWindowMs: number
  if (!hasWaitCondition && agentTimeoutMs !== null && delivered !== 'no') {
    settleAskedMs = agentTimeoutMs
    settleWindowMs = clampToBudget(settleAskedMs)
    const racedSettle = await raceStandingDialog(tabId, settle(tabId, { maxMs: settleWindowMs }))
    if (racedSettle.kind === 'dialog') {
      return pendingDialogResult(
        a.action,
        target,
        tabId,
        racedSettle.dialog,
        inputMode,
        startedAt,
        urlBefore,
        extra,
      )
    }
    settleResult = racedSettle.value
  } else {
    // The default window clamps to the budget too (#162): past the deadline
    // this returns an honest `reason: 'deadline'` in ~0ms rather than
    // spending time the payload does not have.
    settleAskedMs = DEFAULT_MAX_MS
    settleWindowMs = clampToBudget(settleAskedMs)
    settleResult = await settle(tabId, { maxMs: settleWindowMs })
  }
  // A clamped settle that hit its shrunken deadline is the BUDGET's doing:
  // `settled: false` alone reads as "the page never went quiet", which may
  // be false. Marked only when the clamp plausibly changed the verdict.
  if (settleWindowMs < settleAskedMs && !settleResult.settled) {
    extra.budget_clamped = true
  }
  // A dialog can open DURING settle too (a deferred handler); the check must
  // come before `buildVerification`, whose probes are renderer-bound and
  // would each ride their deadline against the suspended page.
  {
    const late = standingDialog(tabId)
    if (late) {
      return pendingDialogResult(a.action, target, tabId, late, inputMode, startedAt, urlBefore, extra)
    }
  }
  // #168: a NAMED wait condition is honoured here, after settle and with no
  // dialog standing, so it is judged against the page the act produced. A
  // condition already true costs one poll (~0ms). Skipped when the act has
  // already conclusively failed (undelivered input, an intercepted chooser):
  // the failure below is the story, and the wait would burn its whole
  // timeout learning nothing. Dialog-raced for the same reason the wait
  // branch is: the poll's evaluates would queue behind a suspended renderer
  // and spend the timeout on a cause known by name the moment it opened.
  if (hasWaitCondition && delivered !== 'no' && !chooserInterceptedSince(tabId, startedAt)) {
    const waitStart = Date.now()
    // Clamped like the widened settle: the backend sizes a single act's
    // budget to fit its declared wait, so the clamp only bites where the
    // clock is genuinely shared (a batch). A clamped MISS is marked: an
    // unmet condition gates a batch, and blaming the page for a window the
    // budget cut is the wrong-claim class this whole pass removes.
    const fusedAskedMs = agentTimeoutMs ?? DEFAULT_WAIT_MS
    const fusedWindowMs = clampToBudget(fusedAskedMs)
    const raced = await raceStandingDialog(tabId, performWait(tabId, a.wait_for, fusedWindowMs))
    if (raced.kind === 'dialog') {
      return pendingDialogResult(a.action, target, tabId, raced.dialog, inputMode, startedAt, urlBefore, extra)
    }
    extra.condition = raced.value.condition
    extra.found = raced.value.found
    extra.waited_ms = Date.now() - waitStart
    if (!raced.value.found && fusedWindowMs < fusedAskedMs) {
      extra.budget_clamped = true
    }
  }
  // A dialog that opened and already resolved during this act is reported as
  // history: the auto-acknowledged alert is the everyday case, a user
  // answering their own confirm mid-act the rarer one.
  {
    const resolved = resolvedDialogSince(tabId, startedAt)
    if (resolved) {
      extra.dialog = {
        state: 'resolved',
        type: resolved.type,
        message: resolved.message,
        resolution: describeResolution(resolved),
      }
    }
  }
  const data = await buildVerification({
    action: a.action,
    target,
    tabId,
    startedAt,
    urlBefore,
    navSeqBefore,
    objectId,
    elementSession,
    inputMode,
    settleResult,
    budgetDeadline,
    previousValue,
    extra,
  })
  // The commit wait inside buildVerification is the one wait left in this
  // function that runs after the last dialog checkpoint, and a deferred
  // beforeunload can open during it. Same rule as every checkpoint above:
  // a dialog standing now is the story, named with its answer route.
  {
    const postVerify = standingDialog(tabId)
    if (postVerify) {
      return pendingDialogResult(a.action, target, tabId, postVerify, inputMode, startedAt, urlBefore, extra)
    }
  }
  // An action that provably did nothing is a FAILED command, not a successful
  // one carrying a flag. A flag beside a green status reproduces the original
  // bug one level down: the agent that skimmed past `settled: "quiet"` would
  // skim past a new field just as readily. The full verification payload rides
  // along on the failure, so nothing diagnostic is lost.
  // The chooser check outranks `delivered`: interception is direct evidence
  // the action ran in the page, and its remedy (use upload) is the useful
  // one, where the undelivered advice would send the agent off to recover a
  // tab with nothing wrong with it.
  const chooser = chooserInterceptedSince(tabId, startedAt)
  if (chooser) {
    // Same fallback as the static refusal above: a coordinate act has no ref
    // to quote, but `describePoint` already named what it found there.
    return {
      ok: false,
      status: 'error',
      error: fileChooserInterceptedError(a.action, target ?? pointTarget?.description ?? null),
      data: { ...data, chooser_intercepted: true },
    }
  }
  if (delivered === 'no') {
    return { ok: false, status: 'error', error: undeliveredError(a.action), data }
  }
  return { ok: true, status: 'success', data }
}

async function viewportCentre(tabId: number, deadline: number | null = null): Promise<Point> {
  // #162: this read precedes a dispatch and would otherwise ride the full
  // 15s CDP deadline past a spent budget; the fallback centre is exactly the
  // degraded answer it already had for a failing read.
  if (budgetSpent(deadline)) return { x: 400, y: 300 }
  // Probe world (#160): the centre is where the scroll's wheel events are
  // DISPATCHED, so a main-world lie steered trusted input. The fallback
  // centre is the same degraded answer a failing read always had.
  const value = await evaluateInProbeWorld<{ x: number; y: number }>(
    tabId,
    '({ x: window.innerWidth / 2, y: window.innerHeight / 2 })',
    deadline === null ? {} : { deadlineMs: clampToDeadline(15_000, deadline) },
  )
  if (value && typeof value.x === 'number') return value
  return { x: 400, y: 300 }
}

export const __test = {
  resolveTarget,
  performWait,
  buildVerification,
  NEEDS_TARGET,
  OPENS_FILE_CHOOSER,
  DESCRIBE_ELEMENT,
}
