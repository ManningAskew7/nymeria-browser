import type { CommandResult } from '../../shared/types'
import { readSince as consoleSince } from '../consoleBuffer'
import {
  CdpCallTimeout,
  frameIdOf,
  frameSessions,
  localFrames,
  localFrameTree,
  locateFrame,
  sendCommand,
  sessionOf,
  tabOf,
  TabUnusable,
  type Cdp,
  type LocalFrame,
} from '../debuggerSession'
import {
  absenceIsConclusive,
  armDelivery,
  clearProvenDelivery,
  clearSwallowedInput,
  recordProvenDelivery,
  recordSwallowedInput,
  type DeliveryOutcome,
} from '../delivery'
import {
  budgetLabel,
  budgetLeft,
  budgetSpent,
  clampToDeadline,
  type ExecContext,
} from '../budget'
import {
  ackWithinDeadline,
  actionabilityOf,
  callOn,
  dispatchKey,
  elementGeometry,
  focusElement,
  focusLandedIn,
  HIT_TEST_FN,
  hitTest,
  InputBudgetExhausted,
  InputDispatchStalled,
  textEntryTarget,
  insertText,
  modifierMask,
  sameProcessDispatchPoint,
  scrollIntoView,
  selectAllIn,
  selectorFactsOf,
  trustedClick,
  trustedDrag,
  trustedHover,
  trustedWheel,
  typeText,
  type Actionability,
  type HitTest,
  type Point,
} from '../input'
import { commitSeq, commitSince, navigationPending, waitForNavSignal } from '../navWatch'
import { cssResolveExpression, SELECTOR_INVALID, SELECTOR_MISS } from '../shadowWalk'
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
/** How often a `wait_for.ref` of `css=` pays the open-shadow-root walk:
 *  every poll would run a whole-DOM traversal ten times a second for the
 *  entire wait (the condition is absent by definition until it fires), so
 *  the walk runs on the first poll and every fifth after it, ~500ms. */
const SHADOW_WALK_EVERY_N_POLLS = 5

/** Lead-in shared by both invalid-selector refusals, so the wait loop can
 *  recognise a condition that can never come true without parsing prose. */
const INVALID_SELECTOR_PREFIX = 'not a valid '
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

/** Actions that focus a target first when given one, but work without.
 *  `scroll` is here since #203: a ref/selector resolves and the wheel goes
 *  in AT the element's point on its own session (the inner-pane case), but
 *  a bare scroll still wheels the viewport centre. Resolution gives it the
 *  detached-ref refusal and frame attribution for free; the activation
 *  gates (fingerprint, disabled) exclude it naturally, since wheeling over
 *  an element is not acting ON it. */
const OPTIONAL_TARGET: ReadonlySet<ActionName> = new Set<ActionName>(['type', 'key', 'scroll'])

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
 * The verbs that go in through `Input.dispatch*` appear here because they
 * traverse the browser-process input gate that a tab-modal dialog closes.
 * `fill` uses `Input.insertText`, an IME commit on a path that does not
 * consult that gate (it demonstrably kept working while every other verb was
 * suppressed), but it is probed anyway (#176 rider): its trusted `input`
 * event is discrete and fires at commit, so the probe generalises to the
 * causes the gate story never covered (a dead frame document, a swallowed
 * commit), and an in-frame fill gets a real verdict instead of none.
 * `select` / `upload` / `scroll_to` run in-page through
 * `Runtime.callFunctionOn` and never touch the gate. `check` and `uncheck` do
 * dispatch a real click first, but they already verify their own outcome by
 * re-reading the control, which is the precedent this whole mechanism
 * generalises.
 *
 * `mousedown` stays the delivery anchor for the click family: it is the one
 * event every button variant produces. The composed event (`click`,
 * `contextmenu`, `dblclick`) and `mouseup` ride along as DIAGNOSIS (#176):
 * per-type counts split "the press arrived but never composed into a click"
 * from "the click composed and its default action was gated", which a bare
 * yes/no collapses. The composed types never widen the yes-verdict
 * (mousedown alone already counts); they only sharpen the payload.
 *
 * `hover` and `scroll` are deliberately ABSENT. Their events (`mousemove`,
 * `wheel`) are coalesced and frame-aligned rather than discrete, so Blink can
 * dispatch them to the DOM after we have already read the counter, especially
 * in a background or occluded tab, which an agent's tab usually is. A false
 * "no" now fails the command, so a verb that cannot be timed reliably is worse
 * off checked than unchecked.
 */
const PROBE_EVENTS: Partial<Record<ActionName, readonly string[]>> = {
  click: ['mousedown', 'mouseup', 'click'],
  double_click: ['mousedown', 'mouseup', 'click', 'dblclick'],
  right_click: ['mousedown', 'mouseup', 'contextmenu'],
  drag: ['mousedown', 'mouseup'],
  key: ['keydown'],
  type: ['keydown'],
  fill: ['input'],
}

/** How long the post-dispatch probe peek may hold the act (see its call
 * site): long enough for the ordinary one-evaluate round trip, far short of
 * the CDP deadline a suspended renderer would otherwise cost. */
const PEEK_RACE_MS = 600

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
 * Verbs refused outright on a `:disabled` target.
 *
 * A disabled control never acts: the browser delivers it no events at all,
 * so today's outcome is either a delivery failure blaming input suppression
 * or, on the paths that read their own outcome back, a silent no-op. Both
 * are the WRONG diagnosis for a fact the probe already knows. Membership is
 * "would have entered input or activated the control": `hover` and
 * `scroll_to` move nothing into the page, `upload` deliberately targets
 * inputs the page has hidden (and an AX-hidden file input is not
 * `:disabled` anyway), `key` keeps its focus-then-dispatch shape, and
 * `drag` has no delivery verdict to misdiagnose.
 *
 * `select` is in for a different reason than the rest, and deliberately: it
 * is a pure in-page property set, so it SUCCEEDS on a disabled `<select>`
 * and always did. That success is the fake one: the control the user sees
 * is inert, no person could have chosen that option, and the form will not
 * submit the value. `upload` is the deliberate counter-example (its whole
 * job is reaching controls a person cannot), which is why it stays out.
 */
const DISABLED_REFUSES: ReadonlySet<ActionName> = new Set<ActionName>([
  'click',
  'double_click',
  'right_click',
  'check',
  'uncheck',
  'fill',
  'type',
  'select',
])

/**
 * Verbs refused on a `readonly` TEXT-ENTRY target. `Input.insertText` into
 * one silently no-ops, the delivery probe then counts zero `input` events,
 * and the act fails blaming input suppression on a tab with nothing wrong
 * with it. Gated on the probe's TEXT_ENTRY_FN answer, so the `readOnly`
 * attribute on a control where it does nothing (a checkbox) refuses
 * nothing.
 */
const READONLY_REFUSES: ReadonlySet<ActionName> = new Set<ActionName>(['fill', 'type'])

/**
 * Verbs whose payload gets `target_invisible` when the target fails
 * `checkVisibility` (R-07's opacity half).
 *
 * ANNOTATION, never refusal, and the asymmetry is the point: an opacity-0
 * element that still wins the hit test is very often a deliberate click
 * target (the invisible real input over styled UI that the custom
 * file-picker and custom-checkbox patterns both use, which is why
 * Playwright treats opacity-0 as visible). So the act proceeds and the
 * payload says what was true of what it acted on, which is exactly the
 * silent case R-07 filed.
 *
 * The flag is set BEFORE the switch, so it rides the other invisible
 * shapes too, and deliberately: a `display:none` target has no layout box
 * and takes the labelled synthetic path, a `visibility:hidden` one has a
 * box but is not hit-testable (the point resolves to an ancestor). Both are
 * cases where "invisible" is worth saying, so nothing downstream may claim
 * this flag means the target won a hit test.
 */
const INVISIBLE_ANNOTATES: ReadonlySet<ActionName> = new Set<ActionName>([
  'click',
  'double_click',
  'right_click',
  'check',
  'uncheck',
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
 * explanation but a swallowed event produces the same reading, and asserting a
 * dialog that is not there would send the agent hunting for nothing. The
 * hedge no longer names "disabled" first: any target with an ELEMENT behind
 * it (a ref or a selector) is refused before dispatch now, so the residue
 * this copy still covers is coordinates and the unprobed verbs.
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
    'UI yourself. If the page is fine, the target may instead be swallowing the ' +
    'event, or be a control that cannot take one (which a ref or selector act ' +
    'checks and refuses up front, but a bare coordinate cannot).'
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

/**
 * Mint-time AX roles that name a DOCUMENT, not a control (#202): a ref to
 * one is legitimate (reads mint the page container for focus and scroll
 * targeting) but a click on it can never mean anything specific, and the
 * no-layout-box synthetic degrade is where that shape lands. Refs only:
 * selector targets carry no mint role and keep the generic reason.
 */
const DOC_LEVEL_ROLES = new Set(['RootWebArea', 'WebArea', 'document'])

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
 * The known-benign failure class (#202, from the #188 QA round: a
 * LaunchDarkly EventSource "canceled" rode two act payloads as an apparent
 * error, `same_origin: false` its only tell). A CROSS-ORIGIN request that
 * was canceled (teardown, stream churn) or blocked by the user's own
 * content blocker is routine page noise, not the act's story.
 *
 * Same-origin entries are NEVER tagged: a first-party cancel can be the
 * very failure the payload exists to surface, and a first-party request
 * eaten by a content blocker is genuinely notable. Unknown origin
 * (unparseable either side) says nothing, so it also never tags: a benign
 * claim needs the fact it rests on. An error-status response (a 500 whose
 * stream was then canceled) is a REAL failure wearing a cancel, so it is
 * never tagged either; a 2xx-then-canceled stream (the measured
 * LaunchDarkly shape) is. Hedged key (`likely_benign`) because it is a
 * classification, not a verdict; tagged entries still appear when the cap
 * has room, ranked last.
 */
function likelyBenign(entry: { error?: string; status?: number }, sameOrigin: boolean | undefined): boolean {
  if (sameOrigin !== false || !entry.error) return false
  if (typeof entry.status === 'number' && entry.status >= 400) return false
  return entry.error === 'canceled' || entry.error.includes('ERR_BLOCKED_BY_CLIENT')
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
 * visible annotations covers both. The known-benign class (#202) demotes
 * below everything else, telemetry included. Most-recent wins within a
 * rank, and the final list reads chronologically.
 */
function classifiedFailures(
  tabId: number,
  since: number,
  pageUrl: string | null,
): Record<string, unknown>[] {
  const raw = networkFailuresSince(tabId, since, FAILURE_RANK_POOL)
  const annotated = raw.map((e) => {
    const so = sameOriginAs(e.url, pageUrl)
    const benign = likelyBenign(e, so)
    return {
      entry: {
        ...e,
        ...(so === undefined ? {} : { same_origin: so }),
        ...(benign ? { likely_benign: true } : {}),
      },
      // Benign outranks (sorts below) everything, telemetry included: a
      // tagged entry must never crowd an untagged one out of the cap.
      rank:
        (TELEMETRY_TYPES.has(e.resource_type ?? '') ? 2 : 0) +
        (so === false ? 1 : 0) +
        (benign ? 4 : 0),
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
 * What to tell an agent whose action landed and then got no verdict.
 *
 * Distinct from `stalledError` in the one way that matters: the input WAS
 * dispatched, so the action may well have taken effect. Telling the agent
 * nothing was sent would invite a retry that double-submits.
 *
 * The opening clause names the SYMPTOM neutrally ("did not answer the
 * verification probe") rather than "stopped running scripts", because the
 * first cause it goes on to name (a navigation in flight) is not breakage
 * at all: during a large upload the page has not stopped so much as gone
 * (#184, QA-operator wording, 2026-08-17).
 *
 * THREE causes, not two. The third was measured live 2026-08-17, the first
 * time a 9MB upload could actually run (the v0.9.0 journal fix; before it,
 * uploads that big never dispatched at all, so nobody ever saw this): a
 * submit that carries a large upload leaves the old document unloading for
 * tens of seconds, and every verification probe is bound to that document.
 * The message enumerated dialog and blocked-handler only, so the operator
 * read a routine big upload as an anomaly and went looking for a dialog that
 * did not exist. An enumeration that omits the case actually happening is
 * the investigation-starting failure this copy exists to prevent, so the
 * cause is NAMED. It is still not ASSERTED: telling the three apart needs
 * navigation state this path does not have, which is filed rather than
 * guessed at here.
 */
function dispatchedThenStalledError(action: ActionName): string {
  return (
    `the ${action} was sent, and the page did not answer the verification probe, so what it ` +
    'did could not be verified. Three things do that, and this does not say which: the ' +
    'action started a navigation that is still in flight (a form submit, and one ' +
    'carrying a large upload is the ORDINARY case, since the request can take tens of ' +
    'seconds), the action raised a dialog (a "Leave site?" on a form with unsaved ' +
    "changes, or a confirm() in the page's own handler), or its own handler is still " +
    'running and has blocked the page for several seconds. DO NOT simply retry in any ' +
    'of those cases: the action may already have taken effect, and repeating it could ' +
    'submit twice. Read the tab to see what happened, in a fresh one if this one stays ' +
    'stuck, or ask the user what is on their screen.'
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
 * Ask a question ABOUT a frame's `<iframe>` owner element, in the document
 * that actually contains it.
 *
 * The three callers below (which cross-origin frame is at a point, which
 * holds focus, is a same-process frame's owner covered, which same-process
 * frame holds focus) differ only in where their candidates come from; the
 * question itself is always these three calls: name the owner node, mint a
 * handle for it IN THE PROBE WORLD so a page cannot forge an answer that
 * gates a refusal, then run the predicate on it.
 *
 * `host` is the addressee whose document holds the owner: the root session
 * for a directly-embedded frame, the parent frame's own world for a nested
 * one. Null means the owner could not be asked about (no owner node, no
 * probe world); errors PROPAGATE so each caller keeps its own policy for a
 * session-layer failure, which is not the same thing as a "no".
 */
async function askFrameOwner<T>(
  host: Cdp,
  frameId: string,
  predicate: string,
  args: unknown[] = [],
): Promise<T | null> {
  const owner = await sendCommand<{ backendNodeId?: number }>(host, 'DOM.getFrameOwner', { frameId })
  if (!owner.backendNodeId) return null
  const resolved = await resolveNodeInProbeWorld(host, owner.backendNodeId)
  if (!resolved.ok) return null
  return await callOn<T>(host, resolved.objectId, predicate, args)
}

/** Which frame EMBEDS this cross-origin frame: its own session's root node
 *  is the only place that relationship is on the wire. Undefined when it
 *  cannot be read, which no caller may treat as "the page". */
async function embeddingFrameId(tabId: number, sessionId: string): Promise<string | undefined> {
  const tree = await localFrameTree({ tabId, sessionId })
  return tree.root.parentId
}

/**
 * Which ATTACHED cross-origin frame satisfies `ownerPredicate` about its
 * `<iframe>` owner element, or null (a frame owner that matches no attached
 * session is same-process, whose input still rides the root).
 * `ownerPredicate` receives the extra args after the owner element as `this`.
 *
 * `ownerDocument` names the document the owner element is expected to live
 * in, and doing that is what keeps the answer UNIQUE. Left out (the point
 * predicates), the question is asked in the root, where only one element can
 * be `document.activeElement` and only a directly-embedded frame's owner
 * resolves at all: root coordinates also mean nothing in a wrapper's own
 * space, so those callers deliberately keep the root-only reach.
 *
 * Given (the focus predicates, which pass the frame the focus read named),
 * candidates are FILTERED to the frames that document actually embeds before
 * anything is asked. Asking each cross-origin frame's own parent document
 * instead was a silent wrong-target bug: `document.activeElement` is a
 * per-document record that survives the document leaving the focus chain, so
 * a wrapper whose payment frame held focus five minutes ago still answers
 * yes, and trusted keystrokes would follow that answer into the wrong
 * origin's frame (review round).
 */
async function matchFrameOwner(
  tabId: number,
  ownerPredicate: string,
  args: unknown[] = [],
  ownerDocument?: Cdp,
): Promise<{ sessionId: string; targetId: string; url: string } | null> {
  const sessions = frameSessions(tabId)
  if (!sessions.length) return null
  const host = ownerDocument ?? tabId
  // Which frame id the host document IS, so a candidate's parent can be
  // compared against it. The page's own frame id is read only when the host
  // is the page itself; a failure there costs the filter, not the lookup.
  let hostFrameId = ownerDocument ? frameIdOf(ownerDocument) : undefined
  if (ownerDocument && !hostFrameId) {
    try {
      hostFrameId = (await localFrameTree(tabId)).root.frameId
    } catch (e) {
      if (e instanceof CdpCallTimeout || e instanceof TabUnusable) throw e
    }
  }
  for (const frame of sessions) {
    try {
      if (ownerDocument && hostFrameId) {
        const parentId = await embeddingFrameId(tabId, frame.sessionId)
        // Only a POSITIVE mismatch excludes a frame. An unreadable parent
        // falls through to the owner question, which answers null for a
        // frame the host document does not embed anyway, so a Chrome that
        // stopped reporting `parentId` would cost precision here, never the
        // whole capability.
        if (parentId !== undefined && parentId !== hostFrameId) continue
      }
      if ((await askFrameOwner<boolean>(host, frame.targetId, ownerPredicate, args)) === true) {
        return frame
      }
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
  /** The element that took the click WRAPS the target rather than covering
   *  it (the target ignores pointer events, so the point resolved to its
   *  ancestor). Saying "was over it" there would be a false claim. */
  wrapping = false,
): string {
  const relation = wrapping ? 'wraps it' : 'was over it'
  return (
    `the ${action} was delivered at ${target ?? 'the target'}'s point, but ` +
    `${blocker ?? 'a covering element'} ${relation} and focus did not land ` +
    'in the target, so that element likely received the click. ' +
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

/**
 * A target the browser will not act on at all. Refused BEFORE dispatch, so
 * "nothing was sent" is literally true, and named, because every downstream
 * signal for this case is a misdiagnosis: the delivery probe counts zero
 * events and blames input suppression, and the check/uncheck force path
 * would "succeed" by setting a property the page never saw changed.
 */
function disabledTargetError(action: ActionName, target: string | null): string {
  return (
    `${target ?? 'that element'} is DISABLED, so the ${action} was NOT sent. A ` +
    'disabled control receives no events at all, so dispatching into it would ' +
    'report either a silent success or an input-suppression failure on a page ' +
    'with nothing wrong with it. Something usually has to enable it first (a ' +
    'required field filled, a consent box ticked, an earlier step finished), so ' +
    'do that and re-read the page; if nothing does, this control is genuinely ' +
    'not available and the way forward is elsewhere.'
  )
}

/**
 * A text field that cannot receive text. Same shape as the disabled refusal
 * and for the same reason: `Input.insertText` into a readonly field is
 * accepted, changes nothing, and produces no `input` event, which reads
 * downstream as a suppressed tab.
 */
function readonlyTargetError(action: ActionName, target: string | null): string {
  return (
    `${target ?? 'that field'} is READ-ONLY, so the ${action} was NOT sent. Text ` +
    'cannot be entered into it, and sending it anyway would come back as ' +
    'undelivered input on a healthy page. A read-only field is normally filled by ' +
    'the page itself (a date picker, a computed total, a value chosen by another ' +
    'control), so use the control that sets it, or whatever unlocks it for editing.'
  )
}

/**
 * Is this text field STILL read-only now that it has focus?
 *
 * The pre-dispatch probe's `readonly` is a trigger, not a verdict, because
 * of one very common pattern: `<input readonly onfocus="this.readOnly =
 * false">`, used to suppress autofill and to force a date picker. The field
 * genuinely accepts text once focused, and refusing on the probe's earlier
 * answer would block an act that used to work end to end.
 *
 * So the question is re-asked on the same handle after the verb's own
 * `focusElement`, and ONLY when the probe already said readonly, which
 * keeps the extra round trip on the path that is about to refuse. Anything
 * other than an explicit `true` proceeds (an unanswerable probe must not
 * block the act), and session-layer failures rethrow as everywhere.
 */
async function readonlyAfterFocus(
  actionability: Actionability | null,
  action: ActionName,
  session: Cdp,
  objectId: string,
): Promise<boolean> {
  if (!READONLY_REFUSES.has(action)) return false
  if (actionability?.readonly !== true || actionability.textEntry !== true) return false
  try {
    return (
      (await callOn<boolean>(session, objectId, 'function(){ return this.readOnly === true; }')) ===
      true
    )
  } catch (e) {
    if (e instanceof CdpCallTimeout || e instanceof TabUnusable) throw e
    return false
  }
}

/**
 * Is the target STILL ignoring pointer events, now that we are about to
 * refuse on it?
 *
 * Same shape and the same reason as `readonlyAfterFocus`: the probe ran
 * before `scrollIntoView`, the geometry read and the hit test, and one of
 * the causes this refusal NAMES is an element mid-transition, which is
 * exactly the state most likely to have cleared inside that window.
 * Refusing on a stale read would be this pass's own misdiagnosis inverted.
 * Only asked on the refusal path, so a healthy act pays nothing; an
 * unanswerable re-ask leaves the original evidence standing (the probe did
 * say `none`, and this is already a failing path).
 */
async function stillPointerEventsNone(session: Cdp, objectId: string): Promise<boolean> {
  try {
    const value = await callOn<boolean>(
      session,
      objectId,
      `function(){
        try { return getComputedStyle(this).pointerEvents === 'none'; } catch (e) { return true; }
      }`,
    )
    return value !== false
  } catch (e) {
    if (e instanceof CdpCallTimeout || e instanceof TabUnusable) throw e
    return true
  }
}

/**
 * Would this click miss the target because the target ignores pointer
 * events, even though the hit test called it a hit?
 *
 * The hit test accepts an ANCESTOR at the point (`via: 'ancestor'`), and
 * normally it is right to: a wrapper occupying the same pixels is the same
 * thing as far as a click is concerned, because the event that targets the
 * wrapper is the one the target would have bubbled up to it anyway. That
 * reasoning inverts for a `pointer-events: none` target: the ancestor is
 * what `elementFromPoint` answers precisely BECAUSE the target is
 * transparent to hit testing, the event targets the ancestor, and events do
 * not travel DOWN, so the target never sees it. Which is the commonest
 * layout by far, so without this the refusal below would almost never fire.
 *
 * A DESCENDANT hit is the legitimate exception, and it is a real pattern (a
 * `pointer-events: none` overlay container whose own buttons set
 * `pointer-events: auto`): the click lands inside the target's own subtree,
 * so it is not a miss.
 */
function pointerEventsMiss(actionability: Actionability | null, ht: HitTest): boolean {
  if (actionability?.pointerEventsNone !== true) return false
  // Named positively (miss, or the loose ancestor acceptance) rather than as
  // "not self and not descendant": a future HitTest producer that forgets
  // `via` must not silently start refusing hits.
  return !ht.hit || ht.via === 'ancestor'
}

/**
 * The target itself ignores pointer events, so the hit test saw whatever the
 * click would land on instead. Without this the refusal named that element
 * as an intercepting overlay, which sent the agent off dismissing a thing
 * that is not in the way: the target is simply unclickable where it stands.
 */
function pointerEventsNoneError(
  action: ActionName,
  target: string | null,
  blocker: string | undefined,
  point: { x: number; y: number } | null,
): string {
  // The same hand-over `coveredPointError` makes, and for a sharper reason:
  // the element the click would hit is frequently the target's own LABEL or
  // wrapper, where a deliberate click genuinely activates the target (label
  // activation behaviour, delegated handlers). Refusing without the
  // coordinate would delete the one exit that works. Null point (an OOPIF
  // target) keeps the ref-based advice, since bare coordinates never reach
  // inside one.
  const override = point
    ? `click it deliberately with action="click" and coordinate=[${Math.round(point.x)}, ` +
      `${Math.round(point.y)}] (no ref), then re-read to confirm it took effect`
    : 're-read the page and target that element by its own @ref (coordinate ' +
      'clicks cannot reach inside a cross-origin frame)'
  return (
    `the ${action} was NOT sent: ${target ?? 'that element'} has CSS ` +
    '"pointer-events: none", so it cannot receive a click where it stands, and the ' +
    `click would have landed on ${blocker ?? 'whatever sits behind it'} instead. Do ` +
    'not read that as an overlay to dismiss: with the way completely clear this ' +
    'element would still not take the click. It is usually a control the page has ' +
    'switched off by styling, a decorative layer, or an element mid-transition, in ' +
    'which case the way forward is elsewhere or is to wait and re-read. But if that ' +
    "other element is the target's own label or wrapper, clicking it IS what a " +
    `person does: ${override}.`
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
      /** The owning frame's URL as currently recorded, from `locateFrame`
       *  at resolution time (#201; distinct from RefTarget.frameUrl, the
       *  MINT-time URL). Three states (#203, previous_value's precedent):
       *  undefined = the target lives in the root document (the key stays
       *  absent), null = the target resolved into a LOCATED frame whose
       *  recorded URL is empty (the defensive `?? ''` paths in
       *  `locateFrame`; the payload says `resolved_frame: null` so absence
       *  keeps meaning root), string = the frame and its URL are known. */
      liveFrameUrl?: string | null
      backendNodeId?: number
      mintRole?: string
      mintName?: string
      /** The rule this target came from, for the selector-only half of the
       *  pre-dispatch probe (`SELECTOR_FACTS_FN`). Absent for `@` refs, which
       *  have a mint fingerprint instead. */
      selector?: { query: string; kind: 'css' | 'xpath' }
    }
  | { ok: false; error: string; stale?: StaleReason }

/**
 * What to tell an agent whose `css=` selector matched nothing anywhere.
 *
 * "matched no element" alone reads as "the element is not on the page",
 * which is exactly the wrong conclusion on a web-component page. The counts
 * come from the walk itself, so the claim about what was searched is
 * measured rather than assumed.
 */
function selectorMissError(query: string, marker: string): string {
  const base = `css selector matched no element: ${query}`
  const parsed = new RegExp(`^${SELECTOR_MISS}(\\d+),(\\d+),(\\d+)$`).exec(marker)
  if (!parsed) return base
  const open = Number(parsed[1])
  const hosts = Number(parsed[2])
  const capped = parsed[3] === '1'
  // The exit: a closed root is the one place a selector can never look, and
  // a page read CAN (refs ride the AX tree, not the DOM tree), so the
  // refusal routes rather than dead-ends. One sentence, two lead-ins.
  const refExit = "read the page and use the element's @ref, which reaches inside closed roots."
  let detail: string
  if (open > 0) {
    detail = ` (searched the document and ${open} open shadow root(s)). If it is in a CLOSED root, ${refExit}`
  } else if (hosts > 0) {
    // Deliberately soft. All this measures is dashed tag names, and
    // `el.shadowRoot === null` cannot tell a closed root from no root at
    // all, so a framework page with no shadow DOM anywhere would otherwise
    // be told its typo was an encapsulation problem (review round).
    detail = `. This page uses custom elements, which MAY hold closed shadow roots: ${refExit}`
  } else {
    return base
  }
  return base + detail + (capped ? ' The search hit its budget, so it was not exhaustive.' : '')
}

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
 * `css=...`  -> the document, then OPEN shadow roots on a miss
 *               (`cssResolveExpression`), evaluated in the probe world
 * `xpath=...`-> document.evaluate, evaluated in the probe world
 *
 * The world is the point (#160): every later read AND mutation runs through
 * `Runtime.callFunctionOn` on this one handle, so minting it in the isolated
 * world gives the whole act pristine primitives a hostile page cannot
 * override. A stale ref returns a typed error naming the fix rather than
 * resolving a backendNodeId that now points into a different document.
 *
 * `skipShadowWalk` is for the WAIT loop only: the same resolution without
 * the open-root walk, which a poll running ten times a second cannot afford
 * every time (see `SHADOW_WALK_EVERY_N_POLLS`). An act NEVER passes it: a
 * one-shot resolution pays the walk and finds the element.
 */
async function resolveTarget(
  tabId: number,
  target: string,
  url: string | null,
  opts: { skipShadowWalk?: boolean } = {},
): Promise<TargetResolution> {
  if (target.startsWith('@')) {
    const resolution = resolveRef(tabId, target, url)
    if (!resolution.ok) {
      return { ok: false, error: resolution.detail, stale: resolution.reason }
    }
    // A frame ref names its frame by STABLE token (target id == Page.FrameId,
    // one token space); its CURRENT addressee is looked up here, at use time,
    // because the idle detach kills sessions between commands while the frame
    // (and the ref) live on. `locateFrame` answers for both frame classes: an
    // OOPIF maps to its live session, a same-process frame to the session it
    // shares plus its own `frameId` (which routes the world resolution below
    // to the frame's OWN isolated world; the root frame's world cannot see
    // its nodes and would tell a lying staleness story). A frame found
    // nowhere is genuinely gone.
    let session: Cdp = tabId
    let liveFrameUrl: string | null | undefined
    if (resolution.frameTargetId) {
      const located = await locateFrame(tabId, resolution.frameTargetId)
      if (!located) {
        return {
          ok: false,
          error:
            `the frame that ${target} lives in is no longer part of the page ` +
            '(it navigated away or was removed). Re-read the page for current refs.',
          stale: 'frame-gone',
        }
      }
      // Same frame token, different document: the frame NAVIGATED since the
      // mint. The ref's backendNodeId belongs to the document it was minted
      // in, and a cross-process swap starts a fresh counter that can hand
      // the same number to an unrelated element, so resolving it would risk
      // the wrong-click class this store exists to prevent. (In-process
      // navigations need no check here: the old ids simply stop resolving.)
      if (resolution.frameUrl && located.url && !sameDocumentUrl(resolution.frameUrl, located.url)) {
        return {
          ok: false,
          error:
            `the frame that ${target} lives in navigated from ${resolution.frameUrl} ` +
            `to ${located.url} since the page was read. Re-read the page for current refs.`,
          stale: 'navigated',
        }
      }
      session = located.session
      // A located frame with an empty recorded URL claims null, not
      // silence: absence must keep meaning "root document" (#203).
      liveFrameUrl = located.url || null
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
            ? 'resolving the element inside its frame'
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
        liveFrameUrl,
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
    // Only CSS descends: XPath is defined over ONE document's node tree and
    // has no way to express a shadow boundary, so piercing it would mean
    // silently redefining what an absolute expression like /html/body/...
    // means. Documented in chrome_act's docstring, which steers to css=.
    const expression = isCss
      ? opts.skipShadowWalk
        ? `document.querySelector(${JSON.stringify(query)})`
        : cssResolveExpression(query)
      : `document.evaluate(${JSON.stringify(query)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue`
    const evald = await withProbeWorld(tabId, (contextId) =>
      sendCommand<{
        result: { objectId?: string; subtype?: string; type?: string; value?: unknown }
        exceptionDetails?: unknown
      }>(tabId, 'Runtime.evaluate', { expression, returnByValue: false, contextId }),
    )
    if (evald === null) {
      return { ok: false, error: probeWorldUnavailableError(`the ${isCss ? 'css' : 'xpath'} lookup`) }
    }
    // A THROWN expression still returns `result`, holding the Error object
    // with a perfectly good objectId, so without this check a malformed
    // xpath resolved to the Error and the act proceeded to click a
    // JavaScript exception (review round). The css branch reports its own
    // invalid-selector marker, so this is the xpath spelling's twin.
    if (evald.exceptionDetails) {
      return {
        ok: false,
        error: `${INVALID_SELECTOR_PREFIX}${isCss ? 'CSS selector' : 'XPath expression'}: ${query}`,
      }
    }
    // A STRING result is the css walk reporting a miss (see SELECTOR_MISS):
    // it rides the same round trip, so the honest "what was searched" answer
    // costs nothing. Keyed on the remote object's TYPE, not just on the
    // value, so a string can never fall through to the node branch and hand
    // the act a target that is not an element.
    if (evald.result.type === 'string') {
      const marker = typeof evald.result.value === 'string' ? evald.result.value : ''
      if (marker.startsWith(SELECTOR_INVALID)) {
        return { ok: false, error: `${INVALID_SELECTOR_PREFIX}CSS selector: ${query}` }
      }
      // An unreadable marker degrades to the plain miss, never to a node.
      return { ok: false, error: selectorMissError(query, marker) }
    }
    if (!evald.result.objectId || evald.result.subtype === 'null') {
      return { ok: false, error: `${isCss ? 'css selector' : 'xpath'} matched no element: ${query}` }
    }
    return {
      ok: true,
      objectId: evald.result.objectId,
      session: tabId,
      selector: { query, kind: isCss ? 'css' : 'xpath' },
    }
  }
  return {
    ok: false,
    error: `target must start with @, css=, or xpath= (got: ${target.slice(0, 40)})`,
  }
}

/**
 * Where to DISPATCH input at a resolved target. Root and OOPIF targets keep
 * the frame-local probe point: their session's `Input.*` speaks that space.
 * A target inside a SAME-PROCESS frame dispatches on the session that frame
 * shares (the root for a root-local frame, the OOPIF's session for a frame
 * nested inside one), which speaks that session's LOCAL-ROOT viewport
 * coordinates, so its point is read separately: browser-side quads asked on
 * the element's own session (per-process node ids make the root session the
 * wrong place to ask, review round). The probes keep the frame-local point,
 * each space measured directly and nothing converted between them. Null
 * only for the same-process case with no readable quads, which callers
 * treat exactly like a missing layout box (synthetic fallback, labelled).
 */
async function dispatchPointFor(
  session: Cdp,
  backendNodeId: number | undefined,
  localPoint: Point,
): Promise<Point | null> {
  if (!frameIdOf(session)) return localPoint
  if (backendNodeId === undefined) return null
  return sameProcessDispatchPoint(session, backendNodeId)
}

/**
 * The dispatch-space occlusion gate for a same-process frame target.
 *
 * The frame-local hit test cannot see an overlay in the DISPATCH document
 * (a parent cookie banner over a same-origin widget), and input for these
 * targets hit-tests through the whole page, so a trusted click would land
 * on the overlay while the payload blamed input suppression (review round).
 * Asks whether the frame's owner chain is what sits at the dispatch point,
 * in the dispatch session's probe world so the answer gates a refusal a
 * page cannot forge. It also catches a frame scrolled out of the page
 * viewport (elementFromPoint answers nothing there). The element tested is
 * the target frame's OUTERMOST local ancestor's owner (`path[0]`), the one
 * iframe element that actually lives in the dispatch document: testing a
 * nested frame's IMMEDIATE owner found its own ancestor iframe "covering"
 * it (the owner lives in the middle document, so the dispatch document's
 * elementFromPoint can only ever answer the ancestor, and `contains()`
 * never crosses the document boundary), a deterministic false refusal on
 * every nested target, measured live (QA round 1). An overlay DEEPER in
 * the chain (inside the middle document, over the nested frame) passes
 * this gate; the delivery probe, armed in the target frame's own world,
 * still catches the eaten click, so that degrades to an honest
 * "undelivered", not a false "clicked". Null means "not a same-process
 * target" or "could not check": the probe failing must not block the act
 * (the delivery verification backstops), but session-layer failures
 * rethrow like every other pre-dispatch gate.
 */
async function frameOwnerAtPoint(session: Cdp, point: Point): Promise<HitTest | null> {
  const frameId = frameIdOf(session)
  if (!frameId) return null
  const sessionId = sessionOf(session)
  const host: Cdp = sessionId ? { tabId: tabOf(session), sessionId } : tabOf(session)
  try {
    const chain = (await localFrames(host)).find((f) => f.frameId === frameId)
    // No chain (the walk soft-failed, or the frame left between resolve and
    // gate): skip the gate rather than fall back to the immediate owner,
    // which for a nested frame would reinstate the exact false refusal this
    // gate was fixed for (review round). Fail-open is this probe's contract;
    // the delivery verification backstops.
    if (!chain) return null
    return await askFrameOwner<HitTest>(host, chain.path[0], HIT_TEST_FN, [point.x, point.y])
  } catch (e) {
    if (e instanceof CdpCallTimeout || e instanceof TabUnusable) throw e
    return null
  }
}

/**
 * A same-process frame target whose DISPATCH point is intercepted in the
 * embedding document (the immediate parent for a directly-embedded frame,
 * the outermost ancestor's document for a nested one: the gate tests
 * there). Distinct from `coveredPointError`: the frame's own view is clear
 * (the frame-local hit test passed), so "part of the target's own widget"
 * cannot be the story, and teaching a coordinate click-through would aim
 * at the same interceptor.
 */
function frameOccludedError(action: ActionName, target: string | null, blocker?: string): string {
  return (
    `the ${action} point for ${target ?? 'that element'} is covered in the EMBEDDING ` +
    `document by ${blocker ?? 'another element'}: the frame's own view is clear, but ` +
    'input for a same-origin frame dispatches through the page, where that element ' +
    `is on top. Nothing was sent. Dismiss or scroll away the covering element (it ` +
    'has its own ref in a page read), then retry.'
  )
}

interface FocusedDescription {
  tag: string
  label: string
  /** Set when focus rests inside a frame: the description above is then the
   *  FRAME'S OWN focused element (read in-expression for a same-origin
   *  frame, through the frame's session for a cross-origin one), and this
   *  names which frame. Without the descent the payload stopped at
   *  `tag: "iframe"`, which live QA misread twice as a failed click. */
  frame_url?: string
}

const DESCRIBE_FOCUSED_EXPRESSION = `(function(){
  let el = document.activeElement;
  let frameUrl = null;
  // Same-origin frame chain: activeElement stops at the frame OWNER, but a
  // same-origin contentDocument is reachable from here, so descend to the
  // element actually holding focus (bounded: nested widgets, not cycles).
  // A cross-origin frame throws or hides its document, leaving el on the
  // owner for the caller's session-descent path.
  for (let hops = 0; hops < 5; hops++) {
    const tag = el ? el.tagName : '';
    if (tag !== 'IFRAME' && tag !== 'FRAME') break;
    let doc = null;
    try { doc = el.contentDocument; } catch (e) { doc = null; }
    if (!doc || !doc.activeElement || doc.activeElement === doc.body) break;
    el = doc.activeElement;
    try { frameUrl = String(el.ownerDocument.location.href).slice(0, 200); } catch (e) { frameUrl = null; }
  }
  if (!el || el === document.body || el === document.documentElement) return null;
  const raw = el.getAttribute('aria-label') || el.getAttribute('name')
    || el.getAttribute('placeholder') || (el.innerText || '');
  const out = { tag: el.tagName.toLowerCase(), label: String(raw || '').trim().slice(0, 60) };
  if (frameUrl) out.frame_url = frameUrl;
  return out;
})()`

async function describeFocused(tabId: number): Promise<FocusedDescription | null> {
  // Probe world (review round): this read names the payload's `focused`
  // fact and, through keyboardSessionForFocus's twin, routes trusted
  // keystrokes; evaluated in the main world a page could forge both.
  try {
    const top = (await evaluateInProbeWorld<FocusedDescription | null>(
      tabId,
      DESCRIBE_FOCUSED_EXPRESSION,
    )) ?? null
    if (!top || (top.tag !== 'iframe' && top.tag !== 'frame')) return top
    // Focus rests on a frame owner: descend ONE level when it is an attached
    // cross-origin frame, so the payload names the element that actually
    // holds focus instead of the wall in front of it. (A SAME-ORIGIN frame
    // never reaches here: the expression itself descends its chain.) The
    // owner element lives in the document the read NAMED, which is the page
    // unless the focus chain ran through a same-origin wrapper first.
    const frame = await matchFrameOwner(
      tabId,
      OWNER_HAS_FOCUS_FN,
      [],
      top.frame_url ? (await localFrameHoldingFocus(tabId, top.frame_url)).session : tabId,
    )
    if (!frame) return top
    const innerValue = await evaluateInProbeWorld<FocusedDescription | null>(
      { tabId, sessionId: frame.sessionId },
      DESCRIBE_FOCUSED_EXPRESSION,
    )
    return innerValue
      ? { ...innerValue, frame_url: frame.url }
      : { ...top, frame_url: frame.url }
  } catch {
    return null
  }
}

/**
 * How many same-process frames the focused-frame lookup may interrogate.
 *
 * Bounded like every other frame walk here: the URL filter picks the right
 * frame on any ordinary page, and the fallback sweep exists only for the
 * duplicate-URL case (ad and widget stacks), where paying three CDP calls
 * per frame across a frame farm would cost more than the verdict is worth.
 */
const MAX_FOCUS_FRAME_PROBES = 8

/**
 * Do the focus expression's URL and a frame tree's URL name the same document?
 *
 * Two shapes have to be reconciled, and a plain equality on them silently
 * matched nothing for any frame carrying a fragment (review round, which
 * dropped every such lookup into the unfiltered sweep): the expression reads
 * `location.href`, which INCLUDES the fragment and is sliced to 200 chars,
 * while `Page.Frame.url` is defined without one. So compare fragment-free,
 * and treat a sliced-to-the-limit reading as the prefix it is.
 */
function sameFocusFrameUrl(frameTreeUrl: string, focusUrl: string): boolean {
  const bare = (u: string): string => {
    const hash = u.indexOf('#')
    return hash === -1 ? u : u.slice(0, hash)
  }
  const want = bare(focusUrl)
  const have = bare(frameTreeUrl)
  return focusUrl.length >= 200 ? have.startsWith(want) : have === want
}

/**
 * WHICH same-process frame holds the page's focus, addressed so the delivery
 * probe can arm inside it.
 *
 * Only called when `DESCRIBE_FOCUSED_EXPRESSION` already descended into a
 * same-origin frame (it reports that frame's URL), so the common case pays
 * nothing. The URL narrows the candidates and the OWNER test decides, because
 * two frames on one page routinely share a URL and arming the wrong frame's
 * probe would be a NEW silent-wrong, worse than the honest unknown this
 * replaces. The owner element lives in the frame's PARENT document, so the
 * question is asked in the parent's own world (the root's world cannot see a
 * nested frame's owner, which is what makes the doubly-nested case work).
 *
 * Returns a `frameId`-carrying root target: `debuggee()` ignores `frameId`,
 * so trusted keystrokes keep riding the shared session exactly as before and
 * ONLY the probe's document moves. `url` is the CONFIRMED frame's URL from
 * the CDP frame tree (undefined when the scan falls back to the root, null
 * when the confirmed frame's recorded URL is empty: the payload claim's
 * three states, #203): the payload's `resolved_frame` claim, sourced from
 * the browser's own record rather than the in-page focus read, which both
 * truncates its URL and is only a hint about WHICH frame to confirm (#201
 * review).
 */
async function localFrameHoldingFocus(
  tabId: number,
  frameUrl: string,
): Promise<{ session: Cdp; url: string | null | undefined }> {
  // `url` states (#203): a string names the confirmed frame; null means
  // the frame was CONFIRMED but its recorded URL is empty (the payload
  // claims `resolved_frame: null`); undefined means no confirmation (the
  // root fallbacks) and no claim is made.
  let locals: LocalFrame[]
  try {
    locals = await localFrames(tabId)
  } catch (e) {
    // Session-layer failures rethrow like every other pre-dispatch probe;
    // anything else leaves the keystrokes where they already were going.
    if (e instanceof CdpCallTimeout || e instanceof TabUnusable) throw e
    return { session: tabId, url: undefined }
  }
  const byUrl = locals.filter((f) => sameFocusFrameUrl(f.url, frameUrl))
  // DEEPEST FIRST. `document.activeElement` is the frame OWNER in every
  // ancestor of the focused frame, so the owner predicate answers true all
  // the way UP the chain, and taking the first true in document order armed
  // the probe in the outermost frame of a nested widget (review round). The
  // innermost true answer is the document the caret is actually in. The sort
  // is stable, so same-depth candidates keep document order.
  const candidates = byUrl.length ? byUrl : locals
  for (const f of [...candidates]
    .sort((x, y) => y.path.length - x.path.length)
    .slice(0, MAX_FOCUS_FRAME_PROBES)) {
    const parentFrameId = f.path.length > 1 ? f.path[f.path.length - 2] : undefined
    const host: Cdp = parentFrameId ? { tabId, frameId: parentFrameId } : tabId
    try {
      if ((await askFrameOwner<boolean>(host, f.frameId, OWNER_HAS_FOCUS_FN)) === true) {
        return { session: { tabId, frameId: f.frameId }, url: f.url || null }
      }
    } catch (e) {
      if (e instanceof CdpCallTimeout || e instanceof TabUnusable) throw e
      // One unanswerable frame must not veto the others (matchFrameOwner's
      // rule: a whole-loop try let a single bad frame decide the verdict).
    }
  }
  return { session: tabId, url: undefined }
}

/** Where ref-less keystrokes go: the frame holding focus, else the root.
 *  Keyboard input has no coordinates; what it has is a focused element, and
 *  when that element lives in a cross-origin frame, root-session key events
 *  never arrive (the measured wall). Following focus keeps the "type
 *  continues at the caret" contract across the frame boundary.
 *
 *  `frameUrl` is the destination document's URL when that document is a
 *  CONFIRMED subframe, for the payload's `resolved_frame` attribution
 *  (#201): read at DISPATCH time, so it stays honest even when the typing
 *  itself moves focus (autocomplete widgets), where the verification-time
 *  `focused` read names wherever the caret ended up. Sourced from the CDP
 *  frame records only (the in-page focus read truncates its URL and is
 *  page-readable state, so it routes the confirmation but never supplies
 *  the claim). `frameUrl` states (#203): a string names the confirmed
 *  frame; null means CONFIRMED but the recorded URL is empty (the payload
 *  claims `resolved_frame: null`); undefined means the root document or an
 *  unconfirmed frame, and the payload stays silent. */
async function keyboardSessionForFocus(
  tabId: number,
): Promise<{ session: Cdp; frameUrl: string | null | undefined }> {
  // Cheap gate before the per-frame scan: only when the ROOT document's own
  // focus rests on a frame owner can the caret be inside a cross-origin
  // frame, so anything else answers with one evaluate instead of three CDP
  // calls per attached frame. In the PROBE world (review round): this gate
  // routes TRUSTED keystrokes, and `withProbeWorld` keeps the session-layer
  // rethrow the main-world try/catch used to carry.
  let top: FocusedDescription | null
  try {
    top = await withProbeWorld(tabId, async (contextId) => {
      const resp = await sendCommand<{
        result?: { value?: FocusedDescription | null }
        exceptionDetails?: unknown
      }>(tabId, 'Runtime.evaluate', {
        expression: DESCRIBE_FOCUSED_EXPRESSION,
        contextId,
        returnByValue: true,
      })
      if (resp.exceptionDetails) return null
      return resp.result?.value ?? null
    })
  } catch (e) {
    if (e instanceof CdpCallTimeout || e instanceof TabUnusable) throw e
    // An unanswerable gate keeps the pre-frames behavior: type at the root.
    return { session: tabId, frameUrl: undefined }
  }
  if (!top) return { session: tabId, frameUrl: undefined }
  if (top.tag !== 'iframe' && top.tag !== 'frame') {
    // The expression descended a SAME-ORIGIN frame chain itself, so a
    // non-frame tag with a `frame_url` means the caret is inside a
    // same-process frame. Dispatch does not change (root-session input
    // reaches those frames), but the DELIVERY PROBE must arm in the frame's
    // own world: armed at the root it counted nothing and the verdict was a
    // permanent "unknown", which is the residual this closes.
    if (!top.frame_url) return { session: tabId, frameUrl: undefined }
    const picked = await localFrameHoldingFocus(tabId, top.frame_url)
    return { session: picked.session, frameUrl: picked.url }
  }
  // Same as `describeFocused`: the owner element lives in the document the
  // focus read named, and naming it is what keeps the answer unique.
  const frame = await matchFrameOwner(
    tabId,
    OWNER_HAS_FOCUS_FN,
    [],
    top.frame_url ? (await localFrameHoldingFocus(tabId, top.frame_url)).session : tabId,
  )
  // No confirmed frame: the keystrokes ride the root session and the
  // destination is genuinely uncertain, so no attribution is claimed.
  return frame
    ? { session: { tabId, sessionId: frame.sessionId }, frameUrl: frame.url || null }
    : { session: tabId, frameUrl: undefined }
}

/** The scroll probes' shared preamble (#203 review round). `document`'s
 * named-property getter has LegacyOverrideBuiltIns, so a bare
 * `document.scrollingElement` is forgeable by an <img
 * name="scrollingElement"> in EVERY world, isolated included (worlds.ts
 * states the rule; extract_text.ts pins the same class to a fixed
 * prototype): every document.* lookup here rides a prototype-chain getter
 * instead. Starting at the instance's PROTO skips both the instance's own
 * properties and the named-getter interception (the two forgery surfaces;
 * in-world prototypes themselves are pristine), while finding the real
 * accessor wherever the implementation hung it. `doc` is the document's
 * scrolling element. */
const SCROLL_DOC_SNIPPET = `
  var read = function (name, obj) {
    var p = Object.getPrototypeOf(obj);
    while (p) {
      var d = Object.getOwnPropertyDescriptor(p, name);
      if (d && d.get) return d.get.call(obj);
      p = Object.getPrototypeOf(p);
    }
    return undefined;
  };
  var docEl = read('documentElement', document);
  var bodyEl = read('body', document);
  var doc = read('scrollingElement', document) || docEl;`

/** The one pre-wheel read for a TARGETED scroll (#203): the dispatch point
 * and the baseline offsets, and the registration that makes the after-read
 * honest. Three answers in one round trip:
 *
 * `p` is where the wheel can be dispatched: the centre of the element's
 * VIEWPORT-VISIBLE region, not its geometric centre, because wheel input
 * is positional: a rect below the fold has a centre, and a wheel at that
 * off-screen point scrolls whatever happens to be there instead (review
 * round). `{off: true}` says the element has layout but no visible region,
 * which the caller refuses rather than wheels.
 *
 * `c`/`d` are the baseline offsets of the nearest scrollable ancestor
 * (self included; computed-overflow gated so an overflow:visible giant is
 * not a scroller; crosses shadow boundaries via the host hop) and of the
 * document's scrolling element.
 *
 * The resolved ELEMENTS ride a registry in this world (the delivery
 * probe's reg pattern), so the after-read measures the SAME scrollers: a
 * re-walk could resolve a DIFFERENT container (settle-time hydration
 * making a wrapper scrollable) and subtract offsets of two different
 * elements into a fabricated delta (review round). */
const SCROLL_BASE_FN = `function(id){
  ${SCROLL_DOC_SNIPPET}
  var p = null;
  try {
    var r = this.getBoundingClientRect();
    if (r && r.width > 0 && r.height > 0) {
      var x0 = Math.max(r.left, 0), y0 = Math.max(r.top, 0);
      var x1 = Math.min(r.right, window.innerWidth), y1 = Math.min(r.bottom, window.innerHeight);
      p = (x1 - x0 < 4 || y1 - y0 < 4) ? { off: true } : { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
    }
  } catch (e) { p = null; }
  var c = null;
  try {
    var n = this;
    while (n) {
      var scrollable = (n.scrollHeight > n.clientHeight + 1) || (n.scrollWidth > n.clientWidth + 1);
      if (scrollable && n !== docEl && n !== bodyEl) {
        var cs = getComputedStyle(n);
        var oy = cs.overflowY, ox = cs.overflowX;
        if (oy === 'auto' || oy === 'scroll' || oy === 'overlay' ||
            ox === 'auto' || ox === 'scroll' || ox === 'overlay') { c = n; break; }
      }
      n = n.parentElement || (n.getRootNode && n.getRootNode().host) || null;
    }
  } catch (e) { c = null; }
  try {
    var reg = (globalThis.__nymScroll = globalThis.__nymScroll || {});
    reg[id] = { c: c, d: doc };
  } catch (e) {}
  return {
    p: p,
    c: c ? { t: c.scrollTop, l: c.scrollLeft } : null,
    d: doc ? { t: doc.scrollTop, l: doc.scrollLeft } : null
  };
}`

/** The targetless twin: the document is the only watchable scroller, read
 * and registered in the probe world the same way. It also answers whether
 * the wheel point sits over an embedded frame (`f`), because a wheel
 * routed into a frame scrolls a document this probe never watched: the
 * #203 QA round measured a cross-origin frame visibly scrolling while the
 * root's honest {0,0} read as "nothing moved". The method ride is
 * prototype-direct (the extract_text idiom for methods), same forgery
 * reasoning as the getters. */
function scrollBaseExpression(id: string, point: Point | null): string {
  return `(function(){
  ${SCROLL_DOC_SNIPPET}
  var over = false;
  try {
    var pt = ${point ? JSON.stringify({ x: point.x, y: point.y }) : 'null'};
    if (pt && Document.prototype.elementFromPoint) {
      var el = Document.prototype.elementFromPoint.call(document, pt.x, pt.y);
      var tag = el && el.tagName;
      over = tag === 'IFRAME' || tag === 'FRAME' || tag === 'OBJECT' || tag === 'EMBED';
    }
  } catch (e) {}
  try {
    var reg = (globalThis.__nymScroll = globalThis.__nymScroll || {});
    reg[${JSON.stringify(id)}] = { c: null, d: doc };
  } catch (e) {}
  return { p: null, c: null, d: doc ? { t: doc.scrollTop, l: doc.scrollLeft } : null, f: over };
})()`
}

/** Post-settle re-read of the REGISTERED scrollers, never a re-walk. A
 * container detached by settle-time churn answers null (its offsets would
 * be stale garbage); a missing slot (world died, navigation) answers null
 * wholesale, which keeps scroll_moved absent. */
function scrollAfterExpression(id: string): string {
  return `(function(){
  var reg = globalThis.__nymScroll;
  var s = reg && reg[${JSON.stringify(id)}];
  if (reg) { delete reg[${JSON.stringify(id)}]; }
  if (!s) return null;
  var c = s.c && s.c.isConnected ? { t: s.c.scrollTop, l: s.c.scrollLeft } : null;
  var d = s.d && s.d.isConnected ? { t: s.d.scrollTop, l: s.d.scrollLeft } : null;
  return { c: c, d: d };
})()`
}

interface ScrollPair {
  t: number
  l: number
}

interface ScrollSnap {
  p: { x: number; y: number } | { off: true } | null
  c: ScrollPair | null
  d: ScrollPair | null
  /** The wheel point sits over an embedded frame (targetless reads only). */
  f: boolean
}

function scrollPair(v: unknown): ScrollPair | null {
  const o = v as { t?: unknown; l?: unknown } | null | undefined
  return o && typeof o.t === 'number' && typeof o.l === 'number' ? { t: o.t, l: o.l } : null
}

function parseScrollSnap(v: unknown): ScrollSnap | null {
  if (!v || typeof v !== 'object') return null
  const o = v as { p?: unknown; c?: unknown; d?: unknown }
  const raw = o.p as { x?: unknown; y?: unknown; off?: unknown } | null | undefined
  const p =
    raw && typeof raw.x === 'number' && typeof raw.y === 'number'
      ? { x: raw.x, y: raw.y }
      : raw && raw.off === true
        ? ({ off: true } as const)
        : null
  return { p, c: scrollPair(o.c), d: scrollPair(o.d), f: (o as { f?: unknown }).f === true }
}

/** Slot names for the scroll registry, unique per act within a worker. */
let scrollSlot = 0

async function scrollBase(
  session: Cdp,
  objectId: string,
  id: string,
  deadline: number | null,
): Promise<ScrollSnap | null> {
  try {
    const v = await callOn<unknown>(
      session,
      objectId,
      SCROLL_BASE_FN,
      [id],
      // #162: a pre-dispatch read must not ride the full CDP deadline past
      // a spent budget (viewportCentre documents the same hazard).
      deadline === null ? {} : { deadlineMs: clampToDeadline(15_000, deadline) },
    )
    return parseScrollSnap(v)
  } catch {
    // Unreadable is a refusal at the call site, not an error here.
    return null
  }
}

async function scrollBaseTargetless(
  tabId: number,
  id: string,
  point: Point | null,
  deadline: number | null,
): Promise<ScrollSnap | null> {
  if (budgetSpent(deadline)) return null
  const v = await evaluateInProbeWorld<unknown>(
    tabId,
    scrollBaseExpression(id, point),
    deadline === null ? {} : { deadlineMs: clampToDeadline(15_000, deadline) },
  )
  return v === undefined ? null : parseScrollSnap(v)
}

async function scrollAfter(
  session: Cdp,
  id: string,
): Promise<{ c: ScrollPair | null; d: ScrollPair | null } | null> {
  const v = await evaluateInProbeWorld<{ c?: unknown; d?: unknown }>(
    session,
    scrollAfterExpression(id),
  )
  if (!v || typeof v !== 'object') return null
  return { c: scrollPair(v.c), d: scrollPair(v.d) }
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
 * The same question, asked BEFORE acting, WIDENED to everything else the
 * dispatch decision needs from the element.
 *
 * `stillConnected` is deliberately tolerant because it also runs after the
 * action, where an unanswerable probe is just a missing field. Here it gates
 * a dispatch: if the tab went unusable or the call rode its full 15s deadline
 * between resolution and now, "unknown, carry on" would send input into a tab
 * we already know is not answering, and burn most of the command's budget
 * first. Same rule `resolveTarget` follows for the same two classes.
 *
 * The actionability facts ride the SAME call (`ACTIONABILITY_FN`), which is
 * the whole reason they are affordable: this probe already runs on the
 * already-minted probe-world handle before every act, so disabled, readonly,
 * text-entry, visibility and pointer-events cost zero extra round trips (the
 * text-entry answer even SAVES the covered-click path its own call).
 *
 * `selector` switches to the composed body that adds the two selector-only
 * facts. It is the one call a `css=`/`xpath=` act spends that a ref act
 * spends too: before this, selector targets skipped the probe entirely and
 * dispatched into disabled controls, so the same click refused by name
 * through `@e12` came back as an undelivered-input failure blaming a healthy
 * page.
 *
 * A null return, or an individual field left absent, means NOT KNOWN, and
 * every caller refuses only on an explicit answer.
 */
async function actionabilityBeforeActing(
  session: Cdp,
  objectId: string,
  selector?: { query: string; kind: 'css' | 'xpath' },
): Promise<Actionability | null> {
  try {
    const value = selector
      ? await selectorFactsOf(session, objectId, selector.query, selector.kind)
      : await actionabilityOf(session, objectId)
    // A malformed answer (a page cannot produce one here, but a protocol
    // change or a returnByValue failure can) is "not known", never a
    // refusal: same fail-open side the occlusion gate picks.
    return value && typeof value === 'object' ? value : null
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

/**
 * The wait `text` condition's in-page scan. Descends same-origin frames: a
 * page read includes their content, so a wait on text the read showed must
 * see it too; scanning only the root document returned a false
 * `found: false` on text sitting in a child frame, measured live (QA
 * round). Cross-origin frames answer a null contentDocument here and are
 * skipped; the POLL covers them instead by running this same expression in
 * each OOPIF session's probe world, mirroring the read's two-sweep
 * coverage. Both depth and total frame count are bounded (the read's
 * frame-cap philosophy: this runs every poll tick and `innerText` forces
 * layout); past the budget the poll simply keeps polling and times out
 * honestly. The descent is exercised as EXECUTED code by the wait tests'
 * evaluate mock, not string-matched.
 */
function waitTextExpression(text: string): string {
  return `(function(){
    var NEEDLE = ${JSON.stringify(text)};
    var budget = 16;
    function scan(doc, depth) {
      if (!doc || depth > 4) return false;
      try {
        if (doc.body && doc.body.innerText && doc.body.innerText.includes(NEEDLE)) return true;
      } catch (e) {}
      var frames;
      try { frames = doc.querySelectorAll('iframe,frame'); } catch (e) { return false; }
      for (var i = 0; i < frames.length; i++) {
        if (budget <= 0) return false;
        budget -= 1;
        var inner = null;
        try { inner = frames[i].contentDocument; } catch (e) { inner = null; }
        if (inner && scan(inner, depth + 1)) return true;
      }
      return false;
    }
    return scan(document, 0);
  })()`
}

/**
 * Poll until a condition holds, or the window runs out.
 *
 * `alreadyTrue` is the honesty half: the loop checks every condition BEFORE
 * its first sleep, so a condition that was already satisfied returns in ~0ms,
 * which in the payload was indistinguishable from one that appeared inside
 * the first poll interval. Those are opposite answers to the question a BARE
 * wait exists to settle ("is this already true?"), so the first pass is
 * marked and the key is omitted otherwise (absent means no news). The
 * bare-settle branch has no such notion and must never grow the flag, and
 * neither does a FUSED wait: it runs after the action has settled, so
 * "already true at the first check" is the normal shape of success there and
 * the flag would be furniture on nearly every payload (review round).
 */
async function performWait(
  tabId: number,
  waitFor: WaitFor | undefined,
  timeoutMs: number,
): Promise<{ found: boolean; condition: string; alreadyTrue?: boolean; unwatchable?: string }> {
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
  let polls = 0
  const firstPass = (): { alreadyTrue?: true } => (polls === 0 ? { alreadyTrue: true } : {})

  for (;;) {
    if (waitFor.url_contains) {
      const url = await currentUrl(tabId)
      if (url && url.includes(waitFor.url_contains)) {
        return {
          found: true,
          condition: `url_contains:${waitFor.url_contains}`,
          ...firstPass(),
        }
      }
    }
    if (waitFor.text) {
      // Probe world (#160): this answer GATES a batch, so a page faking the
      // condition met would charge a whole batch onward. A failed evaluate
      // (world churn mid-wait) keeps polling until the deadline.
      let seen = await evaluateInProbeWorld<boolean>(tabId, waitTextExpression(waitFor.text))
      if (seen !== true) {
        // OOPIF documents are separate targets the root scan cannot reach,
        // and a page read includes their content (review round): the same
        // expression runs in each frame session's own probe world, which
        // also covers that frame's same-origin children.
        for (const frame of frameSessions(tabId)) {
          seen = await evaluateInProbeWorld<boolean>(
            { tabId, sessionId: frame.sessionId },
            waitTextExpression(waitFor.text),
          )
          if (seen === true) break
        }
      }
      if (seen === true) {
        return { found: true, condition: `text:${waitFor.text}`, ...firstPass() }
      }
    }
    if (waitFor.ref) {
      try {
        const url = await currentUrl(tabId)
        // Cheap first (review round). A `css=` condition is absent for the
        // whole wait by definition, which is exactly the case that pays the
        // open-root walk in full on EVERY poll: up to 2000 nodes scanned
        // synchronously, fifty times over a 5s wait. The light document
        // query is what a selector resolved with before the walk existed;
        // the walk itself still runs on the first poll and every fifth
        // after it, so a wait can still find an element inside a shadow
        // root, at most half a second later than the poll that saw it.
        const target = await resolveTarget(tabId, waitFor.ref, url, {
          skipShadowWalk: polls % SHADOW_WALK_EVERY_N_POLLS !== 0,
        })
        // A MALFORMED condition can never come true, so polling it to the
        // deadline spends the whole window (up to 64s) to report "timed
        // out", which reads as the page never producing the element. Stop
        // at once and name the real problem (review round).
        if (!target.ok && target.error.startsWith(INVALID_SELECTOR_PREFIX)) {
          return { found: false, condition: `ref:${waitFor.ref}`, unwatchable: target.error }
        }
        if (target.ok) {
          const connected = await stillConnected(target.session, target.objectId)
          if (connected !== false) {
            return { found: true, condition: `ref:${waitFor.ref}`, ...firstPass() }
          }
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
    polls += 1
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
    // Sampled here, not from `startedAt`: the dialog check, the liveness
    // probe and the url read all precede this, and counting them made
    // `waited_ms` a number about the whole command rather than about the
    // wait it names.
    const waitStart = Date.now()
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
    const { found, condition, alreadyTrue, unwatchable } = raced.value
    // A condition that can never come true is a caller error, not a page
    // outcome, and it is reported the moment the resolver says so rather
    // than after the window it would otherwise have burned.
    if (unwatchable) {
      return {
        ok: false,
        status: 'error',
        error: `the wait condition cannot be watched: ${unwatchable}`,
        data: { action: 'wait', condition, found: false, url: urlBefore, input: 'none' },
      }
    }
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
        waited_ms: Date.now() - waitStart,
        ...(alreadyTrue ? { condition_met_before_wait: true } : {}),
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
  // frame swaps this for that frame's session, and one inside a same-process
  // frame for a frameId-carrying root target (which routes only the world
  // machinery; commands still ride the root session).
  let elementSession: Cdp = tabId
  let elementFrameTargetId: string | undefined
  /** For the same-process dispatch-point read; refs only. */
  let elementBackendNodeId: number | undefined
  /** Mint-time AX role, refs only: read by the no-layout-box degrade so a
   *  DOCUMENT-LEVEL target names its real story (#202) instead of the
   *  generic hidden-or-zero-size text. */
  let elementMintRole: string | undefined
  /** The widened pre-dispatch probe's answer for the main target, ref or
   *  selector (null when it could not be asked). Read by the refusals below,
   *  by the `target_invisible` annotation, by the selector honesty fields,
   *  and by the pointer-events copy inside the click and check branches. */
  let actionability: Actionability | null = null
  /** The post-resolution facts bag: the selector honesty pair (how many
   *  elements the rule matched, whether the match came from a shadow root)
   *  and, since #201, `resolved_frame`. Declared HERE because these facts
   *  ride every exit from here on, refusals included: a `css=.btn` that
   *  matched 14 and then refused because the first one is disabled needs the
   *  other 13 named exactly as much as a success does (review round). A count
   *  of ONE is not news and is left out, so the fields only ever appear when
   *  there is something to say (the refusal notes' rule). */
  const selectorFacts: Record<string, unknown> = {}
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
      // #201: the payload's frame ATTRIBUTION, into the facts bag that
      // rides every exit from here on, refusals included (the bag's
      // declared rule), and the success/dialog exits via `extra`. Distinct
      // from `focused`, a state read that never moves on hover/scroll_to/
      // drag and so names the PREVIOUS act's frame. Absent on a resolved
      // target it means the root document; resolution state, no round
      // trip, so it survives the budget clamp that drops `focused`. NULL
      // is a value here (#203): a located frame whose URL could not be
      // read still names itself as not-the-root.
      if (resolution.liveFrameUrl !== undefined) {
        selectorFacts.resolved_frame = resolution.liveFrameUrl
      }
      // The widened pre-dispatch probe, for BOTH target classes. A selector
      // target pays exactly the one `callFunctionOn` a ref pays, and gets the
      // same six facts plus the two only a selector has (how many elements
      // the rule matched, whether the match came from a shadow root): the
      // fingerprint's selector-native analogue, since a selector names a rule
      // and has no mint to compare against.
      actionability = await actionabilityBeforeActing(
        resolution.session,
        resolution.objectId,
        resolution.selector,
      )
      // A count of ONE is not news, EXCEPT when a bound cut the search: then
      // the one is a floor, and silence would read as "unambiguous", which is
      // the one thing a cut search cannot establish (review round).
      const capped = actionability?.matchCountCapped === true
      if (
        typeof actionability?.matchCount === 'number' &&
        (actionability.matchCount > 1 || capped)
      ) {
        selectorFacts.selector_matches = actionability.matchCount
      }
      if (capped) selectorFacts.selector_matches_capped = true
      if (actionability?.shadowMatch === true) selectorFacts.matched_in = 'shadow-root'
      // BEFORE anything is sent: a resolvable ref is not a live one. See
      // `detachedRefError`. `null` (the context went away) is unknowable, not
      // a refusal, and falls through to the action's own honest failure.
      // Only for `@` refs: both selector spellings resolve by walking DOWN
      // from `document`, so every node they can return is attached by
      // construction (the shadow walk descends through connected hosts
      // only), and the refusal's "use a fresh ref" advice names something the
      // caller never used.
      if (target.startsWith('@') && actionability?.connected === false) {
        return {
          ok: false,
          status: 'error',
          error: detachedRefError(target, a.action),
          data: {
            action: a.action,
            target,
            stale_refs: true,
            reason: 'detached',
            ...selectorFacts,
          },
        }
      }
      // The mint-fingerprint re-check, for the verbs that dispatch input into
      // the element the agent chose by meaning. Only refs minted WITH a
      // fingerprint are checked: a selector names a RULE and has no mint to
      // compare against, so its analogue is the match count the same probe
      // just read. Only before dispatch, where refusing still honestly means
      // nothing was sent.
      if (FINGERPRINT_VERBS.has(a.action)) {
        const refusal = await fingerprintRefusal(resolution, a.action, target, target)
        // The bag rides this refusal too (resolved_frame; selector facts
        // cannot occur here, refs only). The drag-destination call to the
        // same function deliberately does NOT get it: its data names the
        // SOURCE as target, and stamping the destination's frame under
        // that key would attribute the wrong element (#201 review).
        if (refusal) return { ...refusal, data: { ...(refusal.data ?? {}), ...selectorFacts } }
      }
      // The actionability refusals, from the same probe. AFTER the
      // fingerprint gate on purpose: an element that changed MEANING is the
      // more fundamental problem and its copy sends the agent to re-read,
      // where "it is disabled" would be advice about the wrong element.
      // `input: 'none'` and the pre-dispatch position together are the
      // honesty other refusals here carry: no probe armed, nothing sent.
      if (actionability?.disabled === true && DISABLED_REFUSES.has(a.action)) {
        return {
          ok: false,
          status: 'error',
          error: disabledTargetError(a.action, target),
          data: { action: a.action, target, ...selectorFacts, refused: 'disabled', input: 'none' },
        }
      }
      // (The readonly refusal is NOT here: `readonly` is routinely removed by
      // the field's own focus handler, so it is decided after the focus each
      // text verb performs. See `readonlyAfterFocus`.)
      objectId = resolution.objectId
      elementSession = resolution.session
      elementFrameTargetId = resolution.frameTargetId
      elementBackendNodeId = resolution.backendNodeId
      elementMintRole = resolution.mintRole
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
            ...selectorFacts,
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
  // The old shape (root-session dispatch at root coordinates composed from
  // the frame owner's offset) was measured live 2026-08-15 to NEVER deliver
  // into an OOPIF on the user's Chrome: every event acked ok and nothing
  // arrived, while main-document input landed concurrently in the same tab.

  let inputMode: 'trusted' | 'synthetic' | 'none' = 'none'
  let previousValue: string | null | undefined
  const extra: Record<string, unknown> = {}
  /** The pre-wheel scroll baseline (#203); non-null only for `scroll`,
   *  compared post-settle so smooth scrolling has finished animating. */
  let scrollBaseline: { c: ScrollPair | null; d: ScrollPair | null } | null = null
  let scrollSlotId: string | null = null
  let scrollOverFrame = false
  // Only ever set for a coordinate act: a ref act already names its target,
  // and `target_exists` answers the same question for it more directly. On a
  // drag the point is the SOURCE, so it is named as such rather than left to
  // read as "what the drag hit".
  if (pointTarget) extra[a.action === 'drag' ? 'hit_from' : 'hit'] = pointTarget.description
  // R-07's opacity half: the act PROCEEDS (see INVISIBLE_ANNOTATES) and says
  // what was true of the thing it acted on. Set here, before dispatch, so it
  // rides every exit that carries `extra`, success and dialog alike.
  if (actionability?.visible === false && INVISIBLE_ANNOTATES.has(a.action)) {
    extra.target_invisible = true
  }
  // The selector honesty fields join the bag every later exit carries. The
  // exits that build their own `data` (the refusals above and below, and the
  // three post-dispatch ones) spread `selectorFacts` directly: a rule that
  // matched fourteen elements is at its most useful in a failure, which is
  // exactly where the payload used to drop it (review round).
  Object.assign(extra, selectorFacts)

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
        ...selectorFacts,
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
  const keyboardFocus =
    !objectId && (a.action === 'type' || a.action === 'key')
      ? await keyboardSessionForFocus(tabId)
      : null
  const keyboardSession: Cdp | null = keyboardFocus?.session ?? null
  // #201's keyboard half: the keystrokes' destination frame, claimed at
  // dispatch time (see keyboardSessionForFocus). Set into `extra` directly
  // (it is declared above and every later exit carries it); the resolution
  // path cannot also have set it, since this branch only runs ref-less.
  if (keyboardFocus && keyboardFocus.frameUrl !== undefined) {
    extra.resolved_frame = keyboardFocus.frameUrl
  }
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
            // Read once, used for the dispatch AND for the coordinates a
            // refusal teaches: for a same-process frame target this is a
            // ROOT-space point (coordinate acts DO reach same-process
            // frames), where an OOPIF target's frame-local point stays
            // untaught because bare coordinates could never reach it.
            const dp = await dispatchPointFor(elementSession, elementBackendNodeId, geo.point)
            const teachPoint = frameIdOf(elementSession) ? dp : elementFrameTargetId ? null : geo.point
            const ht = await hitTest(elementSession, objectId, geo.point)
            // Re-asked before it can refuse anything, never on the healthy
            // path: the probe ran several round trips ago (see
            // `stillPointerEventsNone`).
            const peMiss =
              pointerEventsMiss(actionability, ht) &&
              (await stillPointerEventsNone(elementSession, objectId))
            let clickThrough: string | null = null
            if (!ht.hit || peMiss) {
              // #174: a hidden-input editor's render surface (CodeMirror 5,
              // Monaco) is a SIBLING of the real input, so containment can
              // never accept it. A click there is exactly what a person
              // does, and the editor routes it to its input itself; for
              // text-entry targets deliver the click and verify by focus.
              // Everything else keeps the refusal, which now teaches the
              // deliberate click-through instead of dead-ending.
              // The widened pre-dispatch probe already classified the target
              // with this same function body on this same handle, so the
              // covered path spends a call only where that probe could not
              // answer at all (a world failure, a malformed reply).
              const textEntry =
                actionability?.textEntry ?? (await textEntryTarget(elementSession, objectId))
              if (!textEntry) {
                // The target itself ignores pointer events: what the hit test
                // found is simply what the click would hit instead, so naming
                // that element as an interceptor would send the agent after
                // the wrong thing. The coordinate still rides along, because
                // the element the click WOULD hit is quite often the
                // target's own label or wrapper, and clicking that
                // deliberately activates the target (label activation
                // behaviour, delegated handlers). Checked here, after the
                // #174 exception, so a text-entry target's click-through
                // path is untouched.
                if (peMiss) {
                  return {
                    ok: false,
                    status: 'error',
                    error: pointerEventsNoneError(a.action, target, ht.blocker, teachPoint),
                    data: {
                      action: a.action,
                      target,
                      ...selectorFacts,
                      refused: 'pointer_events_none',
                      intercepted_by: ht.blocker ?? null,
                      ...(teachPoint
                        ? { click_point: [Math.round(teachPoint.x), Math.round(teachPoint.y)] }
                        : {}),
                      input: 'none',
                    },
                  }
                }
                return {
                  ok: false,
                  status: 'error',
                  error: coveredPointError(a.action, target, ht.blocker, teachPoint),
                  data: {
                    ...selectorFacts,
                    intercepted_by: ht.blocker ?? null,
                    // A frame-local coordinate is useless to the agent (bare
                    // coordinates are root-space), so an OOPIF target gets
                    // no click_point rather than a mixed-space one.
                    ...(teachPoint
                      ? { click_point: [Math.round(teachPoint.x), Math.round(teachPoint.y)] }
                      : {}),
                  },
                }
              }
              // `ht.hit` true here means the ANCESTOR acceptance: the click
              // lands on something that wraps the target rather than
              // something over it, and the copy below says which.
              clickThrough = ht.blocker ?? 'a covering element'
            }
            if (!dp) {
              // Same-process frame target whose dispatch-space position could
              // not be read: the honest degraded path is the same synthetic
              // dispatch a missing layout box gets, labelled as such.
              await callOn(elementSession, objectId, 'function(){ this.click(); }')
              inputMode = 'synthetic'
              extra.synthetic_reason =
                'the element\'s position on the page could not be read (its frame may be hidden or scrolled away)'
              if (clickThrough) extra.clicked_through = clickThrough
              break
            }
            // The dispatch-space gate (same-process targets only): the
            // frame-local hit test above cannot see a PARENT-document
            // overlay, and this dispatch hit-tests through the whole page.
            {
              const ownerHit = await frameOwnerAtPoint(elementSession, dp)
              if (ownerHit && !ownerHit.hit) {
                return {
                  ok: false,
                  status: 'error',
                  error: frameOccludedError(a.action, target, ownerHit.blocker),
                  data: {
                    ...selectorFacts,
                    intercepted_by: ownerHit.blocker ?? null,
                    occluded_in: 'embedding-document',
                    input: 'none',
                  },
                }
              }
            }
            await trustedClick(elementSession, dp, {
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
                  data: { ...selectorFacts, intercepted_by: ht.blocker ?? null, click_delivered: true },
                }
              }
              if (!landed) {
                return {
                  ok: false,
                  status: 'error',
                  error: clickedThroughButFocusMissedError(
                    a.action,
                    target,
                    ht.blocker,
                    ht.via === 'ancestor',
                  ),
                  data: { ...selectorFacts, intercepted_by: ht.blocker ?? null, click_delivered: true },
                }
              }
              extra.clicked_through = clickThrough
            }
          } else {
            // No layout box (hidden, zero-size). Synthetic dispatch is the only
            // way in, and the result says so rather than implying a real click.
            // A DOCUMENT-LEVEL ref (RootWebArea: the whole-page container a
            // read legitimately mints for focus/scroll targeting) is the
            // no-box shape most likely to fool an agent into believing it
            // clicked a control, so it names its real story (#202; the
            // operator graded refusal worse than the disclosed degrade).
            await callOn(elementSession, objectId, 'function(){ this.click(); }')
            inputMode = 'synthetic'
            extra.synthetic_reason = DOC_LEVEL_ROLES.has(elementMintRole ?? '')
              ? 'target is a document-level container, not an interactive control; nothing specific was clicked'
              : 'element has no layout box (hidden or zero-size)'
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
          const dp = geo
            ? await dispatchPointFor(elementSession, elementBackendNodeId, geo.point)
            : null
          if (dp) {
            await trustedHover(elementSession, dp, modifiers)
            inputMode = 'trusted'
          } else {
            await callOn(
              elementSession,
              objectId,
              'function(){ this.dispatchEvent(new MouseEvent("mouseover", {bubbles:true})); this.dispatchEvent(new MouseEvent("mouseenter", {bubbles:true})); }',
            )
            inputMode = 'synthetic'
            // Every synthetic elsewhere says why; this one predated the rule
            // (#202 survey catch). Two causes reach here and they are
            // different stories, so they get different strings (the click
            // family's convention).
            extra.synthetic_reason = geo
              ? 'the dispatch point could not be resolved for a trusted hover; synthetic hover events were dispatched'
              : 'element has no layout box (hidden or zero-size); synthetic hover events were dispatched'
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
        // AFTER the focus, because focus is what unlocks the commonest
        // readonly field (see `readonlyAfterFocus`). Still before any text
        // goes out, so "no text was sent" stays literally true.
        if (await readonlyAfterFocus(actionability, a.action, elementSession, objectId)) {
          return {
            ok: false,
            status: 'error',
            error: readonlyTargetError(a.action, target),
            data: { action: a.action, target, ...selectorFacts, refused: 'readonly', input: 'none' },
          }
        }
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
          // Same gate as fill, same reason, same position: after the focus
          // that a readonly field's own handler listens for.
          if (await readonlyAfterFocus(actionability, a.action, elementSession, objectId)) {
            return {
              ok: false,
              status: 'error',
              error: readonlyTargetError(a.action, target),
              data: { action: a.action, target, ...selectorFacts, refused: 'readonly', input: 'none' },
            }
          }
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
            data: { action: a.action, target, ...selectorFacts, input: 'none' },
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
            const dp = await dispatchPointFor(elementSession, elementBackendNodeId, geo.point)
            const teachPoint = frameIdOf(elementSession) ? dp : elementFrameTargetId ? null : geo.point
            const ht = await hitTest(elementSession, objectId, geo.point)
            const peMiss =
              pointerEventsMiss(actionability, ht) &&
              (await stillPointerEventsNone(elementSession, objectId))
            if (!ht.hit || peMiss) {
              // Same reading as the click family: a target that ignores
              // pointer events was never covered, so the copy names that
              // instead of blaming the element the click would hit instead,
              // and hands over the same deliberate-click coordinate (a
              // styled checkbox's own label is the everyday case).
              if (peMiss) {
                return {
                  ok: false,
                  status: 'error',
                  error: pointerEventsNoneError(a.action, target, ht.blocker, teachPoint),
                  data: {
                    action: a.action,
                    target,
                    ...selectorFacts,
                    refused: 'pointer_events_none',
                    intercepted_by: ht.blocker ?? null,
                    ...(teachPoint
                      ? { click_point: [Math.round(teachPoint.x), Math.round(teachPoint.y)] }
                      : {}),
                    input: 'none',
                  },
                }
              }
              // Checkboxes are not text entry, so no click-through here; the
              // styled-checkbox pattern (hidden input behind a styled span)
              // exits via the taught coordinate click instead, and the state
              // read that follows any check verifies the outcome.
              return {
                ok: false,
                status: 'error',
                error: coveredPointError(a.action, target, ht.blocker, teachPoint),
                data: {
                  ...selectorFacts,
                  intercepted_by: ht.blocker ?? null,
                  ...(teachPoint
                    ? { click_point: [Math.round(teachPoint.x), Math.round(teachPoint.y)] }
                    : {}),
                },
              }
            }
            if (dp) {
              // Same dispatch-space gate as click: a parent overlay eats the
              // real click, and the force path below would then mask it.
              const ownerHit = await frameOwnerAtPoint(elementSession, dp)
              if (ownerHit && !ownerHit.hit) {
                return {
                  ok: false,
                  status: 'error',
                  error: frameOccludedError(a.action, target, ownerHit.blocker),
                  data: {
                    ...selectorFacts,
                    intercepted_by: ownerHit.blocker ?? null,
                    occluded_in: 'embedding-document',
                    input: 'none',
                  },
                }
              }
              await trustedClick(elementSession, dp, { modifiers, deadline: budgetDeadline })
              inputMode = 'trusted'
            }
            // dp null (same-process frame position unreadable): fall through
            // to the state read-back, whose force path is the honest fallback.
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
        // #203: a targeted scroll wheels AT the resolved element's point on
        // the element's OWN session (frame-local for an OOPIF ref, composed
        // root coordinates for a same-process frame ref: the drag source's
        // exact geometry shape), which scrolls the scrollable CONTAINER
        // under it, the inner-pane case that used to require coordinates.
        // No activation gates apply: wheeling over a disabled or covered
        // element is how scrolling works. And deliberately NO scrollIntoView
        // first, unlike every other point-dispatching verb: bringing the
        // target into view would move the very offsets scroll_moved is
        // about to measure. Do not reintroduce it.
        let at: Point
        let wheelTarget: Cdp = tabId
        if (objectId) {
          scrollSlotId = `s${++scrollSlot}`
          const base = await scrollBase(elementSession, objectId, scrollSlotId, budgetDeadline)
          if (!base || base.p === null) {
            return {
              ok: false,
              status: 'error',
              error:
                "the scroll target's position on the page could not be read (it may " +
                'have no layout box, or its frame is hidden or scrolled away). Nothing ' +
                'was dispatched; scroll by coordinate, or scroll_to an element inside ' +
                'the pane.',
              data: {
                action: 'scroll',
                ...(target ? { target } : {}),
                ...selectorFacts,
                input: 'none',
              },
            }
          }
          if ('off' in base.p) {
            // Wheel input is positional: an off-screen point would scroll
            // whatever happens to be there, and the follow-up read would
            // then report an honest-looking measured zero about the pane
            // the wheel never reached (review round).
            return {
              ok: false,
              status: 'error',
              error:
                'the scroll target is entirely outside the viewport, and wheel input ' +
                'is positional: a wheel at its off-screen point would scroll whatever ' +
                'is there instead. Nothing was dispatched; scroll_to the element ' +
                'first, or scroll by coordinate.',
              data: {
                action: 'scroll',
                ...(target ? { target } : {}),
                ...selectorFacts,
                input: 'none',
              },
            }
          }
          const dp = await dispatchPointFor(elementSession, elementBackendNodeId, base.p)
          if (!dp) {
            // Same-process frame with no readable quads: the element has
            // layout in its frame but no dispatch-space position. One
            // residual gap, recorded: the visible-region gate above runs in
            // the FRAME's viewport, so a frame itself scrolled off the page
            // still dispatches at the quad centre wherever that lands.
            return {
              ok: false,
              status: 'error',
              error:
                "the scroll target's position on the page could not be read (it may " +
                'have no layout box, or its frame is hidden or scrolled away). Nothing ' +
                'was dispatched; scroll by coordinate, or scroll_to an element inside ' +
                'the pane.',
              data: {
                action: 'scroll',
                ...(target ? { target } : {}),
                ...selectorFacts,
                input: 'none',
              },
            }
          }
          at = dp
          wheelTarget = elementSession
          scrollBaseline = base.c || base.d ? { c: base.c, d: base.d } : null
        } else {
          at = pointFrom(a.coordinate) ?? (await viewportCentre(tabId, budgetDeadline))
          scrollSlotId = `s${++scrollSlot}`
          const base = await scrollBaseTargetless(tabId, scrollSlotId, at, budgetDeadline)
          scrollBaseline = base && (base.c || base.d) ? { c: base.c, d: base.d } : null
          scrollOverFrame = base?.f === true
        }
        await trustedWheel(wheelTarget, at, { x: deltaX, y: deltaY }, modifiers)
        inputMode = 'trusted'
        extra.scrolled = { direction, amount_px: amount }
        break
      }
      case 'drag': {
        const fromLocal = objectId ? (await elementGeometry(elementSession, objectId))?.point ?? null : null
        const from = objectId
          ? fromLocal
            ? await dispatchPointFor(elementSession, elementBackendNodeId, fromLocal)
            : null
          : pointFrom(a.coordinate)
        if (objectId && fromLocal && !from) {
          // The element has layout but its dispatch-space position could not
          // be read: name that, never the generic unresolvable-source copy.
          return {
            ok: false,
            status: 'error',
            error:
              "the drag source's position on the page could not be read (its frame may " +
              'be hidden or scrolled away). Nothing was dispatched; retry after making ' +
              'the frame visible.',
            data: { action: 'drag', ...(target ? { target } : {}), input: 'none' },
          }
        }
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
          // (The same probe answers the actionability facts, which drag does
          // not consume: it has no delivery verdict to misdiagnose and no
          // text to enter, so only connectedness is read here.)
          if (
            a.to_ref.startsWith('@') &&
            (await actionabilityBeforeActing(dest.session, dest.objectId))?.connected === false
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
          const toLocal = (await elementGeometry(dest.session, dest.objectId))?.point ?? null
          // Same coordinate-space rule as the source: a same-process frame
          // destination dispatches in the shared session's space (the
          // cross-frame guard above pinned both ends to ONE frame).
          to = toLocal
            ? await dispatchPointFor(dest.session, dest.backendNodeId, toLocal)
            : null
          if (toLocal && !to) {
            return {
              ok: false,
              status: 'error',
              error:
                "the drag destination's position on the page could not be read (its " +
                'frame may be hidden or scrolled away). Nothing was dispatched; retry ' +
                'after making the frame visible.',
              data: { action: 'drag', ...(target ? { target } : {}), input: 'none' },
            }
          }
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
  // #176: snapshot the probe's counters NOW, before the page has a chance to
  // navigate (a successful link click destroys the probe's world along with
  // the document, and with it the per-type counts, leaving the SUCCESS
  // payload data-poorer than the failure one). Raced against a short
  // deadline rather than awaited outright: on a suspended renderer this
  // evaluate would hang its full CDP deadline in front of the liveness
  // check that owns that diagnosis. A late peek result still lands in the
  // probe handle, where the final read can use it.
  if (probe) {
    await Promise.race([probe.peek(), new Promise((r) => setTimeout(r, PEEK_RACE_MS))])
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
        } else if (!chooserInterceptedSince(tabId, startedAt)) {
          // Observed swallowed: stamp the evidence the health read reports
          // (#188). Only the CONCLUSIVE no, because an unknown must not
          // masquerade as observed suppression, and NOT when a file chooser
          // was intercepted: that check outranks `delivered` at the failure
          // site below (interception proves the action ran in the page), so
          // evidence stamped here would contradict the verdict the command
          // itself returns. The cross-clear spends any standing positive
          // stamp: the two stores tell ONE story, the last conclusive
          // verdict, and a stale input_ok beside fresh swallow evidence
          // would be the contradiction (#202; the mirror clear is in the
          // yes branch below).
          recordSwallowedInput(tabId, a.action)
          clearProvenDelivery(tabId)
        }
      } else if (delivered === 'yes') {
        // Proven delivered: whatever was swallowing input has stopped, and
        // the positive stamp carries the SAME verdict this payload ships
        // (#202 QA round: a counted-only gate left the navigating click,
        // the field's design case, unstamped while input_delivered said
        // yes beside it). `urlBefore`/`navSeqBefore` tie the proof to the
        // PRE-navigation document; health judges identity from them.
        clearSwallowedInput(tabId)
        recordProvenDelivery(tabId, a.action, urlBefore, navSeqBefore)
      }
      extra.input_delivered = delivered
      if (delivered === 'unknown' && unknownReason) {
        extra.input_delivered_reason = unknownReason
      }
      // #176 diagnosis fields. The per-type counts split "press arrived,
      // click never composed" from "click composed, default action gated";
      // `default_prevented` names the one page-side gate we can see; the
      // activation state is what navigation-class default actions key on,
      // read from the probed frame itself.
      if (reading.events && Object.keys(reading.events).length > 0) {
        extra.input_events = reading.events
      }
      if (reading.clickDefaultPrevented !== undefined) {
        extra.default_prevented = reading.clickDefaultPrevented
      }
      const clickFamily =
        a.action === 'click' || a.action === 'double_click' || a.action === 'right_click'
      if (reading.userActivation && clickFamily) {
        extra.user_activation = {
          active: reading.userActivation.active,
          has_been_active: reading.userActivation.hasBeenActive,
        }
      }
      if (reading.clickTarget && clickFamily) {
        extra.click_target = reading.clickTarget
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
    // The action itself went in, so this cannot fail the call; it says why
    // the condition was never watchable instead of leaving a bare
    // `found: false` to read as the page's answer.
    if (raced.value.unwatchable) extra.condition_error = raced.value.unwatchable
    // No `condition_met_before_wait` here, deliberately. The fused wait opens
    // AFTER the action has been dispatched and settled, so a condition the
    // action produced is already true at the first check: the flag would ride
    // nearly every successful fused act while saying nothing the caller can
    // act on (review round). `waited_ms` still reports the real cost.
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
  // The mutation tally (#180, QA round 2): the delivery probe's observer
  // has watched the ACTED document since before dispatch; read it now,
  // after settle and the fused wait, so the window spans synchronous
  // handler reactions through the settled page. Null (a navigated
  // document, an unarmable world, a failed read) keeps the key absent:
  // zero is a strong claim and is only ever a measured one. Skipped past
  // the budget deadline like the other renderer-bound enrichment.
  if (probe && !budgetSpent(budgetDeadline)) {
    const tally = await probe.tally()
    if (tally !== null) extra.dom_mutations = tally
  }
  // scroll_moved (#203): the SAME registered scrollers are re-read after
  // settle. Post-settle is the best available moment, not a guarantee:
  // settle is DOM quiescence and offsets mutate nothing, so a slow smooth
  // scroll can still be mid-flight at the read (docstring-taught as a rare
  // {0,0}/partial cause). The container's delta when it moved; else the
  // document's, which is where a wheel CHAINS when the pane is at its end
  // (review round: reporting the untouched container's zero there called a
  // page that visibly scrolled a measured nothing); else a measured zero
  // naming the container when one was watched. Absence means a read
  // failed, never a guess.
  if (scrollBaseline && scrollSlotId && !budgetSpent(budgetDeadline)) {
    const after = await scrollAfter(objectId ? elementSession : tabId, scrollSlotId)
    if (after) {
      const cd =
        scrollBaseline.c && after.c
          ? { dx: after.c.l - scrollBaseline.c.l, dy: after.c.t - scrollBaseline.c.t }
          : null
      const dd =
        scrollBaseline.d && after.d
          ? { dx: after.d.l - scrollBaseline.d.l, dy: after.d.t - scrollBaseline.d.t }
          : null
      if (cd && (cd.dx !== 0 || cd.dy !== 0)) {
        extra.scroll_moved = { ...cd, scroller: 'container' }
      } else if (dd && (dd.dx !== 0 || dd.dy !== 0)) {
        extra.scroll_moved = { ...dd, scroller: 'document' }
      } else if (cd) {
        extra.scroll_moved = { dx: 0, dy: 0, scroller: 'container' }
      } else if (dd && !scrollOverFrame) {
        // A wheel over an embedded frame scrolls a document this probe
        // never watched (#203 QA round: the frame visibly scrolled while
        // the root's honest zero read as "nothing moved"). The zero is
        // withheld there: absence means unmeasured; a real root movement
        // (chaining) still reports above.
        extra.scroll_moved = { dx: 0, dy: 0, scroller: 'document' }
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
  cssResolveExpression,
  NEEDS_TARGET,
  OPENS_FILE_CHOOSER,
  DESCRIBE_ELEMENT,
  SELECTOR_MISS,
  SCROLL_BASE_FN,
  scrollBaseExpression,
  scrollAfterExpression,
}
