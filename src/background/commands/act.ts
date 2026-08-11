import type { CommandResult } from '../../shared/types'
import { readSince as consoleSince } from '../consoleBuffer'
import { sendCommand } from '../debuggerSession'
import {
  callOn,
  dispatchKey,
  elementGeometry,
  focusElement,
  hitTest,
  insertText,
  modifierMask,
  scrollIntoView,
  selectAllIn,
  trustedClick,
  trustedDrag,
  trustedHover,
  typeText,
  type Point,
} from '../input'
import { resolve as resolveRef, type StaleReason } from '../snapshotRefs'
import { settle, type SettleResult } from '../settle'

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
  to_coordinate?: [number, number]
  wait_for?: WaitFor
  timeout_ms?: number
  settle?: boolean
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
])

type TargetResolution =
  | { ok: true; objectId: string }
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
    try {
      const resp = await sendCommand<{ object?: { objectId?: string } }>(tabId, 'DOM.resolveNode', {
        backendNodeId: resolution.backendNodeId,
      })
      const objectId = resp.object?.objectId
      if (!objectId) {
        return {
          ok: false,
          error: `ref ${target} no longer exists in the page (re-read the page)`,
          stale: 'unknown-ref',
        }
      }
      return { ok: true, objectId }
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
    return { ok: true, objectId: evald.result.objectId }
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

async function stillConnected(tabId: number, objectId: string | null): Promise<boolean | null> {
  if (!objectId) return null
  try {
    return await callOn<boolean>(tabId, objectId, 'function(){ return this.isConnected === true; }')
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
  inputMode: 'trusted' | 'synthetic' | 'none'
  settleResult: SettleResult | null
  previousValue?: string | null
  extra?: Record<string, unknown>
}

async function buildVerification(v: VerificationInput): Promise<Record<string, unknown>> {
  const urlAfter = await currentUrl(v.tabId)
  const [targetExists, focused] = await Promise.all([
    stillConnected(v.tabId, v.objectId),
    describeFocused(v.tabId),
  ])
  const errors = consoleSince(v.tabId, v.startedAt, {
    only_errors: true,
    limit: MAX_CONSOLE_IN_RESULT,
  })
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
async function readValue(tabId: number, objectId: string): Promise<string | null> {
  try {
    return await callOn<string | null>(
      tabId,
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
      inputMode: 'none',
      settleResult: null,
      extra: { condition, found, waited_ms: Date.now() - startedAt },
    })
    return { ok: found, status: found ? 'success' : 'error', data, ...(found ? {} : { error: `wait timed out on ${condition}` }) }
  }

  let objectId: string | null = null
  if (NEEDS_TARGET.has(a.action)) {
    const explicitPoint = pointFrom(a.coordinate)
    if (!target && !explicitPoint) {
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
    }
  }

  let inputMode: 'trusted' | 'synthetic' | 'none' = 'none'
  let previousValue: string | null | undefined
  const extra: Record<string, unknown> = {}

  try {
    switch (a.action) {
      case 'click':
      case 'double_click':
      case 'right_click': {
        const button = a.action === 'right_click' ? 'right' : 'left'
        const clickCount = a.action === 'double_click' ? 2 : 1
        const explicitPoint = pointFrom(a.coordinate)
        if (objectId) {
          await scrollIntoView(tabId, objectId)
          const geo = await elementGeometry(tabId, objectId)
          if (geo) {
            const ht = await hitTest(tabId, objectId, geo.point)
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
            await trustedClick(tabId, geo.point, { button, clickCount, modifiers })
            inputMode = 'trusted'
          } else {
            // No layout box (hidden, zero-size). Synthetic dispatch is the only
            // way in, and the result says so rather than implying a real click.
            await callOn(tabId, objectId, 'function(){ this.click(); }')
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
          await scrollIntoView(tabId, objectId)
          const geo = await elementGeometry(tabId, objectId)
          if (geo) {
            await trustedHover(tabId, geo.point, modifiers)
            inputMode = 'trusted'
          } else {
            await callOn(
              tabId,
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
        previousValue = await readValue(tabId, objectId)
        await scrollIntoView(tabId, objectId)
        await focusElement(tabId, objectId)
        await selectAllIn(tabId, objectId)
        await insertText(tabId, a.value)
        inputMode = 'trusted'
        break
      }
      case 'type': {
        if (a.value == null) return { ok: false, status: 'error', error: 'type requires value' }
        if (objectId) {
          await focusElement(tabId, objectId)
          previousValue = await readValue(tabId, objectId)
        }
        await typeText(tabId, a.value)
        inputMode = 'trusted'
        break
      }
      case 'key': {
        if (!a.value) return { ok: false, status: 'error', error: 'key requires value (the key name)' }
        if (objectId) await focusElement(tabId, objectId)
        await dispatchKey(tabId, a.value, modifiers)
        inputMode = 'trusted'
        break
      }
      case 'select': {
        if (a.value == null) return { ok: false, status: 'error', error: 'select requires value' }
        if (!objectId) return { ok: false, status: 'error', error: 'select requires ref' }
        previousValue = await readValue(tabId, objectId)
        // Native <select> popups cannot be driven through CDP input, so this
        // is a deliberate synthetic path. Match on option value first, then on
        // visible label, which is what a human is reading.
        const matched = await callOn<boolean>(
          tabId,
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
        previousValue = await readValue(tabId, objectId)
        const already = previousValue === String(want)
        if (!already) {
          // Click it like a person would; only force the property if the real
          // click did not take (some custom widgets swallow it).
          await scrollIntoView(tabId, objectId)
          const geo = await elementGeometry(tabId, objectId)
          if (geo) {
            const ht = await hitTest(tabId, objectId, geo.point)
            if (ht.hit) {
              await trustedClick(tabId, geo.point, { modifiers })
              inputMode = 'trusted'
            }
          }
          const now = await readValue(tabId, objectId)
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
        await scrollIntoView(tabId, objectId)
        break
      }
      case 'scroll': {
        const amount = a.amount_px ?? 500
        const direction = a.direction ?? 'down'
        const deltaX = direction === 'left' ? -amount : direction === 'right' ? amount : 0
        const deltaY = direction === 'up' ? -amount : direction === 'down' ? amount : 0
        const at = pointFrom(a.coordinate) ?? (await viewportCentre(tabId))
        await sendCommand(tabId, 'Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: Math.round(at.x),
          y: Math.round(at.y),
          deltaX,
          deltaY,
          modifiers,
        })
        inputMode = 'trusted'
        extra.scrolled = { direction, amount_px: amount }
        break
      }
      case 'drag': {
        const from = objectId
          ? (await elementGeometry(tabId, objectId))?.point ?? null
          : pointFrom(a.coordinate)
        let to = pointFrom(a.to_coordinate)
        if (!to && a.to_ref) {
          const dest = await resolveTarget(tabId, a.to_ref, urlBefore)
          if (!dest.ok) return { ok: false, status: 'error', error: `drag destination: ${dest.error}` }
          to = (await elementGeometry(tabId, dest.objectId))?.point ?? null
        }
        if (!from || !to) {
          return {
            ok: false,
            status: 'error',
            error: 'drag needs a resolvable source and destination (ref/coordinate to to_ref/to_coordinate)',
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
    return { ok: false, status: 'error', error: `${a.action} failed: ${String(e)}` }
  }

  const settleResult = a.settle === false ? null : await settle(tabId)
  const data = await buildVerification({
    action: a.action,
    target,
    tabId,
    startedAt,
    urlBefore,
    objectId,
    inputMode,
    settleResult,
    previousValue,
    extra,
  })
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

export const __test = { resolveTarget, performWait, buildVerification, NEEDS_TARGET }
