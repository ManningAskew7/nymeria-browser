import type { CommandResult } from '../../shared/types'
import { readSince as consoleSince } from '../consoleBuffer'
import { CdpCallTimeout, frameSessions, sendCommand, TabUnusable, type Cdp } from '../debuggerSession'
import { absenceIsConclusive, armDelivery, type DeliveryOutcome } from '../delivery'
import {
  ackWithinDeadline,
  callOn,
  dispatchKey,
  elementGeometry,
  focusElement,
  hitTest,
  InputDispatchStalled,
  insertText,
  modifierMask,
  frameOffset,
  scrollIntoView,
  selectAllIn,
  trustedClick,
  trustedDrag,
  trustedHover,
  trustedWheel,
  typeText,
  type Point,
} from '../input'
import { failuresSince as networkFailuresSince } from '../networkBuffer'
import { resolve as resolveRef, type StaleReason } from '../snapshotRefs'
import { rendererResponsive, settle, type SettleResult } from '../settle'
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
 * The evidence a stalled page cannot stop us collecting.
 *
 * Console lines and failed requests come from local buffers fed by CDP events,
 * so they need nothing from the suspended renderer. They are also the only
 * thing that separates the two causes the stall message refuses to choose
 * between: an uncaught page error next to a stall points at a script, silence
 * points at a dialog. A failure that drops them is a worse trade than the
 * silent success this whole mechanism replaced.
 */
function localDiagnostics(tabId: number, startedAt: number): Record<string, unknown> {
  const errors = consoleSince(tabId, startedAt, { only_errors: true, limit: MAX_CONSOLE_IN_RESULT })
  const failedRequests = networkFailuresSince(tabId, startedAt, MAX_CONSOLE_IN_RESULT)
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
 * Reads the main world, so a hostile page could in principle lie about both
 * answers (the standing `elementFromPoint` caveat, backlog #160). For the
 * guard that only returns this path to how it behaved before the guard
 * existed; for the description it is one more page-derived string, which the
 * whole payload already is. Failing to answer counts as NOT a file input: a
 * probe that cannot run must not block an otherwise valid click.
 */
async function describePoint(tabId: number, point: Point | null): Promise<PointTarget | null> {
  if (!point) return null
  try {
    const resp = await sendCommand<{ result?: { value?: PointTarget | null } }>(
      tabId,
      'Runtime.evaluate',
      {
        // The verdict is computed FIRST and the description is separately
        // guarded, so a page whose getters throw loses the label and keeps the
        // safety answer. The other order let a hostile `textContent` getter
        // delete the file-input refusal.
        expression: `(() => {
          const el = document.elementFromPoint(${Math.round(point.x)}, ${Math.round(point.y)});
          if (!el) return null;
          const opens = (function(){ ${OPENS_FILE_CHOOSER} }).call(el) === true;
          const description = (function(){ ${DESCRIBE_ELEMENT} }).call(el);
          return { description: String(description || 'unknown'), opensFileChooser: opens };
        })()`,
        returnByValue: true,
      },
    )
    return resp.result?.value ?? null
  } catch {
    return null
  }
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
      ...localDiagnostics(tabId, startedAt),
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

type TargetResolution =
  /** `session` is the CDP addressee that OWNS the node: a cross-origin frame
   *  has its own session, and its objectIds are meaningless anywhere else. */
  | { ok: true; objectId: string; session: Cdp; sessionId?: string }
  | { ok: false; error: string; stale?: StaleReason }

async function currentUrl(tabId: number): Promise<string | null> {
  try {
    const tab = await chrome.tabs.get(tabId)
    return tab?.url ?? null
  } catch {
    return null
  }
}

/**
 * Resolve a target to a CDP Runtime objectId.
 *
 * `@e5`      -> snapshot ref, validated against the URL it was minted on
 * `css=...`  -> document.querySelector
 * `xpath=...`-> document.evaluate
 *
 * A stale ref returns a typed error naming the fix rather than resolving a
 * backendNodeId that now points into a different document.
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
    const session: Cdp = resolution.sessionId
      ? { tabId, sessionId: resolution.sessionId }
      : tabId
    try {
      const resp = await sendCommand<{ object?: { objectId?: string } }>(
        session,
        'DOM.resolveNode',
        { backendNodeId: resolution.backendNodeId },
      )
      const objectId = resp.object?.objectId
      if (!objectId) {
        return {
          ok: false,
          error: `ref ${target} no longer exists in the page (re-read the page)`,
          stale: 'unknown-ref',
        }
      }
      return { ok: true, objectId, session, sessionId: resolution.sessionId }
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
    const evald = await sendCommand<{ result: { objectId?: string; subtype?: string } }>(
      tabId,
      'Runtime.evaluate',
      { expression, returnByValue: false },
    )
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
}

async function describeFocused(tabId: number): Promise<FocusedDescription | null> {
  try {
    const resp = await sendCommand<{ result?: { value?: FocusedDescription | null } }>(
      tabId,
      'Runtime.evaluate',
      {
        expression: `(function(){
          const el = document.activeElement;
          if (!el || el === document.body || el === document.documentElement) return null;
          const raw = el.getAttribute('aria-label') || el.getAttribute('name')
            || el.getAttribute('placeholder') || (el.innerText || '');
          return { tag: el.tagName.toLowerCase(), label: String(raw || '').trim().slice(0, 60) };
        })()`,
        returnByValue: true,
      },
    )
    return resp.result?.value ?? null
  } catch {
    return null
  }
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
  objectId: string | null
  elementSession: Cdp
  inputMode: 'trusted' | 'synthetic' | 'none'
  settleResult: SettleResult | null
  previousValue?: string | null
  extra?: Record<string, unknown>
}

async function buildVerification(v: VerificationInput): Promise<Record<string, unknown>> {
  const urlAfter = await currentUrl(v.tabId)
  const [targetExists, focused] = await Promise.all([
    stillConnected(v.elementSession, v.objectId),
    describeFocused(v.tabId),
  ])
  const errors = consoleSince(v.tabId, v.startedAt, {
    only_errors: true,
    limit: MAX_CONSOLE_IN_RESULT,
  })
  // A request that came back 500 without throwing is the commonest silent
  // failure on a real site, and it never reaches the console.
  const failedRequests = networkFailuresSince(v.tabId, v.startedAt, MAX_CONSOLE_IN_RESULT)
  return {
    action: v.action,
    ...(v.target ? { target: v.target } : {}),
    url: urlAfter,
    url_changed: Boolean(v.urlBefore && urlAfter && v.urlBefore !== urlAfter),
    ...(targetExists === null ? {} : { target_exists: targetExists }),
    ...(v.previousValue === undefined ? {} : { previous_value: v.previousValue }),
    ...(focused ? { focused } : {}),
    input: v.inputMode,
    ...(v.settleResult ? { settled: v.settleResult } : {}),
    ...(errors.length ? { console_errors: errors } : {}),
    ...(failedRequests.length ? { failed_requests: failedRequests } : {}),
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
  const condition = waitFor?.text
    ? `text:${waitFor.text}`
    : waitFor?.ref
      ? `ref:${waitFor.ref}`
      : waitFor?.url_contains
        ? `url_contains:${waitFor.url_contains}`
        : 'settle'

  if (!waitFor || (!waitFor.text && !waitFor.ref && !waitFor.url_contains)) {
    const result = await settle(tabId, { maxMs: timeoutMs })
    return { found: result.settled, condition }
  }

  for (;;) {
    if (waitFor.url_contains) {
      const url = await currentUrl(tabId)
      if (url && url.includes(waitFor.url_contains)) return { found: true, condition }
    }
    if (waitFor.text) {
      try {
        const resp = await sendCommand<{ result?: { value?: boolean } }>(tabId, 'Runtime.evaluate', {
          expression: `document.body ? document.body.innerText.includes(${JSON.stringify(waitFor.text)}) : false`,
          returnByValue: true,
        })
        if (resp.result?.value === true) return { found: true, condition }
      } catch {
        // Context churn mid-wait: keep polling until the deadline.
      }
    }
    if (waitFor.ref) {
      const url = await currentUrl(tabId)
      const target = await resolveTarget(tabId, waitFor.ref, url)
      if (target.ok) {
        const connected = await stillConnected(tabId, target.objectId)
        if (connected !== false) return { found: true, condition }
      }
    }
    if (Date.now() >= deadline) return { found: false, condition }
    await new Promise((r) => setTimeout(r, WAIT_POLL_MS))
  }
}

export async function execAct(args: unknown): Promise<CommandResult> {
  const a = args as ActArgs
  if (typeof a.tab_id !== 'number') return { ok: false, status: 'error', error: 'tab_id required' }
  if (!a.action) return { ok: false, status: 'error', error: 'action required' }

  const tabId = a.tab_id
  const startedAt = Date.now()

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
        ...localDiagnostics(tabId, startedAt),
      },
    }
  }
  if (!(await rendererResponsive(tabId))) {
    return {
      ok: false,
      status: 'error',
      error: stalledError(a.action),
      data: { action: a.action, ...localDiagnostics(tabId, startedAt) },
    }
  }

  const urlBefore = await currentUrl(tabId)
  const modifiers = modifierMask(a.modifiers)
  const target = a.ref ?? null

  // `wait` never mutates the page, so it skips target resolution and settle.
  if (a.action === 'wait') {
    // Raced against a dialog opening mid-wait (#169): the poll loop's
    // evaluates would otherwise queue behind the suspended renderer and burn
    // the whole timeout learning nothing, when the cause is known by name
    // the moment it opens.
    const raced = await raceStandingDialog(
      tabId,
      performWait(tabId, a.wait_for, a.timeout_ms ?? DEFAULT_WAIT_MS),
    )
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
          ...localDiagnostics(tabId, startedAt),
        },
      }
    }
    const { found, condition } = raced.value
    const data = await buildVerification({
      action: 'wait',
      target: null,
      tabId,
      startedAt,
      urlBefore,
      objectId: null,
      elementSession: tabId,
      inputMode: 'none',
      settleResult: null,
      extra: { condition, found, waited_ms: Date.now() - startedAt },
    })
    return { ok: found, status: found ? 'success' : 'error', data, ...(found ? {} : { error: `wait timed out on ${condition}` }) }
  }

  let objectId: string | null = null
  // Default addressee is the root page session; a ref inside a cross-origin
  // frame swaps this for that frame's session.
  let elementSession: Cdp = tabId
  let elementFrameId: string | undefined
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
      objectId = resolution.objectId
      elementSession = resolution.session
      if (resolution.sessionId) {
        elementFrameId = frameSessions(tabId).find(
          (f) => f.sessionId === resolution.sessionId,
        )?.targetId
      }
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

  /**
   * Where to dispatch a pointer event for the resolved element.
   *
   * Geometry is read in the element's own session (frame-local for an
   * iframe), but Input.* goes in on the ROOT session in root coordinates:
   * Chrome hit-tests the point and routes the event into the right widget.
   * So a frame element's rect must be composed with the frame's offset.
   */
  const dispatchPoint = async (local: Point): Promise<Point> => {
    if (!elementFrameId) return local
    const offset = await frameOffset(tabId, elementFrameId)
    return { x: local.x + offset.x, y: local.y + offset.y }
  }

  let inputMode: 'trusted' | 'synthetic' | 'none' = 'none'
  let previousValue: string | null | undefined
  const extra: Record<string, unknown> = {}
  // Only ever set for a coordinate act: a ref act already names its target,
  // and `target_exists` answers the same question for it more directly. On a
  // drag the point is the SOURCE, so it is named as such rather than left to
  // read as "what the drag hit".
  if (pointTarget) extra[a.action === 'drag' ? 'hit_from' : 'hit'] = pointTarget.description

  // Armed AFTER target resolution so the probe cannot count our own setup: the
  // geometry and hit-test reads run in-page, and neither produces any of the
  // event types above. (The chooser watcher that used to ride this probe is
  // gone: `Page.fileChooserOpened` + interception cover every route it could
  // see and the ones it could not; see `fileChooserInterceptedError`.)
  const probeTypes = PROBE_EVENTS[a.action]
  const probe = probeTypes ? await armDelivery(tabId, probeTypes) : null

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
            if (!ht.hit) {
              return {
                ok: false,
                status: 'error',
                error:
                  `the click point for ${target} is covered by ${ht.blocker ?? 'another element'}. ` +
                  'Dismiss the overlay (or scroll it out of the way) and retry.',
                data: { intercepted_by: ht.blocker ?? null },
              }
            }
            await trustedClick(tabId, await dispatchPoint(geo.point), {
              button,
              clickCount,
              modifiers,
            })
            inputMode = 'trusted'
          } else {
            // No layout box (hidden, zero-size). Synthetic dispatch is the only
            // way in, and the result says so rather than implying a real click.
            await callOn(elementSession, objectId, 'function(){ this.click(); }')
            inputMode = 'synthetic'
            extra.synthetic_reason = 'element has no layout box (hidden or zero-size)'
          }
        } else if (explicitPoint) {
          await trustedClick(tabId, explicitPoint, { button, clickCount, modifiers })
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
            await trustedHover(tabId, await dispatchPoint(geo.point), modifiers)
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
        await insertText(tabId, a.value)
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
          await typeText(tabId, a.value)
          inputMode = 'trusted'
        }
        break
      }
      case 'key': {
        if (!a.value) return { ok: false, status: 'error', error: 'key requires value (the key name)' }
        if (objectId) await focusElement(elementSession, objectId)
        await dispatchKey(tabId, a.value, modifiers)
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
              return {
                ok: false,
                status: 'error',
                error:
                  `the ${a.action} point for ${target} is covered by ${ht.blocker ?? 'another element'}. ` +
                  'Dismiss the overlay and retry.',
                data: { intercepted_by: ht.blocker ?? null },
              }
            }
            await trustedClick(tabId, await dispatchPoint(geo.point), { modifiers })
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
              tabId,
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
        const at = pointFrom(a.coordinate) ?? (await viewportCentre(tabId))
        await trustedWheel(tabId, at, { x: deltaX, y: deltaY }, modifiers)
        inputMode = 'trusted'
        extra.scrolled = { direction, amount_px: amount }
        break
      }
      case 'drag': {
        const localFrom = objectId
          ? (await elementGeometry(elementSession, objectId))?.point ?? null
          : pointFrom(a.coordinate)
        const from = localFrom ? await dispatchPoint(localFrom) : null
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
          const destLocal = (await elementGeometry(dest.session, dest.objectId))?.point ?? null
          if (destLocal && dest.sessionId) {
            const destFrame = frameSessions(tabId).find((f) => f.sessionId === dest.sessionId)
            const offset = destFrame ? await frameOffset(tabId, destFrame.targetId) : { x: 0, y: 0 }
            to = { x: destLocal.x + offset.x, y: destLocal.y + offset.y }
          } else {
            to = destLocal
          }
        }
        if (!from || !to) {
          return {
            ok: false,
            status: 'error',
            error: 'drag needs a resolvable source (ref or coordinate) and a to_ref destination',
          }
        }
        await trustedDrag(tabId, from, to, modifiers)
        inputMode = 'trusted'
        break
      }
      default:
        return { ok: false, status: 'error', error: `unknown action: ${String(a.action)}` }
    }
  } catch (e) {
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
            extra,
          )
        }
        // The action itself never went out (the stall hit the opening
        // pointer move), so unlike the landed case a retry after answering
        // is the right move, which is exactly what this copy teaches.
        return {
          ok: false,
          status: 'error',
          error: dialogBlockedActError(a.action, tabId, stallDialog),
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
          ...localDiagnostics(tabId, startedAt),
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
      return pendingDialogResult(a.action, target, tabId, raised, inputMode, startedAt, extra)
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
      return pendingDialogResult(a.action, target, tabId, lateDialog, inputMode, startedAt, extra)
    }
    return {
      ok: false,
      status: 'error',
      error: dispatchedThenStalledError(a.action),
      data: { action: a.action, url: urlBefore, input: inputMode, ...localDiagnostics(tabId, startedAt) },
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
      // The probe watches the top document only, and this tool deliberately
      // acts inside iframes. A zero count there means "not seen here", not
      // "not delivered", so it is downgraded unless the absence can be
      // confirmed.
      if (delivered === 'no') {
        const conclusive = await absenceIsConclusive(
          tabId,
          objectId ? { session: elementSession, objectId } : null,
        )
        if (!conclusive) delivered = 'unknown'
      }
      extra.input_delivered = delivered
    }
  }

  const settleResult = await settle(tabId)
  // A dialog can open DURING settle too (a deferred handler); the check must
  // come before `buildVerification`, whose probes are renderer-bound and
  // would each ride their deadline against the suspended page.
  {
    const late = standingDialog(tabId)
    if (late) {
      return pendingDialogResult(a.action, target, tabId, late, inputMode, startedAt, extra)
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
    objectId,
    elementSession,
    inputMode,
    settleResult,
    previousValue,
    extra,
  })
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

async function viewportCentre(tabId: number): Promise<Point> {
  try {
    const resp = await sendCommand<{ result?: { value?: { x: number; y: number } } }>(
      tabId,
      'Runtime.evaluate',
      {
        expression: '({ x: window.innerWidth / 2, y: window.innerHeight / 2 })',
        returnByValue: true,
      },
    )
    const value = resp.result?.value
    if (value && typeof value.x === 'number') return value
  } catch {
    // fall through
  }
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
