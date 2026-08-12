import type { CommandResult } from '../../shared/types'
import { readSince as consoleSince } from '../consoleBuffer'
import { frameSessions, sendCommand, type Cdp } from '../debuggerSession'
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
 * Checked on the ELEMENT rather than by intercepting the chooser, because
 * `Page.setInterceptFileChooserDialog` is page-wide and sticky: leaving it
 * armed means the user clicks their own "Choose File" and nothing happens.
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
 * static distinguishes it from any other button. Closing that one needs
 * `Page.setInterceptFileChooserDialog` armed around the dispatch (it does not
 * require `Page.enable`, so the dialog-ownership trap does not apply), which
 * is filed rather than built: suppression is page-wide, so it must be armed
 * and disarmed around each act, and it converts the wedge into a silent no-op
 * that we then have to report honestly. Backlog #165.
 */
const OPENS_FILE_CHOOSER = `
  const isFile = (el) => !!el && el.tagName === 'INPUT' && el.type === 'file';
  if (isFile(this)) return true;
  if (this.tagName === 'LABEL' && isFile(this.control)) return true;
  const label = this.closest && this.closest('label');
  return !!label && isFile(label.control);
`

/**
 * The same question for a bare coordinate, where there is no resolved node to
 * interrogate.
 *
 * Reads the main world, so a hostile page could in principle hide a file input
 * from this check (the standing `elementFromPoint` caveat, backlog #160). That
 * only returns this path to how it behaved before the guard existed, and the
 * page it protects in practice is an ordinary one with a visible "Choose File"
 * button, so the check is worth having while the isolated-world move is not
 * yet made. Failing to answer counts as NOT a file input: a probe that cannot
 * run must not block an otherwise valid click.
 */
async function pointIsFileInput(tabId: number, point: Point | null): Promise<boolean> {
  if (!point) return false
  try {
    const resp = await sendCommand<{ result?: { value?: boolean } }>(tabId, 'Runtime.evaluate', {
      expression: `(() => { const el = document.elementFromPoint(${Math.round(point.x)}, ${Math.round(point.y)}); if (!el) return false; return (function(){ ${OPENS_FILE_CHOOSER} }).call(el); })()`,
      returnByValue: true,
    })
    return resp.result?.value === true
  } catch {
    return false
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

function stalledError(action: ActionName): string {
  return (
    `the ${action} was NOT sent: this tab did not run a script for several seconds, ` +
    'so it could not have received input. Two things do that. A dialog the PAGE ' +
    'raised (alert, confirm, prompt, or a "Leave site?" on navigation) suspends it ' +
    'until answered, and chrome_dialog cannot clear it: close the tab and redo the ' +
    'work in a fresh one. A long-running script suspends it temporarily: wait a few ' +
    'seconds and retry, and if the retry reports this again it is the dialog.'
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
  // deadline is IN-PAGE and therefore never ticks. Each would wait out its share
  // of the transport timeout to learn the same thing, so the check is worthless
  // anywhere but here. It covers every action, not just the ones with probeable
  // events.
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
    const { found, condition } = await performWait(
      tabId,
      a.wait_for,
      a.timeout_ms ?? DEFAULT_WAIT_MS,
    )
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
    if (ACTIVATES_TARGET.has(a.action)) {
      const onFileInput = objectId
        ? await isFileInput(elementSession, objectId)
        : await pointIsFileInput(tabId, pointFrom(a.coordinate))
      if (onFileInput) {
        return {
          ok: false,
          status: 'error',
          error: fileInputRefusal(target),
          data: { action: a.action, target, refused: 'file_input' },
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

  // Armed AFTER target resolution so the probe cannot count our own setup: the
  // geometry and hit-test reads run in-page, and neither produces any of the
  // event types above.
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

  // Read before settling: a settle that waits for quiet gives a suppressed page
  // 250ms of nothing to happen in, and the probe should reflect the action, not
  // the wait.
  // Read only when this action really did dispatch browser-level input. The
  // synthetic fallbacks (a click on an element with no layout box goes in as
  // `this.click()`) produce no trusted event by definition, and `type ""`
  // dispatches nothing at all; probing either would manufacture a failure for a
  // page with nothing wrong with it.
  // The pre-flight cleared the page BEFORE the action. An action can raise a
  // dialog itself (a click on a submit button with a `beforeunload` handler, a
  // handler that calls `confirm()`), and that case is at least as common as
  // acting into a tab that was already blocked. Everything below here is
  // renderer-bound, including settle, whose own deadline is IN-PAGE and so
  // never ticks on a suspended page. Ask again before spending any of it.
  if (!(await rendererResponsive(tabId))) {
    return {
      ok: false,
      status: 'error',
      error: dispatchedThenStalledError(a.action),
      data: { action: a.action, url: urlBefore, input: inputMode, ...localDiagnostics(tabId, startedAt) },
    }
  }

  let delivered: DeliveryOutcome | null = null
  if (probe && inputMode === 'trusted') {
    delivered = await probe.read()
    // The probe watches the top document only, and this tool deliberately acts
    // inside iframes. A zero count there means "not seen here", not "not
    // delivered", so it is downgraded unless the absence can be confirmed.
    if (delivered === 'no') {
      const conclusive = await absenceIsConclusive(
        tabId,
        objectId ? { session: elementSession, objectId } : null,
      )
      if (!conclusive) delivered = 'unknown'
    }
    extra.input_delivered = delivered
  }

  const settleResult = await settle(tabId)
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

export const __test = { resolveTarget, performWait, buildVerification, NEEDS_TARGET, OPENS_FILE_CHOOSER }
