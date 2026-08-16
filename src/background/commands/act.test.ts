import { beforeEach, describe, expect, it, vi } from 'vitest'
import { execAct, __test } from './act'
import { CdpCallTimeout, resetForTests as resetDebugger } from '../debuggerSession'
import { push as pushConsole, resetForTests as resetConsole } from '../consoleBuffer'
import { push as pushNetwork, resetForTests as resetNetwork } from '../networkBuffer'
import { resetForTests as resetDelivery } from '../delivery'
import {
  chooserInterceptedSince,
  raceStandingDialog,
  resolvedDialogSince,
  standingDialog,
  type StandingDialog as StandingDialogT,
} from '../dialogs'
import { installNavWatch, resetForTests as resetNavWatch } from '../navWatch'
import { resetForTests as resetRefs, set as setRefs, type RefTarget } from '../snapshotRefs'

// The dialogs seam is mocked so each test INJECTS a recorded dialog state
// rather than re-driving the CDP event plumbing (which has its own tests in
// dialogs.test.ts), the same split the delivery probe uses. Everything not
// overridden keeps its real implementation, notably the message and payload
// helpers the assertions below read.
vi.mock('../dialogs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../dialogs')>()
  return {
    ...actual,
    standingDialog: vi.fn(actual.standingDialog),
    chooserInterceptedSince: vi.fn(actual.chooserInterceptedSince),
    resolvedDialogSince: vi.fn(actual.resolvedDialogSince),
    raceStandingDialog: vi.fn(actual.raceStandingDialog),
  }
})

const TAB = 1
const TAB_URL = 'https://example.com'

/**
 * A ref minted the way snapshot.ts now mints them: fingerprint included and
 * REQUIRED. Defaults match the mock's AX answers (role button, name Pay), so
 * the whole suite runs with the fingerprint gate ACTIVE and passing; drift
 * tests override the mint side to force a mismatch.
 */
const fpRef = (backendNodeId: number, extra: Partial<RefTarget> = {}): RefTarget => ({
  backendNodeId,
  role: 'button',
  name: 'Pay',
  ...extra,
})

interface MockOptions {
  /** null means the element has no layout box (hidden / zero-size). */
  geometry?: { x: number; y: number; w: number; h: number } | null
  /** The hit test's whole answer, `via` included: WHICH containment
   *  accepted a hit decides whether a pointer-events:none target was
   *  actually reached. */
  hit?: { hit: boolean; blocker?: string; via?: 'self' | 'descendant' | 'ancestor' }
  value?: string | null
  resolveNode?: boolean
  settleValue?: string
  bodyText?: string
  selectMatches?: boolean
  /** false models a tab where the delivery probe's world cannot be created. */
  deliveryWorld?: boolean
  /** false models a tab where the TRUST probes' world cannot be created. */
  probeWorld?: boolean
  /** How many events the page saw. 0 is the suppressed-tab case. */
  deliveryCount?: number
  /** Full probe-read value, overriding `deliveryCount`: models the enriched
   * #176 shape (`types` per-event counts, `prevented`, `ua`). */
  deliveryRead?: Record<string, unknown>
  /** Value the post-dispatch PEEK returns (the read's non-disarming twin);
   * unset models a peek that found nothing. */
  deliveryPeek?: Record<string, unknown>
  /** Thrown by the probe read, to model a context that died mid-action. */
  deliveryReadThrows?: string
  /**
   * true models a renderer suspended by a page dialog: EVERY renderer-bound
   * call queues behind it, not just one. Hanging a single method would model a
   * slow call and would pass even if the liveness check were removed.
   */
  rendererHangs?: boolean
  /** true models an action that RAISES a dialog: healthy until input lands. */
  rendererHangsAfterDispatch?: boolean
  /**
   * Models the SYNCHRONOUS dialog: Chrome acks `Input.dispatch*` only after
   * the renderer has processed the event, so a handler that calls `alert()`
   * blocks the ack itself and the dispatch await never returns. Measured live
   * 2026-08-12; `rendererHangsAfterDispatch` cannot model it, because there
   * the Input call resolves and only the NEXT call hangs.
   *
   * The VALUE is the 1-indexed Input event to stall from, and it matters: a
   * click emits a preparatory mouseMoved before its press, so 1 models a
   * blocking hover handler (nothing landed) and 2 models the real alert case
   * (the press landed). A boolean could only ever have expressed the first.
   */
  inputAckHangsFrom?: number
  /** true models input[type=file], whose activation opens the OS chooser. */
  isFileInput?: boolean
  /** false models a ref that still resolves but is detached from the document. */
  targetConnected?: boolean
  /** true models a control the browser matches `:disabled` (never acts). */
  disabled?: boolean
  /** true models `readOnly` on the target; only meaningful with `textEntry`. */
  readonly?: boolean
  /**
   * What `checkVisibility({checkOpacity, checkVisibilityCSS})` answers.
   * `false` is the opacity-0 case that still WINS the hit test (R-07). A
   * browser that cannot answer at all is modelled with `actionabilityRaw`,
   * since the real probe then OMITS the field.
   */
  visible?: boolean
  /** true models a target whose computed `pointer-events` is `none`. */
  pointerEventsNone?: boolean
  /**
   * The anti-autofill / date-picker pattern: `readonly` until the field's
   * own focus handler removes it, so the post-focus re-ask answers no and
   * the fill must go through.
   */
  readonlyClearsOnFocus?: boolean
  /** A transition that finished between the probe and the hit test, so the
   *  pre-refusal re-ask finds the element clickable after all. */
  pointerEventsClearsBeforeRefusal?: boolean
  /**
   * Answer the widened pre-dispatch probe with this VERBATIM, overriding
   * every field above: for the malformed/partial answers whose whole point
   * is that they are not the shape the code expects.
   */
  actionabilityRaw?: unknown
  /** Fail the widened probe with an ORDINARY error (a dead context, not a
   *  session-layer failure), which must not block the act. */
  actionabilityThrows?: string
  /** What the AX tree reports for the node NOW (the fingerprint re-check). */
  axRole?: string
  axName?: string
  /** true models a node that left the AX tree (hidden since the read). */
  axIgnored?: boolean
  /** 'timeout' models the session layer failing the connectedness probe. */
  connectedThrows?: 'timeout'
  /** true models the page asking for the OS file chooser during the action. */
  fileChooserOpened?: boolean
  /** What `elementFromPoint` finds under a bare coordinate. */
  pointDescription?: string
  /** true classifies the ref'd element as a text-entry control (#174). */
  textEntry?: boolean
  /** Whether focus landed in the target after a clicked-through covered click. */
  focusLanded?: boolean
  /** Thrown by the focus read, to model a context destroyed by a navigation. */
  focusReadThrows?: string
  /** true models a document containing iframes, where the probe sees one only. */
  pageHasFrames?: boolean
  /** false models a target inside an iframe the probe never watched. */
  targetInTopDocument?: boolean
}

/**
 * A CDP mock that answers by inspecting what is actually being asked, so the
 * tests assert on the wire traffic an action produces rather than on internal
 * call order.
 */
function installCdpMock(opts: MockOptions = {}) {
  const {
    geometry = { x: 50, y: 60, w: 100, h: 20 },
    hit = { hit: true },
    value = 'old value',
    resolveNode = true,
    settleValue = 'quiet',
    bodyText = '',
    selectMatches = true,
    deliveryWorld = true,
    probeWorld = true,
    deliveryCount = 1,
    deliveryRead,
    deliveryPeek,
    deliveryReadThrows,
    rendererHangs,
    rendererHangsAfterDispatch,
    inputAckHangsFrom,
    isFileInput = false,
    targetConnected = true,
    disabled = false,
    readonly = false,
    visible = true,
    pointerEventsNone = false,
    readonlyClearsOnFocus = false,
    pointerEventsClearsBeforeRefusal = false,
    actionabilityRaw,
    actionabilityThrows,
    axRole = 'button',
    axName = 'Pay',
    axIgnored = false,
    connectedThrows,
    fileChooserOpened = false,
    pointDescription = 'body',
    pageHasFrames = false,
    targetInTopDocument = true,
    textEntry = false,
    focusLanded = true,
    focusReadThrows,
  } = opts
  // Two worlds, two context ids: the delivery probe's (its counter state) and
  // the trust probes' (geometry, hit tests, selectors). Distinct so a test can
  // fail one without the other, and so routing on contextId cannot conflate
  // them.
  const DELIVERY_CONTEXT = 77
  const TRUST_CONTEXT = 88
  let dispatched = false
  let inputEvents = 0

  // Every method that needs the renderer's main thread. A page suspended by its
  // own dialog answers NONE of them, which is what makes a single-method hang
  // the wrong model: it would pass with the liveness check deleted.
  const RENDERER_BOUND = new Set([
    'Runtime.evaluate',
    'Runtime.callFunctionOn',
    'DOM.resolveNode',
    'Page.createIsolatedWorld',
  ])

  const sendCommand = vi.fn(async (_target: unknown, method: string, params: Record<string, unknown> = {}) => {
    if (rendererHangs && RENDERER_BOUND.has(method)) return new Promise<never>(() => {})
    // Recorded BEFORE the ack-hang return, so combining this with
    // `rendererHangsAfterDispatch` models what it reads as.
    if (method.startsWith('Input.')) {
      dispatched = true
      inputEvents += 1
      if (inputAckHangsFrom && inputEvents >= inputAckHangsFrom) return new Promise<never>(() => {})
    }
    if (rendererHangsAfterDispatch && dispatched && RENDERER_BOUND.has(method)) {
      return new Promise<never>(() => {})
    }
    if (method === 'DOM.resolveNode') {
      // #160 enforcement: element handles must be minted IN the probe world.
      // A world-less resolve is a main-world handle, the exact regression this
      // mock exists to catch, so it fails the test loudly rather than passing.
      if (params.executionContextId !== TRUST_CONTEXT) {
        throw new Error('DOM.resolveNode without the probe world: main-world handle regression')
      }
      return resolveNode ? { object: { objectId: 'obj-1' } } : { object: {} }
    }
    if (method === 'Runtime.callFunctionOn') {
      const fn = String(params.functionDeclaration ?? '')
      // The widened pre-dispatch probe: one call, every actionability fact.
      // Matched FIRST and on `checkVisibility`, the one substring unique to
      // it: its body composes TEXT_ENTRY_FN and reads isConnected, so the
      // narrower branches below would otherwise swallow it. The answer is
      // shaped like the real one, which OMITS a fact rather than reporting
      // it false, so "absent means unknown" is what the code under test
      // actually meets.
      if (fn.includes('checkVisibility')) {
        if (connectedThrows === 'timeout') {
          throw new CdpCallTimeout('Runtime.callFunctionOn', 15_000)
        }
        if (actionabilityThrows) throw new Error(actionabilityThrows)
        if (actionabilityRaw !== undefined) return { result: { value: actionabilityRaw } }
        return {
          result: {
            value: {
              connected: targetConnected,
              textEntry,
              visible,
              ...(disabled ? { disabled: true } : {}),
              ...(readonly ? { readonly: true } : {}),
              ...(pointerEventsNone ? { pointerEventsNone: true } : {}),
            },
          },
        }
      }
      // The two single-fact RE-ASKS, each answered on its own so a test can
      // model the state CHANGING between the widened probe and the moment
      // the answer is used (a focus handler unlocking a field, a transition
      // finishing), which is the whole reason they exist.
      if (fn.includes('this.readOnly === true')) {
        return { result: { value: readonly && !readonlyClearsOnFocus } }
      }
      if (fn.includes("pointerEvents === 'none'")) {
        return { result: { value: pointerEventsNone && !pointerEventsClearsBeforeRefusal } }
      }
      if (fn.includes('getBoundingClientRect')) {
        return { result: { value: geometry } }
      }
      if (fn.includes('const isFile =')) return { result: { value: isFileInput } }
      if (fn.includes('isContentEditable')) return { result: { value: textEntry } }
      if (fn.includes('activeElement')) {
        if (focusReadThrows) throw new Error(focusReadThrows)
        return { result: { value: focusLanded } }
      }
      if (fn.includes('elementFromPoint')) return { result: { value: hit } }
      if (fn.includes('isConnected')) {
        if (connectedThrows === 'timeout') throw new CdpCallTimeout('Runtime.callFunctionOn', 15_000)
        return { result: { value: targetConnected } }
      }
      if (fn.includes('ownerDocument')) return { result: { value: targetInTopDocument } }
      if (fn.includes('this.options')) return { result: { value: selectMatches } }
      if (fn.includes('atob')) return { result: { value: { ok: true, mode: 'file-input' } } }
      if (fn.includes('this.checked') && fn.includes('return')) return { result: { value: value } }
      if (fn.includes('this.value !== undefined')) return { result: { value } }
      return { result: { value: undefined } }
    }
    if (method === 'Accessibility.getPartialAXTree') {
      return {
        nodes: [
          {
            backendDOMNodeId: params.backendNodeId,
            ignored: axIgnored,
            role: { value: axRole },
            name: { value: axName },
          },
        ],
      }
    }
    if (method === 'Page.getFrameTree') {
      return { frameTree: { frame: { id: 'frame-1' } } }
    }
    if (method === 'Page.createIsolatedWorld') {
      // Routed by world NAME: each world can fail independently, and a
      // creation that names neither world is a bug worth failing loudly on.
      const worldName = String(params.worldName ?? '')
      if (worldName === 'nymeria_delivery_probe') {
        return deliveryWorld ? { executionContextId: DELIVERY_CONTEXT } : {}
      }
      if (worldName === 'nymeria_probe') {
        return probeWorld ? { executionContextId: TRUST_CONTEXT } : {}
      }
      throw new Error(`unexpected isolated world name: ${worldName}`)
    }
    if (method === 'Runtime.evaluate') {
      const expression = String(params.expression ?? '')
      // The delivery probe, addressed to its own isolated world. Answered by
      // count rather than by running the page-side code: that logic has its own
      // executed-for-real tests in delivery.test.ts, and here we only care what
      // an action DOES with each outcome.
      if (params.contextId === DELIVERY_CONTEXT) {
        if (expression.includes('addEventListener')) return { result: { value: true } }
        if (expression.includes('querySelectorAll')) {
          return { result: { value: !pageHasFrames } }
        }
        if (expression.includes('nymPeek')) {
          return { result: { value: deliveryPeek ?? null } }
        }
        if (deliveryReadThrows) throw new Error(deliveryReadThrows)
        if (deliveryRead) return { result: { value: deliveryRead } }
        return { result: { value: { n: deliveryCount, f: fileChooserOpened } } }
      }
      // #160 enforcement, the document-level twin of the resolveNode check:
      // these expressions are trust probes (they steer input or gate a batch),
      // so an evaluate without the probe world's context is a regression. The
      // settle probe (MutationObserver) and describeFocused (activeElement)
      // stay main-world BY DECISION and are deliberately not listed.
      const mustBeInWorld =
        expression.includes('elementFromPoint') ||
        expression.includes('innerText.includes') ||
        expression.includes('innerWidth') ||
        expression.includes('document.querySelector(') ||
        expression.includes('document.evaluate(')
      if (mustBeInWorld && params.contextId !== TRUST_CONTEXT) {
        throw new Error(
          `trust probe ran outside the probe world: ${expression.slice(0, 60)}`,
        )
      }
      // The coordinate-target probe, which has no objectId to ask: one call
      // answers both the file-input guard and what the point landed on.
      if (expression.includes('elementFromPoint')) {
        return { result: { value: { description: pointDescription, opensFileChooser: isFileInput } } }
      }
      if (expression.includes('MutationObserver')) return { result: { value: settleValue } }
      if (expression.includes('activeElement')) {
        return { result: { value: { tag: 'input', label: 'Email' } } }
      }
      if (expression.includes('innerWidth')) return { result: { value: { x: 400, y: 300 } } }
      if (expression.includes('innerText.includes')) {
        // The frame-descending scan (QA round 2) carries its needle as a
        // `var NEEDLE = "..."` binding; a shape drift must fail loudly, not
        // silently match everything.
        const m = expression.match(/var NEEDLE = (".*");/)
        if (!m) throw new Error('wait text needle not found in expression')
        return { result: { value: bodyText.includes(JSON.parse(m[1]) as string) } }
      }
      if (expression.includes('querySelector') || expression.includes('document.evaluate')) {
        return { result: { objectId: 'css-obj' } }
      }
      return { result: { value: undefined } }
    }
    return {}
  })
  ;(chrome.debugger.sendCommand as unknown) = sendCommand
  return sendCommand
}

function methodsOf(mock: ReturnType<typeof installCdpMock>): string[] {
  return mock.mock.calls.map((c) => c[1] as string)
}

function inputEventTypes(mock: ReturnType<typeof installCdpMock>): string[] {
  return mock.mock.calls
    .filter((c) => c[1] === 'Input.dispatchMouseEvent')
    .map((c) => (c[2] as { type: string }).type)
}

beforeEach(() => {
  resetRefs()
  resetDebugger()
  resetConsole()
  resetNetwork()
  resetDelivery()
  resetNavWatch()
  vi.mocked(standingDialog).mockReturnValue(null)
  vi.mocked(chooserInterceptedSince).mockReturnValue(null)
  vi.mocked(resolvedDialogSince).mockReturnValue(null)
  // Default: no dialog ever interrupts, the raced work simply resolves.
  vi.mocked(raceStandingDialog).mockImplementation(async (_tabId, work) => ({
    kind: 'work' as const,
    value: await work,
  }))
})

describe('trusted input', () => {
  it('clicks through browser-level input events, not page-synthesized ones', async () => {
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    const cdp = installCdpMock()

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(true)
    expect(inputEventTypes(cdp)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased'])
    expect((result.data as { input: string }).input).toBe('trusted')
    // The synthetic path must NOT have been used.
    const synthetic = cdp.mock.calls.some(
      (c) => c[1] === 'Runtime.callFunctionOn' && String((c[2] as { functionDeclaration?: string }).functionDeclaration).includes('this.click()'),
    )
    expect(synthetic).toBe(false)
  })

  it('double_click presses twice with an increasing click count', async () => {
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    const cdp = installCdpMock()

    await execAct({ tab_id: TAB, action: 'double_click', ref: '@e1' })

    const presses = cdp.mock.calls
      .filter((c) => c[1] === 'Input.dispatchMouseEvent' && (c[2] as { type: string }).type === 'mousePressed')
      .map((c) => (c[2] as { clickCount: number }).clickCount)
    expect(presses).toEqual([1, 2])
  })

  it('falls back to synthetic dispatch when the element has no layout box, and says so', async () => {
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    const cdp = installCdpMock({ geometry: null })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(true)
    const data = result.data as { input: string; synthetic_reason?: string }
    expect(data.input).toBe('synthetic')
    expect(data.synthetic_reason).toMatch(/no layout box/)
    expect(inputEventTypes(cdp)).toHaveLength(0)
  })

  it('refuses the click when another element covers the point, and names it', async () => {
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    const cdp = installCdpMock({ hit: { hit: false, blocker: 'div#cookie-banner' } })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/covered by div#cookie-banner/)
    expect((result.data as { intercepted_by: string }).intercepted_by).toBe('div#cookie-banner')
    // Nothing was clicked: refusing beats clicking the overlay.
    expect(inputEventTypes(cdp)).toHaveLength(0)
  })

  it('teaches the deliberate click-through in the refusal: the exact coordinate, both readings', async () => {
    // #174: the guard cannot tell a genuine overlay from the target's own
    // widget fronting for it (a styled checkbox's span), so the refusal must
    // hand over both exits rather than dead-ending on "dismiss the overlay".
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    installCdpMock({ hit: { hit: false, blocker: 'span.styled-box' } })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(false)
    // Default mock geometry centers on (50, 60).
    expect(result.error).toMatch(/coordinate=\[50, 60\]/)
    expect(result.error).toMatch(/target's own widget/)
    expect((result.data as { click_point: number[] }).click_point).toEqual([50, 60])
  })

  it('delivers a covered click on a text-entry target and verifies it by focus (#174)', async () => {
    // The CodePen case: CodeMirror 5's render surface (`pre.CodeMirror-line`)
    // is a SIBLING of the hidden textarea the ref resolves to, so containment
    // can never accept it. The editor routes a surface click to its input in
    // its own mousedown handler; refusing was blocking a click that works.
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    const cdp = installCdpMock({
      hit: { hit: false, blocker: 'pre.CodeMirror-line' },
      textEntry: true,
      focusLanded: true,
    })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(true)
    expect(inputEventTypes(cdp)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased'])
    const data = result.data as { input: string; clicked_through: string }
    expect(data.input).toBe('trusted')
    expect(data.clicked_through).toBe('pre.CodeMirror-line')
  })

  it('keeps the clicked-through result honest when the page dies under the focus read', async () => {
    // A navigation or re-render destroys the execution context mid-read. The
    // click still went out; a raw "Cannot find context" error would hide that
    // and blaming the blocker would be a guess.
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    installCdpMock({
      hit: { hit: false, blocker: 'pre.CodeMirror-line' },
      textEntry: true,
      focusReadThrows: 'Cannot find context with specified id',
    })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/was delivered/)
    expect(result.error).toMatch(/page changed before/)
    expect(result.error).not.toMatch(/Cannot find context/)
    expect((result.data as { click_delivered: boolean }).click_delivered).toBe(true)
  })

  it('reports a clicked-through covered click honestly when focus never reaches the target', async () => {
    // A genuine overlay over a text field: the click was delivered (that is a
    // side effect the agent must know about) but the covering element likely
    // consumed it. Claude for Chrome's unverified version of this path types
    // into the void with a confident success message (measured 2026-08-14).
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    const cdp = installCdpMock({
      hit: { hit: false, blocker: 'div#signup-modal' },
      textEntry: true,
      focusLanded: false,
    })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/focus did not land/)
    expect(result.error).toMatch(/Re-read the page/)
    // The click DID go out: the payload must own the side effect.
    expect(inputEventTypes(cdp)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased'])
    expect((result.data as { click_delivered: boolean }).click_delivered).toBe(true)
    expect((result.data as { intercepted_by: string }).intercepted_by).toBe('div#signup-modal')
  })

  it('fills by inserting text into the focused element and reports the previous value', async () => {
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    const cdp = installCdpMock({ value: 'before@example.com' })

    const result = await execAct({
      tab_id: TAB,
      action: 'fill',
      ref: '@e1',
      value: 'after@example.com',
    })

    expect(result.ok).toBe(true)
    const methods = methodsOf(cdp)
    expect(methods).toContain('DOM.focus')
    expect(methods).toContain('Input.insertText')
    const data = result.data as { previous_value: string; input: string }
    expect(data.previous_value).toBe('before@example.com')
    expect(data.input).toBe('trusted')
  })
})

describe('ref lifecycle', () => {
  it('refuses to act on a ref minted on a different URL and says to re-read', async () => {
    setRefs(TAB, new Map([['e1', fpRef(100)]]), 'https://example.com/checkout')
    const cdp = installCdpMock()

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/re-read the page/)
    expect((result.data as { stale_refs: boolean; reason: string }).stale_refs).toBe(true)
    expect((result.data as { reason: string }).reason).toBe('navigated')
    expect(methodsOf(cdp)).not.toContain('DOM.resolveNode')
  })

  it('reports no-snapshot rather than an unknown-ref crash after a worker recycle', async () => {
    installCdpMock()
    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(false)
    expect((result.data as { reason: string }).reason).toBe('no-snapshot')
    expect(result.error).toMatch(/read the page first/)
  })

  it('reports unknown-ref for a ref that was never minted', async () => {
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    installCdpMock()

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e99' })

    expect(result.ok).toBe(false)
    expect((result.data as { reason: string }).reason).toBe('unknown-ref')
  })

  it('reports a ref that resolves to nothing as stale rather than acting', async () => {
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    const cdp = installCdpMock({ resolveNode: false })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/no longer exists/)
    expect(inputEventTypes(cdp)).toHaveLength(0)
  })
})

describe('verification payload', () => {
  it('surfaces console errors raised since the action started', async () => {
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    installCdpMock()
    // An error from before the action must not be attributed to it.
    pushConsole(TAB, { level: 'error', text: 'stale earlier error', ts: Date.now() - 60_000 })

    const pending = execAct({ tab_id: TAB, action: 'click', ref: '@e1' })
    pushConsole(TAB, { level: 'error', text: 'POST /cart 500', ts: Date.now() + 5 })
    const result = await pending

    const errors = (result.data as { console_errors?: { text: string }[] }).console_errors ?? []
    expect(errors.map((e) => e.text)).toEqual(['POST /cart 500'])
  })

  it('passes frame attribution and browser advisories through to console_errors (#177)', async () => {
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    installCdpMock()

    const pending = execAct({ tab_id: TAB, action: 'click', ref: '@e1' })
    // The shape a refused in-frame navigation produces: a Log-domain
    // advisory attributed to the frame. act must relay it verbatim, so the
    // payload itself names the cause without a separate chrome_console call.
    pushConsole(TAB, {
      level: 'error',
      text: "Refused to display 'https://a.example/' in a frame because it set 'X-Frame-Options' to 'deny'.",
      ts: Date.now() + 5,
      browser: true,
      frame: 'https://pay.example',
    })
    const result = await pending

    const errors =
      (result.data as { console_errors?: { text: string; browser?: boolean; frame?: string }[] })
        .console_errors ?? []
    expect(errors).toHaveLength(1)
    expect(errors[0].browser).toBe(true)
    expect(errors[0].frame).toBe('https://pay.example')
  })

  // The navigation cases mock the TIMELINE honestly: `chrome.tabs.get` keeps
  // returning the OLD url until a webNavigation commit fires, which is what
  // real Chrome does. The previous shape here flipped the url the instant
  // input dispatched, a timeline the browser never produces, and so asserted
  // `url_changed: true` on code that read false on every real navigating
  // click (backlog #160; the bug was structurally invisible to its own test).
  function wireNav() {
    installNavWatch()
    const last = (fn: unknown) =>
      (fn as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as (details: {
        tabId: number
        url: string
        frameId: number
      }) => void
    return {
      beforeNavigate: last(chrome.webNavigation!.onBeforeNavigate.addListener),
      committed: last(chrome.webNavigation!.onCommitted.addListener),
    }
  }

  /** tabs.get answers the OLD url until `flip()` is called. */
  function urlFlipsOnCommit(newUrl: string): () => void {
    let committed = false
    const get = chrome.tabs.get as unknown as ReturnType<typeof vi.fn>
    get.mockImplementation(async () => ({ id: TAB, url: committed ? newUrl : TAB_URL }))
    return () => {
      committed = true
    }
  }

  it('reports a navigation whose commit lands after settle resolved on the old document', async () => {
    // Fake timers freeze Date.now(), so the pre-call beforeNavigate carries
    // the same timestamp the act samples at entry and the attribution filter
    // (started at or after the act began) accepts it.
    vi.useFakeTimers()
    try {
      setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
      installCdpMock()
      const nav = wireNav()
      const flip = urlFlipsOnCommit('https://example.com/thanks')

      // The navigation is in flight when verification runs; the commit
      // arrives a beat later, well inside the bounded wait.
      nav.beforeNavigate({ tabId: TAB, url: 'https://example.com/thanks', frameId: 0 })
      setTimeout(() => {
        flip()
        nav.committed({ tabId: TAB, url: 'https://example.com/thanks', frameId: 0 })
      }, 30)

      const pending = execAct({ tab_id: TAB, action: 'click', ref: '@e1' })
      await vi.advanceTimersByTimeAsync(100)
      const result = await pending

      const data = result.data as { url_changed: boolean; url: string; navigated?: boolean }
      expect(data.url_changed).toBe(true)
      expect(data.url).toBe('https://example.com/thanks')
      expect(data.navigated).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports a still-uncommitted navigation as pending, asserting nothing', async () => {
    vi.useFakeTimers()
    try {
      setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
      installCdpMock()
      const nav = wireNav()

      nav.beforeNavigate({ tabId: TAB, url: 'https://slow.example/checkout', frameId: 0 })

      const pending = execAct({ tab_id: TAB, action: 'click', ref: '@e1' })
      // The commit wait is 3s; nothing ever commits.
      await vi.advanceTimersByTimeAsync(3_100)
      const result = await pending

      expect(result.ok).toBe(true)
      const data = result.data as {
        url_changed: boolean
        url: string
        navigation_pending?: string
        navigated?: boolean
      }
      expect(data.url_changed).toBe(false)
      expect(data.url).toBe(TAB_URL)
      expect(data.navigation_pending).toBe('https://slow.example/checkout')
      expect(data.navigated).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a navigation already in flight before the act is not attributed to it', async () => {
    // Real timers: the beforeNavigate lands milliseconds before the act
    // starts, on an earlier Date.now(), which is exactly the unrelated-load
    // case (meta refresh, someone else's slow navigation) the attribution
    // filter exists for. No commit wait is paid and nothing is reported.
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    installCdpMock()
    const nav = wireNav()

    nav.beforeNavigate({ tabId: TAB, url: 'https://unrelated.example/', frameId: 0 })
    await new Promise((r) => setTimeout(r, 5))

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    const data = result.data as Record<string, unknown>
    expect('navigation_pending' in data).toBe(false)
  })

  it('a non-navigating act carries neither navigation field, at zero added latency', async () => {
    // Fake timers with NO advance: if the commit wait were entered on a
    // non-navigating act, its 3s timer would never fire and this test would
    // hang red instead of passing slow.
    vi.useFakeTimers()
    try {
      setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
      installCdpMock()
      wireNav()

      const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

      const data = result.data as Record<string, unknown>
      expect(data.url_changed).toBe(false)
      expect('navigated' in data).toBe(false)
      expect('navigation_pending' in data).toBe(false)
      // #168: a wait-less act also runs no wait loop. The fused wait's poll
      // timer would equally hang this test red if it were entered here.
      expect('condition' in data).toBe(false)
      expect('found' in data).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a wait rides the bounded commit wait and reports the commit it catches', async () => {
    // The old exemption ("wait never pays the commit wait") was budget-born
    // and died with the +15s transport slack: a wait whose page is mid-
    // navigation now waits the bounded beat like every other action and
    // reports `navigated` instead of leaving the honest in-between as the
    // final word.
    vi.useFakeTimers()
    try {
      installCdpMock({ bodyText: 'Done' })
      const nav = wireNav()
      const flip = urlFlipsOnCommit('https://example.com/thanks')
      nav.beforeNavigate({ tabId: TAB, url: 'https://example.com/thanks', frameId: 0 })
      setTimeout(() => {
        flip()
        nav.committed({ tabId: TAB, url: 'https://example.com/thanks', frameId: 0 })
      }, 30)

      const pending = execAct({
        tab_id: TAB,
        action: 'wait',
        wait_for: { text: 'Done' },
        timeout_ms: 5_000,
      })
      await vi.advanceTimersByTimeAsync(100)
      const result = await pending

      expect(result.ok).toBe(true)
      const data = result.data as { found?: boolean; navigated?: boolean; url?: string }
      expect(data.found).toBe(true)
      expect(data.navigated).toBe(true)
      expect(data.url).toBe('https://example.com/thanks')
    } finally {
      vi.useRealTimers()
    }
  })

  it('a same-url re-navigation reads navigated without url_changed', async () => {
    vi.useFakeTimers()
    try {
      setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
      installCdpMock()
      const nav = wireNav()

      nav.beforeNavigate({ tabId: TAB, url: TAB_URL, frameId: 0 })
      setTimeout(() => nav.committed({ tabId: TAB, url: TAB_URL, frameId: 0 }), 30)

      const pending = execAct({ tab_id: TAB, action: 'click', ref: '@e1' })
      await vi.advanceTimersByTimeAsync(100)
      const result = await pending

      const data = result.data as { url_changed: boolean; navigated?: boolean }
      expect(data.url_changed).toBe(false)
      expect(data.navigated).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('names a dialog that opens during the verification stage itself', async () => {
    // The commit wait and the verification reads run after the post-settle
    // dialog checkpoint; a deferred beforeunload can open exactly there. The
    // post-verification checkpoint must name it (the #169 invariant), not
    // return a clean success that never mentions chrome_dialog.
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    installCdpMock()
    wireNav()
    const dialog: StandingDialogT = {
      type: 'beforeunload',
      message: '',
      url: TAB_URL,
      openedAt: Date.now(),
      deadlineAt: Date.now() + 60_000,
    }
    // Order-based, not call-count-based: the dialog "opens" when the focus
    // probe (inside buildVerification) hits the wire, after every earlier
    // checkpoint has already passed.
    let dialogNow: StandingDialogT | null = null
    const send = chrome.debugger.sendCommand as unknown as ReturnType<typeof vi.fn>
    const original = send.getMockImplementation() as (...a: unknown[]) => Promise<unknown>
    send.mockImplementation(async (...args: unknown[]) => {
      const params = args[2] as { expression?: string } | undefined
      if (params?.expression?.includes('document.activeElement')) dialogNow = dialog
      return original(...args)
    })
    vi.mocked(standingDialog).mockImplementation(() => dialogNow)

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    const data = result.data as { dialog?: { type?: string; note?: string } }
    expect(data.dialog?.type).toBe('beforeunload')
    expect(data.dialog?.note).toMatch(/do not repeat the click/i)
  })

  it('an SPA pushState url change reports url_changed with no commit', async () => {
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    const cdp = installCdpMock()
    wireNav()
    // pushState updates the committed tab url synchronously with no
    // cross-document navigation, so flipping on input IS the honest timeline
    // for this one case (it was the dishonest one for real navigations).
    const get = chrome.tabs.get as unknown as ReturnType<typeof vi.fn>
    get.mockImplementation(async () => ({
      id: TAB,
      url: inputEventTypes(cdp).length > 0 ? 'https://example.com/app/inbox' : TAB_URL,
    }))

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    const data = result.data as { url_changed: boolean; navigated?: boolean }
    expect(data.url_changed).toBe(true)
    expect(data.navigated).toBeUndefined()
  })

  it('waits for the page to settle and reports the outcome', async () => {
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    installCdpMock({ settleValue: 'quiet' })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    const settled = (result.data as { settled: { settled: boolean; reason: string } }).settled
    expect(settled.settled).toBe(true)
    expect(settled.reason).toBe('quiet')
  })

  it('reports a deadline settle without failing the action', async () => {
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    installCdpMock({ settleValue: 'deadline' })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(true)
    expect((result.data as { settled: { reason: string } }).settled.reason).toBe('deadline')
  })

  it('reports not-found on timeout instead of claiming success', async () => {
    installCdpMock({ bodyText: 'still loading' })

    const result = await execAct({
      tab_id: TAB,
      action: 'wait',
      wait_for: { text: 'Order confirmed' },
      timeout_ms: 150,
    })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/wait timed out/)
    expect((result.data as { found: boolean }).found).toBe(false)
  })

  it('waits on a url substring', async () => {
    installCdpMock()
    const get = chrome.tabs.get as unknown as ReturnType<typeof vi.fn>
    get.mockImplementation(async () => ({ id: TAB, url: 'https://example.com/checkout/done' }))

    const result = await execAct({
      tab_id: TAB,
      action: 'wait',
      wait_for: { url_contains: '/checkout/done' },
      timeout_ms: 500,
    })

    expect(result.ok).toBe(true)
    expect((result.data as { found: boolean }).found).toBe(true)
  })

  // ---- fused wait conditions (#168): any action can carry wait_for/timeout_ms.

  it('a click carrying wait_for_text returns when the text appears, not at the timeout', async () => {
    // The text lands 500ms after the click; the poll must see it and return
    // early. If the wait rode its 10s timeout instead, the 1s advance below
    // would leave the act unresolved and this test would hang red.
    vi.useFakeTimers()
    try {
      setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
      installCdpMock()
      let body = 'still loading'
      const send = chrome.debugger.sendCommand as unknown as ReturnType<typeof vi.fn>
      const original = send.getMockImplementation() as (...a: unknown[]) => Promise<unknown>
      send.mockImplementation(async (...args: unknown[]) => {
        const params = args[2] as { expression?: string } | undefined
        const e = params?.expression
        if (e?.includes('innerText.includes')) {
          const m = e.match(/var NEEDLE = (".*");/)
          if (!m) throw new Error('wait text needle not found in expression')
          return { result: { value: body.includes(JSON.parse(m[1]) as string) } }
        }
        return original(...args)
      })
      setTimeout(() => {
        body = 'Order confirmed'
      }, 500)

      const pending = execAct({
        tab_id: TAB,
        action: 'click',
        ref: '@e1',
        wait_for: { text: 'Order confirmed' },
        timeout_ms: 10_000,
      })
      await vi.advanceTimersByTimeAsync(1_000)
      const result = await pending

      expect(result.ok).toBe(true)
      const data = result.data as { condition?: string; found?: boolean; waited_ms?: number }
      expect(data.condition).toBe('text:Order confirmed')
      expect(data.found).toBe(true)
      expect(data.waited_ms, 'returned at the text, not the timeout').toBeLessThan(2_000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('an unmet condition on a delivered click succeeds with found: false, not an error', async () => {
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    installCdpMock({ bodyText: 'still loading' })

    const result = await execAct({
      tab_id: TAB,
      action: 'click',
      ref: '@e1',
      wait_for: { text: 'Order confirmed' },
      timeout_ms: 150,
    })

    expect(result.ok, 'the input WAS delivered; failing conflates delivery with outcome').toBe(true)
    expect(result.error).toBeUndefined()
    const data = result.data as { condition?: string; found?: boolean; input_delivered?: string }
    expect(data.found).toBe(false)
    expect(data.condition).toBe('text:Order confirmed')
    expect(data.input_delivered).toBe('yes')
  })

  it('timeout_ms with no condition widens the one settle and never arms a condition', async () => {
    // A bare timeout is a patience knob, not a named outcome: the settle
    // window itself is widened (visible in the probe's in-page deadline) and
    // no condition/found is emitted, so mere page quiescence can never gate
    // a batch.
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    const cdp = installCdpMock()

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1', timeout_ms: 3_000 })

    expect(result.ok).toBe(true)
    const data = result.data as Record<string, unknown> & { settled?: { reason: string } }
    expect('condition' in data).toBe(false)
    expect('found' in data).toBe(false)
    expect(data.settled?.reason).toBe('quiet')
    const settleProbes = cdp.mock.calls.filter(
      (c) => c[1] === 'Runtime.evaluate' && String((c[2] as { expression?: string }).expression).includes('MutationObserver'),
    )
    expect(settleProbes, 'one settle, not a settle plus a second probe').toHaveLength(1)
    expect(String((settleProbes[0][2] as { expression: string }).expression)).toContain('3000')
  })

  it('timeout_ms: 0 runs no wait at all, matching the backend reading of it as unset', async () => {
    vi.useFakeTimers()
    try {
      setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
      const cdp = installCdpMock()

      const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1', timeout_ms: 0 })

      expect(result.ok).toBe(true)
      const data = result.data as Record<string, unknown>
      expect('condition' in data).toBe(false)
      expect('found' in data).toBe(false)
      const settleProbes = cdp.mock.calls.filter(
        (c) => c[1] === 'Runtime.evaluate' && String((c[2] as { expression?: string }).expression).includes('MutationObserver'),
      )
      expect(settleProbes).toHaveLength(1)
      expect(
        String((settleProbes[0][2] as { expression: string }).expression),
        'the default window, not a zero-length one',
      ).toContain('5000')
    } finally {
      vi.useRealTimers()
    }
  })

  it('a dialog opening during the widened settle is named, not ridden out', async () => {
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    installCdpMock()
    const confirm: StandingDialogT = {
      type: 'confirm',
      message: 'Leave?',
      url: TAB_URL,
      openedAt: Date.now(),
      deadlineAt: Date.now() + 60_000,
    }
    vi.mocked(raceStandingDialog).mockResolvedValue({ kind: 'dialog', dialog: confirm })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1', timeout_ms: 60_000 })

    expect(result.ok, 'the input WAS delivered; the dialog is the story').toBe(true)
    const data = result.data as { dialog?: { type?: string; message?: string } }
    expect(data.dialog?.type).toBe('confirm')
    expect(data.dialog?.message).toBe('Leave?')
  })

  it('names the condition that was MET when several are armed', async () => {
    // Conditions are OR'd; the payload must name the one that held, not the
    // highest-priority one, because `condition` now feeds the batch gate.
    const url = 'https://example.com/done'
    setRefs(TAB, new Map([['e1', fpRef(100)]]), url)
    installCdpMock({ bodyText: 'still loading' })
    const get = chrome.tabs.get as unknown as ReturnType<typeof vi.fn>
    get.mockImplementation(async () => ({ id: TAB, url }))

    const result = await execAct({
      tab_id: TAB,
      action: 'click',
      ref: '@e1',
      wait_for: { text: 'Welcome', url_contains: '/done' },
      timeout_ms: 500,
    })

    expect(result.ok).toBe(true)
    const data = result.data as { condition?: string; found?: boolean }
    expect(data.found).toBe(true)
    expect(data.condition).toBe('url_contains:/done')
  })

  it('a throw out of the ref condition keeps polling instead of escaping post-dispatch', async () => {
    // A `css=` resolve is a bare evaluate that rejects during a navigation
    // or a debugger detach. Post-#168 this loop runs AFTER input was
    // dispatched: a throw escaping it would lose the whole verification
    // payload and read as "nothing was sent", the double-submit invitation.
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    installCdpMock()
    const send = chrome.debugger.sendCommand as unknown as ReturnType<typeof vi.fn>
    const original = send.getMockImplementation() as (...a: unknown[]) => Promise<unknown>
    send.mockImplementation(async (...args: unknown[]) => {
      const params = args[2] as { expression?: string; contextId?: number } | undefined
      // The css resolve runs in the probe world now, so the modeled failure
      // targets the in-world evaluate (and keeps throwing across the
      // rebuild-once retry, as a real mid-navigation churn does).
      if (params?.expression?.includes('querySelector') && params.contextId !== undefined) {
        throw new Error('Inspected target navigated or closed')
      }
      return original(...args)
    })

    const result = await execAct({
      tab_id: TAB,
      action: 'click',
      ref: '@e1',
      wait_for: { ref: 'css=.toast' },
      timeout_ms: 250,
    })

    expect(result.ok).toBe(true)
    const data = result.data as { found?: boolean; condition?: string; input_delivered?: string }
    expect(data.found).toBe(false)
    expect(data.condition).toBe('ref:css=.toast')
    expect(data.input_delivered, 'the payload survives the throw').toBe('yes')
  })

  it('wait_for_ref on a click is satisfied by the element appearing', async () => {
    setRefs(
      TAB,
      new Map([
        ['e1', fpRef(100)],
        ['e2', fpRef(200)],
      ]),
      TAB_URL,
    )
    installCdpMock()

    const result = await execAct({
      tab_id: TAB,
      action: 'click',
      ref: '@e1',
      wait_for: { ref: '@e2' },
      timeout_ms: 500,
    })

    expect(result.ok).toBe(true)
    const data = result.data as { condition?: string; found?: boolean }
    expect(data.condition).toBe('ref:@e2')
    expect(data.found).toBe(true)
  })

  it('a met condition does not cost navigation honesty: the commit is still awaited', async () => {
    // The M6 case: a toast lands on the OUTGOING document (found at ~0ms)
    // while the click's navigation is still in flight. An exemption keyed on
    // "a wait ran" would skip the commit wait and report navigation_pending
    // where the identical wait-less click reports navigated: true. The +15s
    // transport slack pays for the honest answer; take it.
    vi.useFakeTimers()
    try {
      setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
      installCdpMock({ bodyText: 'Saved' })
      const nav = wireNav()
      const flip = urlFlipsOnCommit('https://example.com/thanks')
      nav.beforeNavigate({ tabId: TAB, url: 'https://example.com/thanks', frameId: 0 })
      setTimeout(() => {
        flip()
        nav.committed({ tabId: TAB, url: 'https://example.com/thanks', frameId: 0 })
      }, 30)

      const pending = execAct({
        tab_id: TAB,
        action: 'click',
        ref: '@e1',
        wait_for: { text: 'Saved' },
      })
      await vi.advanceTimersByTimeAsync(100)
      const result = await pending

      expect(result.ok).toBe(true)
      const data = result.data as {
        found?: boolean
        navigated?: boolean
        url_changed?: boolean
        url?: string
      }
      expect(data.found).toBe(true)
      expect(data.navigated).toBe(true)
      expect(data.url_changed).toBe(true)
      expect(data.url).toBe('https://example.com/thanks')
    } finally {
      vi.useRealTimers()
    }
  })

  it('a dialog opening during a fused wait is named, not burned through', async () => {
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    installCdpMock({ bodyText: 'still loading' })
    const confirm: StandingDialogT = {
      type: 'confirm',
      message: 'Delete this item?',
      url: TAB_URL,
      openedAt: Date.now(),
      deadlineAt: Date.now() + 60_000,
    }
    vi.mocked(raceStandingDialog).mockResolvedValue({ kind: 'dialog', dialog: confirm })

    const result = await execAct({
      tab_id: TAB,
      action: 'click',
      ref: '@e1',
      wait_for: { text: 'Done' },
      timeout_ms: 500,
    })

    expect(result.ok, 'the input WAS delivered; the dialog is the story').toBe(true)
    const data = result.data as { dialog?: { type?: string; message?: string; note?: string } }
    expect(data.dialog?.type).toBe('confirm')
    expect(data.dialog?.message).toBe('Delete this item?')
    expect(data.dialog?.note).toMatch(/do not repeat the click/i)
  })

  it('a conclusively undelivered click does not burn the wait timeout first', async () => {
    // Fake timers with no advance: running the 60s wait before the inevitable
    // undelivered failure would hang this test red.
    vi.useFakeTimers()
    try {
      setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
      installCdpMock({ deliveryCount: 0 })

      const result = await execAct({
        tab_id: TAB,
        action: 'click',
        ref: '@e1',
        wait_for: { text: 'Done' },
        timeout_ms: 60_000,
      })

      expect(result.ok).toBe(false)
      expect(String(result.error)).toMatch(/received no event/)
      const data = result.data as Record<string, unknown>
      expect('found' in data, 'no wait ran, so no wait outcome is claimed').toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('argument handling', () => {
  it('rejects an unknown target format', async () => {
    installCdpMock()
    const result = await execAct({ tab_id: TAB, action: 'click', ref: 'plain-string' })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/must start with @, css=, or xpath=/)
  })

  it('requires a value for fill', async () => {
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    installCdpMock()
    const result = await execAct({ tab_id: TAB, action: 'fill', ref: '@e1' })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/fill requires value/)
  })

  it('requires a target for element actions', async () => {
    installCdpMock()
    const result = await execAct({ tab_id: TAB, action: 'click' })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/requires ref or coordinate/)
  })

  it('accepts a bare coordinate target', async () => {
    const cdp = installCdpMock()
    const result = await execAct({ tab_id: TAB, action: 'click', coordinate: [120, 240] })
    expect(result.ok).toBe(true)
    const pressed = cdp.mock.calls.find(
      (c) => c[1] === 'Input.dispatchMouseEvent' && (c[2] as { type: string }).type === 'mousePressed',
    )
    expect(pressed?.[2]).toMatchObject({ x: 120, y: 240 })
  })

  it('resolves a css= target through Runtime.evaluate', async () => {
    const cdp = installCdpMock()
    const resolution = await __test.resolveTarget(TAB, 'css=.btn-primary', TAB_URL)
    expect(resolution.ok).toBe(true)
    expect(methodsOf(cdp)).toContain('Runtime.evaluate')
  })

  it('reports a css= target that matches nothing', async () => {
    ;(chrome.debugger.sendCommand as unknown) = vi.fn(async (_t: unknown, method: string) => {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'f' } } }
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 88 }
      return { result: { subtype: 'null' } }
    })
    const resolution = await __test.resolveTarget(TAB, 'css=#missing', TAB_URL)
    expect(resolution.ok).toBe(false)
    if (!resolution.ok) expect(resolution.error).toMatch(/matched no element/)
  })

  it('selects by visible label, not just by option value', async () => {
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    const cdp = installCdpMock({ selectMatches: true })

    const result = await execAct({ tab_id: TAB, action: 'select', ref: '@e1', value: 'Express shipping' })

    expect(result.ok).toBe(true)
    const call = cdp.mock.calls.find(
      (c) => c[1] === 'Runtime.callFunctionOn' && String((c[2] as { functionDeclaration: string }).functionDeclaration).includes('this.options'),
    )
    expect(call).toBeDefined()
    expect((result.data as { input: string }).input).toBe('synthetic')
  })

  it('fails a select whose value matches no option', async () => {
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    installCdpMock({ selectMatches: false })

    const result = await execAct({ tab_id: TAB, action: 'select', ref: '@e1', value: 'Teleport' })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/no option matching/)
  })
})

describe('execAct target resolution', () => {
  it('focuses the ref before typing instead of typing wherever focus happened to be', async () => {
    // `type` and `key` advertise a `ref`, and the failure mode when it is
    // ignored is invisible: the characters land in whatever was already
    // focused (the previous field, the page's search box) and the command
    // still reports ok:true. Nothing downstream can tell the difference.
    const mock = installCdpMock()
    setRefs(TAB, new Map([['e1', fpRef(77)]]), TAB_URL)

    const result = await execAct({ tab_id: TAB, action: 'type', ref: '@e1', value: 'hi' })

    expect(result.ok).toBe(true)
    const methods = methodsOf(mock)
    expect(methods).toContain('DOM.resolveNode')
    const focusAt = methods.indexOf('DOM.focus')
    const typedAt = methods.indexOf('Input.dispatchKeyEvent')
    expect(focusAt, 'the ref must be focused').toBeGreaterThanOrEqual(0)
    expect(typedAt, 'keystrokes must follow the focus, not precede it').toBeGreaterThan(focusAt)
  })

  it('refuses to check a box whose click point is covered, rather than forcing the property', async () => {
    // Forcing `.checked` on an intercepted element sets the property without
    // the page's own change handler running, so the agent sees success while
    // the state the site actually reads never moved. `click` already refuses
    // here; check must not be the soft path around that refusal.
    const mock = installCdpMock({ hit: { hit: false, blocker: 'div.cookie-banner' }, value: null })
    setRefs(TAB, new Map([['e1', fpRef(77)]]), TAB_URL)

    const result = await execAct({ tab_id: TAB, action: 'check', ref: '@e1' })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/covered by div\.cookie-banner/)
    const forced = mock.mock.calls.some(
      (c) =>
        c[1] === 'Runtime.callFunctionOn' &&
        String((c[2] as { functionDeclaration?: string }).functionDeclaration ?? '').includes(
          'this.checked =',
        ),
    )
    expect(forced, 'must not fall back to forcing the property').toBe(false)
  })

  it('teaches check/uncheck an exit they can actually take: a coordinate CLICK, not a coordinate check', async () => {
    // check/uncheck are ref-only verbs (NEEDS_TARGET, not coordinate-capable),
    // so "repeat the check with coordinate=..." would be refused on arrival.
    // The styled-checkbox exit is a plain click on the covering element, then
    // a state read to confirm the toggle.
    installCdpMock({ hit: { hit: false, blocker: 'span.styled-box' }, value: null })
    setRefs(TAB, new Map([['e1', fpRef(77)]]), TAB_URL)

    const result = await execAct({ tab_id: TAB, action: 'check', ref: '@e1' })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/action="click"/)
    expect(result.error).toMatch(/coordinate=\[50, 60\]/)
    expect(result.error).not.toMatch(/repeat the check with coordinate/)
    expect(result.error).toMatch(/confirm/)
  })
})

describe('input delivery', () => {
  /**
   * The failure these cover: Chrome disables page input while a tab-modal
   * dialog is showing, so `Input.dispatch*` is accepted by CDP, acked without
   * error, and discarded before the renderer. Nothing mutates, so settle
   * reports `quiet`, and the action reported a clean success having done
   * nothing at all.
   */

  it('fails the command when the page provably received no event', async () => {
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    installCdpMock({ deliveryCount: 0 })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(false)
    expect(result.status).toBe('error')
    expect(result.error).toMatch(/received no event/)
  })

  it('gives both recoveries in cheapest-first order and rules out reloading', async () => {
    // The agent cannot see browser UI: not in the tree, not in the console, not
    // in a screenshot. Told only that the click failed it will retry the same
    // dead tab forever, which is exactly what happened live.
    //
    // The ORDER is measured, not stylistic (2026-08-11). Navigating away DID
    // recover a tab held by an HTTP auth prompt, so leading with "open a fresh
    // tab" throws away the cheap fix and the work already done in that tab. It
    // did NOT recover a tab poisoned by an alert(), so closing has to remain the
    // fallback that always works.
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    installCdpMock({ deliveryCount: 0 })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    const error = String(result.error)
    expect(error).toMatch(/navigate this tab/i)
    expect(error).toMatch(/close the tab/i)
    expect(error.search(/navigate this tab/i)).toBeLessThan(error.search(/close the tab/i))
    expect(error).toMatch(/reloading does not help/i)
  })

  it('warns that the suppression can outlive the dialog that caused it', async () => {
    // Measured 2026-08-11 and genuinely counter-intuitive: after an alert() was
    // dismissed by navigating away, the tab ran scripts again (a page read
    // returned real content in under a second) while input stayed undelivered.
    // So there can be NOTHING on screen to find. An agent told only "a dialog
    // may be blocking you" looks, sees a clean page, concludes the tool is
    // wrong, and retries the dead tab.
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    installCdpMock({ deliveryCount: 0 })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.error).toMatch(/outlive/i)
  })

  it('fails when the action itself suspends the page, and says the input LANDED', async () => {
    // The commoner dialog case, and the one a pre-flight alone cannot see: the
    // click raises the dialog. Everything after dispatch is renderer-bound,
    // including settle, whose deadline is in-page and never ticks. Telling the
    // agent nothing was sent here would invite a retry that double-submits.
    vi.useFakeTimers()
    try {
      setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
      installCdpMock({ rendererHangsAfterDispatch: true })

      const pending = execAct({ tab_id: TAB, action: 'click', ref: '@e1' })
      await vi.advanceTimersByTimeAsync(60_000)
      const result = await pending

      expect(result.ok).toBe(false)
      const error = String(result.error)
      expect(error).toMatch(/was sent/i)
      expect(error).toMatch(/not simply retry/i)
      expect(error).not.toMatch(/was NOT sent/i)
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails fast when the dispatch ack itself never returns, and says the input LANDED', async () => {
    // The synchronous twin of the case above, and the commonest shape of it:
    // Chrome acks `Input.dispatch*` only after the renderer has PROCESSED the
    // event, so a click handler that calls alert() blocks the ack itself.
    // Execution never returns from the dispatch await, the post-dispatch
    // liveness check is unreachable, and without a deadline on the ack the
    // command rides the full 30s transport timeout. Measured live 2026-08-12.
    vi.useFakeTimers()
    try {
      setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
      // From the PRESS, not the opening pointer move: an alert() raised by
      // the click handler is reached only once the button goes down.
      installCdpMock({ inputAckHangsFrom: 2 })

      const pending = execAct({ tab_id: TAB, action: 'click', ref: '@e1' })
      await vi.advanceTimersByTimeAsync(60_000)
      const result = await pending

      expect(result.ok).toBe(false)
      const error = String(result.error)
      expect(error).toMatch(/was sent/i)
      expect(error).toMatch(/not simply retry/i)
      expect(error).not.toMatch(/was NOT sent/i)
      expect((result.data as Record<string, unknown>).input).toBe('trusted')
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses to click a file input, because the OS chooser it opens cannot be closed', async () => {
    // The most severe wedge in the failure-mode research: activating an
    // input[type=file] opens the NATIVE file chooser, which is not browser UI.
    // No CDP domain sees it, no extension API dismisses it, and it blocks the
    // user's browser window until a human deals with it. We shipped no guard.
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    const cdp = installCdpMock({ isFileInput: true })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(false)
    expect(String(result.error)).toMatch(/file input/i)
    // It must name the route that does work, or the agent just gives up. And
    // it must name the AGENT-FACING parameter: `file_name`/`file_base64` are
    // wire args the backend synthesizes from `path`, so pointing the agent at
    // them sends it to a call that is rejected for an unknown parameter.
    expect(String(result.error)).toMatch(/action="upload"/)
    expect(String(result.error)).toMatch(/\bpath=/)
    expect(String(result.error)).not.toMatch(/file_base64|file_name/)
    // Nothing may reach the page: a synthetic this.click() opens the chooser
    // exactly as a trusted one does, so refusing after the geometry check
    // would not be refusing at all.
    expect(methodsOf(cdp)).not.toContain('Input.dispatchMouseEvent')
  })

  it('refuses a hidden file input too, where the synthetic path would have fired', async () => {
    // The hidden file input behind a styled upload button is the common shape,
    // and it has no layout box, so click falls through to a synthetic
    // this.click(). That opens the chooser just the same.
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    const cdp = installCdpMock({ isFileInput: true, geometry: null })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(false)
    expect(String(result.error)).toMatch(/file input/i)
    const clicked = (cdp.mock.calls as unknown as [unknown, string, { functionDeclaration?: string }][])
      .some((c) => c[1] === 'Runtime.callFunctionOn' && (c[2].functionDeclaration ?? '').includes('this.click()'))
    expect(clicked, 'the synthetic fallback must not fire either').toBe(false)
  })

  it('still clicks ordinary inputs', async () => {
    // The guard must not become "refuse anything that looks like an input".
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    const cdp = installCdpMock({ isFileInput: false })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(true)
    expect(methodsOf(cdp)).toContain('Input.dispatchMouseEvent')
  })

  it('refuses a coordinate click that lands on a file input', async () => {
    // The vision-fallback shape, and the likeliest one to meet a visible
    // "Choose File" button: a coordinate is used precisely when the agent
    // could not resolve a ref to look at, so a guard that needs one would
    // miss the case it most needs to cover.
    const cdp = installCdpMock({ isFileInput: true })

    const result = await execAct({ tab_id: TAB, action: 'click', coordinate: [10, 20] })

    expect(result.ok).toBe(false)
    expect(String(result.error)).toMatch(/file input/i)
    expect(methodsOf(cdp)).not.toContain('Input.dispatchMouseEvent')
  })

  it('refuses a key press on a focused file input, which opens the chooser too', async () => {
    // Enter or Space on a focused input[type=file] opens the same OS chooser.
    // Scoping the guard to clicks would leave the justification ("the only
    // element whose activation is unrecoverable") only two-thirds honoured.
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    const cdp = installCdpMock({ isFileInput: true })

    const result = await execAct({ tab_id: TAB, action: 'key', ref: '@e1', value: 'Enter' })

    expect(result.ok).toBe(false)
    expect(String(result.error)).toMatch(/file input/i)
    expect(methodsOf(cdp)).not.toContain('Input.dispatchKeyEvent')
  })

  it('still right-clicks a file input, whose context menu is dismissable', async () => {
    // The guard is about activation, not about the element being present. A
    // context menu is ordinary browser UI the user can close, so refusing it
    // would be the guard overreaching.
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    const cdp = installCdpMock({ isFileInput: true })

    const result = await execAct({ tab_id: TAB, action: 'right_click', ref: '@e1' })

    expect(result.ok).toBe(true)
    expect(methodsOf(cdp)).toContain('Input.dispatchMouseEvent')
  })

  it('deadlines check/uncheck\'s read-back, which runs after its own click', async () => {
    // check/uncheck is the one verb whose renderer-bound verification lives
    // INSIDE the action rather than after the switch, so the post-dispatch
    // liveness check cannot cover it. A click that raises a dialog
    // asynchronously acks fine and suspends the renderer during this read.
    vi.useFakeTimers()
    try {
      setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
      installCdpMock({ rendererHangsAfterDispatch: true })

      const pending = execAct({ tab_id: TAB, action: 'check', ref: '@e1' })
      await vi.advanceTimersByTimeAsync(60_000)
      const result = await pending

      expect(result.ok).toBe(false)
      expect(String(result.error)).toMatch(/was sent/i)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not claim the input landed when the stall was on the opening pointer move', async () => {
    // A click opens with a mouseMoved. If a blocking hover handler stalls that
    // ack, no button was ever pressed, so the do-not-retry warning would be a
    // lie in the expensive direction: it discourages an action that never
    // happened.
    vi.useFakeTimers()
    try {
      setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
      installCdpMock({ inputAckHangsFrom: 1 })

      const pending = execAct({ tab_id: TAB, action: 'click', ref: '@e1' })
      await vi.advanceTimersByTimeAsync(60_000)
      const result = await pending

      expect(result.ok).toBe(false)
      expect(String(result.error)).toMatch(/NOT sent/i)
      expect((result.data as Record<string, unknown>).input).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails fast on a css= target too, where nothing is armed at all', async () => {
    // The seam this sits at matters. Target resolution runs BEFORE any delivery
    // probe and a `css=` selector resolves through a bare `Runtime.evaluate`, so
    // a check placed after arming never runs on this path and the command hangs
    // its full transport timeout. Review finding, 2026-08-11.
    vi.useFakeTimers()
    try {
      const cdp = installCdpMock({ rendererHangs: true })

      const pending = execAct({ tab_id: TAB, action: 'click', ref: 'css=#go' })
      await vi.advanceTimersByTimeAsync(60_000)
      const result = await pending

      expect(result.ok).toBe(false)
      expect(String(result.error)).toMatch(/did not run a script/i)
      expect(methodsOf(cdp)).not.toContain('Input.dispatchMouseEvent')
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails fast on a verb with no probeable events, like hover', async () => {
    // Coverage must not be decided by PROBE_EVENTS, which excludes hover and
    // scroll for reasons about event coalescing that have nothing to do with
    // noticing a dead renderer.
    vi.useFakeTimers()
    try {
      setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
      installCdpMock({ rendererHangs: true })

      const pending = execAct({ tab_id: TAB, action: 'hover', ref: '@e1' })
      await vi.advanceTimersByTimeAsync(60_000)
      const result = await pending

      expect(result.ok).toBe(false)
      expect(String(result.error)).toMatch(/did not run a script/i)
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails fast WITHOUT dispatching when the page will not run a script', async () => {
    // A page dialog suspends the renderer, so arming never returns. Before the
    // deadline this rode the 30s transport timeout and came back with no payload
    // and no action-scoped reason: measured live 2026-08-11 against a real
    // alert(). The tool-layer message names the dialog cause since 71a41e7b;
    // what was missing is failing FAST and per action.
    //
    // The not-dispatched assertion is the point. Sending input into a suspended
    // page cannot work, and every step after it (dispatch, settle, verification)
    // also runs in-page and would each wait out their own share of the timeout
    // to learn the same thing.
    vi.useFakeTimers()
    try {
      setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
      const cdp = installCdpMock({ rendererHangs: true })

      const pending = execAct({ tab_id: TAB, action: 'click', ref: '@e1' })
      await vi.advanceTimersByTimeAsync(60_000)
      const result = await pending

      expect(result.ok).toBe(false)
      expect(methodsOf(cdp)).not.toContain('Input.dispatchMouseEvent')
    } finally {
      vi.useRealTimers()
    }
  })

  it('names both causes of a stall and asserts neither', async () => {
    // A dialog and a long-running script are indistinguishable from out here.
    // The compared Chrome extension's equivalent messages each assert one wrong
    // cause ("showing error page", "page still loading") and its own operator
    // had to decode them, so this one lists both and commits to neither.
    vi.useFakeTimers()
    try {
      setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
      installCdpMock({ rendererHangs: true })

      const pending = execAct({ tab_id: TAB, action: 'click', ref: '@e1' })
      await vi.advanceTimersByTimeAsync(60_000)
      const result = await pending

      const error = String(result.error)
      expect(error).toMatch(/did not run a script/i)
      expect(error).toMatch(/alert, confirm, prompt/i)
      expect(error).toMatch(/long-running script/i)
      // Must not claim delivery failed: nothing was sent, so there is no verdict.
      expect(error).not.toMatch(/received no event/i)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the whole verification payload on the failure', async () => {
    // A failure that drops the diagnostics is a worse trade than the silent
    // success it replaced.
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    installCdpMock({ deliveryCount: 0 })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    const data = result.data as Record<string, unknown>
    expect(data).toBeDefined()
    expect(data.action).toBe('click')
    expect(data.url).toBe(TAB_URL)
    expect(data.settled).toBeDefined()
  })

  it('reports the channel and the outcome as two separate answers', async () => {
    // `input: "trusted"` says which pipe was used. It must keep saying that on
    // a dropped event, because collapsing the two is how the original bug read
    // as success.
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    installCdpMock({ deliveryCount: 0 })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    const data = result.data as { input: string; input_delivered: string }
    expect(data.input).toBe('trusted')
    expect(data.input_delivered).toBe('no')
  })

  it('succeeds and records delivery when the event arrived', async () => {
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    installCdpMock({ deliveryCount: 1 })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(true)
    expect((result.data as { input_delivered: string }).input_delivered).toBe('yes')
  })

  it('does not fail the command when delivery could not be proven either way', async () => {
    // Unprovable is not the same as failed. Turning "we could not check" into
    // an error would make the tool unusable wherever the probe cannot run.
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    installCdpMock({ deliveryWorld: false })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(true)
    expect((result.data as { input_delivered: string }).input_delivered).toBe('unknown')
  })

  it('treats an action that navigated the page as delivered', async () => {
    // The probe died with its document, so the count is unreadable, but a
    // navigation is proof the input landed.
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    installCdpMock({ deliveryReadThrows: 'Cannot find context with specified id' })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(true)
    expect((result.data as { input_delivered: string }).input_delivered).toBe('yes')
  })

  it('carries the per-event-type counts and activation state on a click (#176)', async () => {
    // The enriched shape: press, release and the composed click all counted,
    // nothing prevented, activation granted. One read answers what previously
    // took a four-call investigation.
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    installCdpMock({
      deliveryRead: {
        n: 3,
        types: { mousedown: 1, mouseup: 1, click: 1 },
        prevented: false,
        ua: { a: true, h: true },
      },
    })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(true)
    const data = result.data as Record<string, unknown>
    expect(data.input_delivered).toBe('yes')
    expect(data.input_events).toEqual({ mousedown: 1, mouseup: 1, click: 1 })
    expect(data.default_prevented).toBe(false)
    expect(data.user_activation).toEqual({ active: true, has_been_active: true })
  })

  it('makes a press that never composed into a click visible as such (#176)', async () => {
    // The frame-1 QA shape: delivered yes, yet no click in the counts and no
    // default_prevented claim. The payload must expose the gap instead of
    // rounding it to a bare "yes".
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    installCdpMock({
      deliveryRead: {
        n: 2,
        types: { mousedown: 1, mouseup: 1 },
        prevented: null,
        ua: { a: false, h: false },
      },
    })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(true)
    const data = result.data as Record<string, unknown>
    expect(data.input_delivered).toBe('yes')
    expect(data.input_events).toEqual({ mousedown: 1, mouseup: 1 })
    expect(data.default_prevented).toBeUndefined()
    expect(data.user_activation).toEqual({ active: false, has_been_active: false })
  })

  it('reports a composed click that a page handler cancelled', async () => {
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    installCdpMock({
      deliveryRead: { n: 3, types: { mousedown: 1, mouseup: 1, click: 1 }, prevented: true },
    })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect((result.data as Record<string, unknown>).default_prevented).toBe(true)
  })

  it('keeps user_activation and click_target off the non-click verbs', async () => {
    // Activation and target identity are the click family's diagnosis
    // (navigation-class default actions); on type/key they would be payload
    // noise claiming relevance they do not have.
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    installCdpMock({
      deliveryRead: {
        n: 1,
        types: { keydown: 1 },
        ua: { a: true, h: true },
        target: { tag: 'input' },
      },
    })

    const result = await execAct({ tab_id: TAB, action: 'type', ref: '@e1', value: 'a' })

    const data = result.data as Record<string, unknown>
    expect(data.input_events).toEqual({ keydown: 1 })
    expect(data.user_activation).toBeUndefined()
    expect(data.click_target).toBeUndefined()
  })

  it("names the composed click's target, anchor href included (#176)", async () => {
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    installCdpMock({
      deliveryRead: {
        n: 3,
        types: { mousedown: 1, mouseup: 1, click: 1 },
        prevented: false,
        target: { tag: 'a', href: 'https://dest.example/x' },
      },
    })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect((result.data as Record<string, unknown>).click_target).toEqual({
      tag: 'a',
      href: 'https://dest.example/x',
    })
  })

  it('keeps the event counts on a click that navigated, via the peek (#176)', async () => {
    // The navigation destroys the probe's world before the final read, but
    // the post-dispatch peek snapshotted the counters while the document
    // lived: the success payload stops being data-poorer than the failure.
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    installCdpMock({
      deliveryReadThrows: 'Cannot find context with specified id',
      deliveryPeek: {
        n: 3,
        types: { mousedown: 1, mouseup: 1, click: 1 },
        target: { tag: 'a', href: 'https://dest.example/x' },
      },
    })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(true)
    const data = result.data as Record<string, unknown>
    expect(data.input_delivered).toBe('yes')
    expect(data.input_events).toEqual({ mousedown: 1, mouseup: 1, click: 1 })
    expect(data.click_target).toEqual({ tag: 'a', href: 'https://dest.example/x' })
  })

  it('verifies fill delivery through its trusted input event (#176 rider)', async () => {
    // fill bypasses the browser input gate, but not every cause of a silent
    // miss is that gate: a dead frame document or a swallowed commit read the
    // same. The probe now covers it through the `input` event.
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    const send = installCdpMock({ deliveryRead: { n: 1, types: { input: 1 } } })

    const result = await execAct({ tab_id: TAB, action: 'fill', ref: '@e1', value: 'hi' })

    expect(result.ok).toBe(true)
    const data = result.data as Record<string, unknown>
    expect(data.input_delivered).toBe('yes')
    expect(data.input_events).toEqual({ input: 1 })
    const arm = send.mock.calls.find(
      (c) =>
        c[1] === 'Runtime.evaluate' &&
        String((c[2] as { expression?: string }).expression ?? '').includes('addEventListener'),
    )
    expect(String((arm?.[2] as { expression?: string }).expression)).toContain('"input"')
  })

  it('checks delivery for every verb that goes in through browser-level input', async () => {
    for (const action of ['click', 'double_click', 'right_click', 'key', 'type', 'fill']) {
      resetRefs()
      resetDelivery()
      setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
      installCdpMock({ deliveryCount: 0 })

      const result = await execAct({ tab_id: TAB, action, ref: '@e1', value: 'a' })

      expect(result.ok, `${action} must report an undelivered event as a failure`).toBe(false)
      expect(result.error, `${action} error text`).toMatch(/received no event/)
    }
  })

  it('does not probe the verbs that verify themselves or never enter input', async () => {
    // `select` and `check` run in-page, and `check` already verifies itself
    // by re-reading the control. (`fill` used to be in this list on the gate
    // rationale; #176 moved it to the probed set through its trusted `input`
    // event, because a dead frame document reads the same as the gate.)
    for (const [action, extra] of [
      ['select', { value: 'Option 2' }],
      ['check', {}],
    ] as const) {
      resetRefs()
      resetDelivery()
      setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
      const cdp = installCdpMock({ deliveryCount: 0, value: 'false' })

      const result = await execAct({ tab_id: TAB, action, ref: '@e1', ...extra })

      expect(result.ok, `${action} must not be failed by the delivery probe`).toBe(true)
      expect((result.data as Record<string, unknown>).input_delivered).toBeUndefined()
      // The TRUST world is legitimately created for every ref act; what these
      // verbs must never pay for is the DELIVERY world (the probe itself).
      const deliveryWorlds = cdp.mock.calls.filter(
        (c) =>
          c[1] === 'Page.createIsolatedWorld' &&
          (c[2] as { worldName?: string }).worldName === 'nymeria_delivery_probe',
      )
      expect(
        deliveryWorlds,
        `${action} must not pay for a probe it does not need`,
      ).toHaveLength(0)
    }
  })

  it('arms the probe after target resolution so setup cannot be counted as delivery', async () => {
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    const cdp = installCdpMock()

    await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    const methods = methodsOf(cdp)
    const armed = cdp.mock.calls.findIndex(
      (c) =>
        c[1] === 'Runtime.evaluate' &&
        String((c[2] as { expression?: string }).expression ?? '').includes('addEventListener'),
    )
    const dispatched = methods.indexOf('Input.dispatchMouseEvent')
    expect(armed).toBeGreaterThan(-1)
    // After resolution, so the resolve traffic cannot be counted as delivery,
    // and before dispatch, so the dispatch can be.
    expect(armed).toBeGreaterThan(methods.indexOf('DOM.resolveNode'))
    expect(dispatched).toBeGreaterThan(armed)
  })
})

describe('delivery in framed pages', () => {
  /**
   * The probe arms on the session the input rides (a cross-origin frame's own
   * session for frame refs: frames.test.ts pins that half), so the case left
   * for a downgrade is narrower than it used to be: a target that sits in a
   * nested context BELOW the probed document (a same-process iframe, whose
   * elements appear in the root tree). Events dispatched there never reach
   * the probed document's window, so a zero count means "not seen here", not
   * "not delivered", and failing on it would tell the agent to abandon a
   * working tab. A target directly IN the probed document keeps a zero count
   * conclusive; `absenceIsConclusive` splits the two by the element's own
   * document membership, checked in its trust world.
   */

  it('does not fail a click whose target sits below the probed document (same-process iframe)', async () => {
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    installCdpMock({ deliveryCount: 0, pageHasFrames: true, targetInTopDocument: false })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok, 'an unwatched nested context is not evidence of suppression').toBe(true)
    expect((result.data as { input_delivered: string }).input_delivered).toBe('unknown')
  })

  it('still fails when the target is in the top document the probe watched', async () => {
    // Frames exist, but this target is not in one, so a zero count is real.
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    installCdpMock({ deliveryCount: 0, pageHasFrames: true, targetInTopDocument: true })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/received no event/)
  })

  it('trusts a zero count outright when the document has no frames at all', async () => {
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    installCdpMock({ deliveryCount: 0, pageHasFrames: false })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(false)
  })

  it('does not fail an untargeted action on a framed page', async () => {
    // A keystroke with no ref goes to whatever holds focus, which on a framed
    // page may be inside a frame. With no target there is nothing to check the
    // absence against, so it cannot be confirmed.
    installCdpMock({ deliveryCount: 0, pageHasFrames: true })

    const result = await execAct({ tab_id: TAB, action: 'key', value: 'a' })

    expect(result.ok).toBe(true)
    expect((result.data as { input_delivered: string }).input_delivered).toBe('unknown')
  })

  it('still fails an untargeted action on a page with no frames', async () => {
    installCdpMock({ deliveryCount: 0, pageHasFrames: false })

    const result = await execAct({ tab_id: TAB, action: 'key', value: 'a' })

    expect(result.ok).toBe(false)
  })
})

describe('delivery is only asked about input we actually dispatched', () => {
  it('does not fail a click that deliberately fell back to synthetic dispatch', async () => {
    // A hidden file input has no layout box, so the click goes in as
    // `this.click()`. That produces no TRUSTED event by definition, so probing
    // it would fail the one path chrome_find's own docstring recommends for
    // upload buttons, on a page with nothing wrong with it.
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    installCdpMock({ geometry: null, deliveryCount: 0 })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(true)
    expect((result.data as { input: string }).input).toBe('synthetic')
    expect((result.data as Record<string, unknown>).input_delivered).toBeUndefined()
  })

  it('does not fail a type of the empty string, which dispatches nothing', async () => {
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    installCdpMock({ deliveryCount: 0 })

    const result = await execAct({ tab_id: TAB, action: 'type', ref: '@e1', value: '' })

    expect(result.ok).toBe(true)
    expect((result.data as Record<string, unknown>).input_delivered).toBeUndefined()
  })

  it('still checks a click that did go in as trusted input', async () => {
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    installCdpMock({ deliveryCount: 0 })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(false)
  })
})

/**
 * The predicate itself, EXECUTED against real DOM rather than answered by a
 * mock. The mock can only prove the guard consults something; these prove the
 * something is right, which is where the interesting cases live: the direct
 * input is the shape an agent is least likely to hold a ref for, because a
 * display:none input is absent from the accessibility tree and what the agent
 * gets is the visible affordance in front of it.
 */
describe('the file-chooser predicate', () => {
  const opensChooser = (el: Element): boolean =>
    new Function(__test.OPENS_FILE_CHOOSER).call(el) as boolean

  const build = (html: string): Document => {
    document.body.innerHTML = html
    return document
  }

  it('catches a direct file input', () => {
    build('<input id="t" type="file">')
    expect(opensChooser(document.getElementById('t')!)).toBe(true)
  })

  it('catches a label pointing at a hidden file input, the common real shape', () => {
    // <label for=x> + display:none input is how nearly every styled upload
    // button is built, and the label is what the accessibility tree surfaces.
    build('<label id="t" for="f">Upload</label><input id="f" type="file" style="display:none">')
    expect(opensChooser(document.getElementById('t')!)).toBe(true)
  })

  it('catches an element inside a label that wraps the input', () => {
    build('<label><span id="t">Choose a file</span><input type="file"></label>')
    expect(opensChooser(document.getElementById('t')!)).toBe(true)
  })

  it('leaves ordinary controls alone', () => {
    build('<button id="b">Send</button><input id="i" type="text"><label id="l" for="i">Name</label>')
    for (const id of ['b', 'i', 'l']) {
      expect(opensChooser(document.getElementById(id)!), `${id} must not be refused`).toBe(false)
    }
  })

  it('is not fooled by a type attribute that only looks like one', () => {
    build('<input id="t" type="text" value="file"><div id="d" type="file">x</div>')
    expect(opensChooser(document.getElementById('t')!)).toBe(false)
    expect(opensChooser(document.getElementById('d')!)).toBe(false)
  })
})

/**
 * Two failures that both report success while nothing happens, which is the
 * shape #162 exists to remove. One is ours by construction (a ref that
 * resolves to a node the page already removed); the other was MEASURED on the
 * official Claude in Chrome extension 2026-08-12 and has a twin here.
 */
describe('targeting honesty', () => {
  it('refuses a ref that resolves but is detached, before sending anything', async () => {
    // Blink's DOMNodeId map is keyed on GC liveness, not attachment, so a node
    // React removed but still caches RESOLVES. Acting fires the page handler
    // against a detached node: success reported, nothing on screen.
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    const cdp = installCdpMock({ targetConnected: false })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(false)
    expect(inputEventTypes(cdp), 'nothing may be dispatched at a detached node').toHaveLength(0)
    const error = String(result.error)
    expect(error).toMatch(/no longer in the page/i)
    expect(error).toMatch(/re-read the page/i)
    // It must NOT read as "the ref was never valid": it was, and the
    // difference tells the agent the page changed under it.
    expect(error).toMatch(/still resolves/i)
    expect((result.data as { reason: string }).reason).toBe('detached')
  })

  it('still acts on a ref whose connectedness cannot be determined', async () => {
    // A dead execution context answers nothing. Unknowable is not detached,
    // and refusing here would fail an action that was about to work.
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    const cdp = installCdpMock({ targetConnected: null as unknown as boolean })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(true)
    expect(inputEventTypes(cdp)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased'])
  })

  it('names what a coordinate click landed on, so a mis-aim is not a silent success', async () => {
    // The delivery counter sits at window capture, so a click on empty page
    // background produces a trusted click event that COUNTS: input_delivered
    // says yes and the agent learns nothing. Measured on the competing
    // harness: a stale coordinate hit blank margin and the payload said only
    // "Clicked at (65, 146)".
    const cdp = installCdpMock({ pointDescription: 'body' })

    const result = await execAct({ tab_id: TAB, action: 'click', coordinate: [65, 146] })

    expect(result.ok).toBe(true)
    expect(inputEventTypes(cdp)).toContain('mousePressed')
    const data = result.data as { hit?: string; input_delivered?: string }
    expect(data.hit, 'the payload must say what was under the point').toBe('body')
    // The honest pairing: input DID reach the page, and it reached nothing
    // useful. Both facts, neither hidden.
    expect(data.input_delivered).toBe('yes')
  })

  it('names the drag source as such rather than as what the drag hit', async () => {
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    installCdpMock({ pointDescription: 'div.card' })

    const result = await execAct({
      tab_id: TAB,
      action: 'drag',
      coordinate: [10, 10],
      to_ref: '@e1',
    })

    const data = result.data as { hit?: string; hit_from?: string }
    expect(data.hit_from).toBe('div.card')
    expect(data.hit, 'a drag has two points; an unqualified "hit" would lie').toBeUndefined()
  })

  it('propagates a session-layer failure from the pre-check instead of acting anyway', async () => {
    // stillConnected swallows everything by design (it also runs AFTER the
    // action, where an unanswerable probe is just a missing field). The
    // pre-dispatch twin must not: if the tab went unusable between resolution
    // and now, "unknown, carry on" sends input into a tab already known to be
    // dead, after burning most of the command's budget on the deadline.
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    installCdpMock({ connectedThrows: 'timeout' })

    await expect(execAct({ tab_id: TAB, action: 'click', ref: '@e1' })).rejects.toThrow(
      /did not answer/i,
    )
  })

  it('gives a detached drag DESTINATION the same honest error as a detached source', async () => {
    // A detached node has a zero rect, so geometry returns null and the drag
    // used to fail with "needs a resolvable to_ref destination", which is
    // false (it resolved fine) and never tells the agent to re-read.
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    const cdp = installCdpMock({ targetConnected: false })

    const result = await execAct({
      tab_id: TAB,
      action: 'drag',
      coordinate: [10, 10],
      to_ref: '@e1',
    })

    expect(result.ok).toBe(false)
    const error = String(result.error)
    expect(error).toMatch(/drag destination/i)
    expect(error).toMatch(/no longer in the page/i)
    expect(error).not.toMatch(/needs a resolvable/i)
    expect(inputEventTypes(cdp)).toHaveLength(0)
  })

  it('refuses a coordinate click onto a file input naming what it found there', async () => {
    // The refusal has no ref to quote, but it looked at the point already.
    const cdp = installCdpMock({ isFileInput: true, pointDescription: 'input#file-upload' })

    const result = await execAct({ tab_id: TAB, action: 'click', coordinate: [65, 146] })

    expect(result.ok).toBe(false)
    expect(String(result.error)).toContain('input#file-upload')
    expect(String(result.error)).toMatch(/path=/)
    expect(inputEventTypes(cdp)).toHaveLength(0)
  })

  it('does not claim a hit for a ref act, which already names its target', async () => {
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    installCdpMock()

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(true)
    expect((result.data as { hit?: string }).hit).toBeUndefined()
    expect((result.data as { target?: string }).target).toBe('@e1')
  })
})

/**
 * The pre-dispatch actionability gates: the four facts the widened
 * connectedness probe brings back, and what each verb does with them.
 *
 * The shape under test is "refuse only on a definite answer, annotate never
 * refuse for visibility, and cost nothing extra to ask". Each refusal must
 * also be honest about having sent nothing: no delivery probe armed, no
 * Input.* call, `input: "none"`.
 */
describe('actionability gates', () => {
  /** The widened probe's own calls, identified the way the code identifies
   *  them: by the body, not by call order. */
  const probeCalls = (mock: ReturnType<typeof installCdpMock>) =>
    mock.mock.calls.filter(
      (c) =>
        c[1] === 'Runtime.callFunctionOn' &&
        String((c[2] as { functionDeclaration?: string }).functionDeclaration).includes(
          'checkVisibility',
        ),
    )

  const armedDelivery = (mock: ReturnType<typeof installCdpMock>) =>
    mock.mock.calls.some(
      (c) =>
        c[1] === 'Runtime.evaluate' &&
        String((c[2] as { expression?: string }).expression).includes('addEventListener'),
    )

  const bodies = (mock: ReturnType<typeof installCdpMock>) =>
    mock.mock.calls
      .filter((c) => c[1] === 'Runtime.callFunctionOn')
      .map((c) => String((c[2] as { functionDeclaration?: string }).functionDeclaration))

  it('refuses a click on a disabled control, before anything is dispatched', async () => {
    // A disabled control receives no events at all, so the pre-existing
    // outcome was a delivery failure blaming input suppression on a page
    // with nothing wrong with it.
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    const cdp = installCdpMock({ disabled: true })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(false)
    expect(String(result.error)).toMatch(/disabled/i)
    const data = result.data as { refused?: string; input?: string; input_delivered?: string }
    expect(data.refused).toBe('disabled')
    expect(data.input).toBe('none')
    expect(inputEventTypes(cdp), 'nothing may be dispatched at a disabled control').toHaveLength(0)
    // The honesty half: delivery is never consulted for input that was
    // never sent, so no probe is armed and no verdict is invented.
    expect(armedDelivery(cdp)).toBe(false)
    expect(data.input_delivered).toBeUndefined()
  })

  it('refuses check on a disabled checkbox without reaching the force path', async () => {
    // check/uncheck read their own outcome back and FORCE the property when
    // the click did not take. On a disabled control that force would set
    // `checked` the page never saw changed and report success.
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    const cdp = installCdpMock({ disabled: true, value: 'false' })

    const result = await execAct({ tab_id: TAB, action: 'check', ref: '@e1' })

    expect(result.ok).toBe(false)
    expect((result.data as { refused?: string }).refused).toBe('disabled')
    expect(inputEventTypes(cdp)).toHaveLength(0)
    expect(
      bodies(cdp).some((fn) => fn.includes('this.checked = want')),
      'the force path must never run for a control the browser will not act on',
    ).toBe(false)
  })

  it('refuses fill and ref-targeted type on a readonly field, sending no text', async () => {
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    const filled = installCdpMock({ readonly: true, textEntry: true })

    const fill = await execAct({ tab_id: TAB, action: 'fill', ref: '@e1', value: 'hello' })

    expect(fill.ok).toBe(false)
    expect(String(fill.error)).toMatch(/read-only/i)
    expect((fill.data as { refused?: string }).refused).toBe('readonly')
    expect(
      methodsOf(filled).filter((m) => m === 'Input.insertText'),
      'insertText into a readonly field no-ops and then reads as a suppressed tab',
    ).toHaveLength(0)

    const typed = installCdpMock({ readonly: true, textEntry: true })
    const type = await execAct({ tab_id: TAB, action: 'type', ref: '@e1', value: 'hello' })

    expect(type.ok).toBe(false)
    expect((type.data as { refused?: string }).refused).toBe('readonly')
    expect(methodsOf(typed).filter((m) => m === 'Input.dispatchKeyEvent')).toHaveLength(0)
  })

  it('fills a field whose own focus handler removes readonly, which is the common one', async () => {
    // `<input readonly onfocus="this.readOnly = false">` is how sites
    // suppress autofill and force a date picker. It accepts text once
    // focused, so refusing on the probe's earlier answer would block an act
    // that works end to end. The verdict is therefore re-asked after the
    // focus each text verb already performs.
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    const cdp = installCdpMock({ readonly: true, textEntry: true, readonlyClearsOnFocus: true })

    const result = await execAct({ tab_id: TAB, action: 'fill', ref: '@e1', value: 'hello' })

    expect(result.ok).toBe(true)
    expect(methodsOf(cdp)).toContain('Input.insertText')
    // And the re-ask happened AFTER the focus, or it would have answered
    // the same stale readonly the probe did.
    const order = cdp.mock.calls.map((c) => {
      if (c[1] !== 'Runtime.callFunctionOn') return String(c[1])
      const fn = String((c[2] as { functionDeclaration?: string }).functionDeclaration)
      // The widened probe carries this same question, so the re-ask is the
      // one that asks it ALONE.
      return fn.includes('this.readOnly === true') && !fn.includes('checkVisibility')
        ? 'recheck'
        : 'other'
    })
    expect(order.indexOf('recheck')).toBeGreaterThan(order.indexOf('DOM.focus'))
  })

  it('leaves a fill on a non-text-entry target exactly as it was', async () => {
    // `readOnly` is true on a checkbox too, where it means nothing. The
    // editable classification is what makes the refusal about text entry;
    // without it this act would start refusing on a fact that does not
    // apply to it.
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    const cdp = installCdpMock({ readonly: true, textEntry: false })

    const result = await execAct({ tab_id: TAB, action: 'fill', ref: '@e1', value: 'hello' })

    expect(result.ok).toBe(true)
    expect(methodsOf(cdp)).toContain('Input.insertText')
  })

  it('leaves the verbs that enter no input alone on a disabled target', async () => {
    // Regression pins. `hover` moves nothing into the page, and `upload`
    // deliberately targets inputs the page has hidden or switched off: a
    // blanket gate would break both.
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    const hovered = installCdpMock({ disabled: true })

    const hover = await execAct({ tab_id: TAB, action: 'hover', ref: '@e1' })

    expect(hover.ok).toBe(true)
    expect(inputEventTypes(hovered)).toContain('mouseMoved')

    installCdpMock({ disabled: true })
    const upload = await execAct({
      tab_id: TAB,
      action: 'upload',
      ref: '@e1',
      file_name: 'a.txt',
      file_base64: 'YQ==',
    })

    expect(upload.ok).toBe(true)
    expect((upload.data as { input?: string }).input).toBe('synthetic')
  })

  it('clicks an invisible target that wins the hit test, and says it was invisible', async () => {
    // R-07's opacity half. An opacity-0 element that is still the topmost
    // hit is very often the deliberate click target (an invisible real
    // input over styled UI), so the act proceeds TRUSTED and the payload
    // carries the fact instead of the click being a silent success.
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    const cdp = installCdpMock({ visible: false })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(true)
    const data = result.data as { target_invisible?: boolean; input?: string }
    expect(data.target_invisible).toBe(true)
    expect(data.input).toBe('trusted')
    expect(inputEventTypes(cdp)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased'])
  })

  it('keeps the no-layout-box fallback synthetic, and still says the target was invisible', async () => {
    // A `display:none` target has no box, so it takes the labelled
    // synthetic path rather than a trusted click. Both facts are true at
    // once and the payload must carry both: the annotation never implies
    // the target won a hit test.
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    const cdp = installCdpMock({ geometry: null, visible: false })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(true)
    const data = result.data as { input?: string; synthetic_reason?: string; target_invisible?: boolean }
    expect(data.input).toBe('synthetic')
    expect(data.synthetic_reason).toMatch(/no layout box/)
    expect(data.target_invisible).toBe(true)
    expect(inputEventTypes(cdp)).toHaveLength(0)
  })

  it('carries no invisibility key on an ordinary visible target', async () => {
    // Otherwise the annotation becomes furniture the agent learns to skim.
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    installCdpMock()

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(true)
    expect((result.data as { target_invisible?: boolean }).target_invisible).toBeUndefined()
  })

  it('does not annotate invisibility on a verb that is not about clicking what is there', async () => {
    // A fill into an invisible field is the everyday custom-widget shape,
    // and its outcome is verified by the value, not by what the eye sees.
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    installCdpMock({ visible: false, textEntry: true })

    const result = await execAct({ tab_id: TAB, action: 'fill', ref: '@e1', value: 'x' })

    expect(result.ok).toBe(true)
    expect((result.data as { target_invisible?: boolean }).target_invisible).toBeUndefined()
  })

  it('blames pointer-events, not the element behind, when the target ignores pointers', async () => {
    // The misdiagnosis this fixes: elementFromPoint answers whatever is
    // BEHIND a pointer-events:none target, and the old copy named that
    // element as an intercepting overlay to dismiss.
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    const cdp = installCdpMock({
      hit: { hit: false, blocker: 'div#page-backdrop' },
      pointerEventsNone: true,
    })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(false)
    const error = String(result.error)
    expect(error).toMatch(/pointer-events/i)
    expect(error).not.toMatch(/covered by/i)
    // And it must not send the agent off dismissing the element behind: the
    // copy says what is true of THIS element, without claiming (which the
    // probe cannot know) that nothing is in front of it either.
    expect(error).toMatch(/not take the click/i)
    expect((result.data as { refused?: string }).refused).toBe('pointer_events_none')
    expect(inputEventTypes(cdp)).toHaveLength(0)
  })

  it('refuses when an ANCESTOR is what the click would hit, which the hit test calls a hit', async () => {
    // The commonest pointer-events:none layout by far: the element is
    // transparent to hit testing, so elementFromPoint answers the wrapper
    // sitting in the same pixels, and containment accepts that as a hit.
    // The event would target the wrapper, and events do not travel DOWN, so
    // the target never sees it. Without this the refusal almost never fires.
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    const cdp = installCdpMock({
      hit: { hit: true, via: 'ancestor', blocker: 'section#plans' },
      pointerEventsNone: true,
    })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(false)
    expect(String(result.error)).toMatch(/pointer-events/i)
    expect(String(result.error)).toContain('section#plans')
    expect((result.data as { refused?: string }).refused).toBe('pointer_events_none')
    expect(inputEventTypes(cdp)).toHaveLength(0)
  })

  it('still clicks when a DESCENDANT of the target is what the point lands on', async () => {
    // The legitimate exception, and a real pattern: a pointer-events:none
    // container whose own controls set pointer-events:auto. The click lands
    // inside the target's own subtree, so it is not a miss.
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    const cdp = installCdpMock({
      hit: { hit: true, via: 'descendant' },
      pointerEventsNone: true,
    })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(true)
    expect(inputEventTypes(cdp)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased'])
  })

  it('hands back the coordinate with the pointer-events refusal, because the label case works', async () => {
    // The element the click WOULD hit is very often the target's own label
    // or wrapper, where a deliberate click activates the target anyway
    // (label activation behaviour). Refusing without the coordinate would
    // delete the one exit that works.
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    installCdpMock({
      hit: { hit: true, via: 'ancestor', blocker: 'label#plan' },
      pointerEventsNone: true,
    })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    const data = result.data as { intercepted_by?: string; click_point?: number[] }
    expect(data.intercepted_by).toBe('label#plan')
    expect(data.click_point).toEqual([50, 60])
    expect(String(result.error)).toMatch(/coordinate=\[50, 60\]/)
    expect(String(result.error)).toMatch(/label or wrapper/i)
  })

  it('does not refuse on a pointer-events state that cleared before the hit test', async () => {
    // The probe runs several round trips before the hit test, and one cause
    // this refusal NAMES is an element mid-transition, which is exactly the
    // state most likely to have cleared in between. Refusing on the stale
    // read would be this pass's own misdiagnosis inverted.
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    const cdp = installCdpMock({
      hit: { hit: true, via: 'ancestor', blocker: 'div#fade' },
      pointerEventsNone: true,
      pointerEventsClearsBeforeRefusal: true,
    })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(true)
    expect(inputEventTypes(cdp)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased'])
  })

  it('says an ancestor WRAPS the target rather than covering it, when focus misses', async () => {
    // The click-through copy is written for an element ON TOP of the
    // target. With a pointer-events:none target the element that took the
    // click is around it, and "was over it" would be a false claim.
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    installCdpMock({
      hit: { hit: true, via: 'ancestor', blocker: 'div#editor' },
      pointerEventsNone: true,
      textEntry: true,
      focusLanded: false,
    })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(false)
    expect(String(result.error)).toMatch(/div#editor wraps it/)
    expect(String(result.error)).not.toMatch(/was over it/)
  })

  it('keeps the covered-by refusal when the target does receive pointer events', async () => {
    // The other half of the same fork: a real overlay must still be named,
    // with the click-through the #174 copy teaches.
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    installCdpMock({ hit: { hit: false, blocker: 'div#page-backdrop' } })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(false)
    expect(String(result.error)).toMatch(/covered by div#page-backdrop/)
    expect(String(result.error)).not.toMatch(/pointer-events/i)
  })

  it('names pointer-events for check/uncheck too', async () => {
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    const cdp = installCdpMock({
      hit: { hit: false, blocker: 'span.switch' },
      pointerEventsNone: true,
      value: 'false',
    })

    const result = await execAct({ tab_id: TAB, action: 'check', ref: '@e1' })

    expect(result.ok).toBe(false)
    expect(String(result.error)).toMatch(/pointer-events/i)
    expect((result.data as { refused?: string }).refused).toBe('pointer_events_none')
    expect(inputEventTypes(cdp)).toHaveLength(0)
  })

  it('still clicks a covered TEXT-ENTRY target through, pointer-events or not (#174)', async () => {
    // The editor case the covered-click exception exists for: the render
    // surface is a sibling, the real input is what the ref names, and the
    // click is delivered and verified by focus. The pointer-events copy
    // must sit behind that exception, not in front of it.
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    const cdp = installCdpMock({
      hit: { hit: false, blocker: 'pre.CodeMirror-line' },
      pointerEventsNone: true,
      textEntry: true,
      focusLanded: true,
    })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(true)
    expect((result.data as { clicked_through?: string }).clicked_through).toBe(
      'pre.CodeMirror-line',
    )
    expect(inputEventTypes(cdp)).toContain('mousePressed')
    // And the classification came from the widened probe, not from a second
    // call running the same function body on the same handle.
    const standaloneClassify = bodies(cdp).filter(
      (fn) => fn.includes('isContentEditable') && !fn.includes('checkVisibility'),
    )
    expect(standaloneClassify).toHaveLength(0)
  })

  it('proceeds when the probe answers nothing it can use (fail open)', async () => {
    // The gate contract: refuse on an explicit answer only. A probe that
    // returned a partial object, or something that is not an object at all,
    // must never turn into a refusal.
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    installCdpMock({ actionabilityRaw: { connected: true } })

    const partial = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(partial.ok).toBe(true)
    expect((partial.data as { target_invisible?: boolean }).target_invisible).toBeUndefined()

    installCdpMock({ actionabilityRaw: 'not an object' })
    const malformed = await execAct({ tab_id: TAB, action: 'fill', ref: '@e1', value: 'x' })

    expect(malformed.ok).toBe(true)
  })

  it('acts anyway when the probe itself fails, but not when the SESSION did', async () => {
    // Same split every other pre-dispatch gate makes: a probe that could
    // not run must not block the act (the delivery verification backstops
    // it), while a timed-out or unusable tab is about the TAB and keeps its
    // own honest copy rather than being swallowed into "unknown, carry on".
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    const cdp = installCdpMock({ actionabilityThrows: 'Cannot find context with specified id' })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(true)
    expect(inputEventTypes(cdp)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased'])

    installCdpMock({ connectedThrows: 'timeout' })
    await expect(execAct({ tab_id: TAB, action: 'click', ref: '@e1' })).rejects.toThrow(
      /did not answer/i,
    )
  })

  it('lets the fingerprint gate answer first when the element also changed meaning', async () => {
    // Precedence, and it matters: an element whose MEANING changed sends
    // the agent to re-read, where "it is disabled" would be advice about
    // the wrong element entirely.
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    installCdpMock({ disabled: true, axName: 'Delete' })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(false)
    const data = result.data as { stale_refs?: boolean; reason?: string; refused?: string }
    expect(data.stale_refs).toBe(true)
    expect(data.reason).toBe('changed')
    expect(data.refused).toBeUndefined()
  })

  it('refuses select on a disabled control, where the old path faked a success', async () => {
    // select is a pure in-page property set, so it SUCCEEDED on a disabled
    // <select> and always did: an option no person could have chosen, on a
    // control the form will not submit.
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    const cdp = installCdpMock({ disabled: true })

    const result = await execAct({ tab_id: TAB, action: 'select', ref: '@e1', value: 'Two' })

    expect(result.ok).toBe(false)
    expect((result.data as { refused?: string }).refused).toBe('disabled')
    expect(
      bodies(cdp).some((fn) => fn.includes('this.options')),
      'the value must not be set on a control the user cannot use',
    ).toBe(false)
  })

  it('leaves css= targets alone: they are not probed, so they behave as before', async () => {
    // The probe rides the connectedness call, which only `@` refs make. A
    // css= target would need a NEW round trip, so it keeps its previous
    // behaviour rather than paying for one, and nothing may quietly start
    // refusing it on a fact nobody asked for.
    const cdp = installCdpMock({ disabled: true, readonly: true, textEntry: true })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: 'css=.btn' })

    expect(result.ok).toBe(true)
    expect(inputEventTypes(cdp)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased'])
    expect(probeCalls(cdp), 'no widened probe is spent on a css= target').toHaveLength(0)
  })

  it('asks all of it in ONE round trip, which is why the checks are affordable', async () => {
    // The ratchet (five naive checks would have been five more callOns on
    // the commonest verb). One call, and it is the SAME call that answers
    // connectedness: the probe body must still carry that question.
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    const cdp = installCdpMock()

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(true)
    const probes = probeCalls(cdp)
    expect(probes).toHaveLength(1)
    const body = String((probes[0][2] as { functionDeclaration?: string }).functionDeclaration)
    expect(body, 'connectedness rides the same call, it is not a second one').toContain(
      'isConnected',
    )
    // And no separate pre-dispatch connectedness call survives beside it:
    // the only other isConnected body is the POST-action `stillConnected`.
    const connectednessCalls = bodies(cdp).filter((fn) => fn.includes('isConnected'))
    expect(connectednessCalls).toHaveLength(2)
  })
})

/**
 * Executed against real DOM, not mocked, because the mock fabricates the
 * value this logic produces and would have carried a syntax error or the
 * subtree-text bug straight into production with every test green.
 *
 * The bug this exists to prevent, caught in review: the first version used
 * `innerText`, which is SUBTREE text, so a click on empty background reported
 * `body "Acme Home About Contact Sign in ..."` (the words of everything the
 * click did NOT hit) instead of `body`. The field's entire purpose is to make
 * a mis-aim obvious, and that inverted it.
 */
describe('the coordinate description', () => {
  const describeEl = (el: Element): string =>
    new Function(__test.DESCRIBE_ELEMENT).call(el) as string

  const build = (html: string): void => {
    document.body.innerHTML = html
  }

  it('names a container WITHOUT the text of everything inside it', () => {
    build('<div><h1>Acme</h1><p>Home About Contact</p><button>Sign in</button></div>')
    expect(describeEl(document.body)).toBe('body')
  })

  it('labels a leaf control by its own text', () => {
    build('<button id="t">Sign in</button>')
    expect(describeEl(document.getElementById('t')!)).toBe('button#t "Sign in"')
  })

  it('reads a label through a nested span, the usual button shape', () => {
    build('<button id="t"><span>Add to cart</span></button>')
    expect(describeEl(document.getElementById('t')!)).toBe('button#t "Add to cart"')
  })

  it('prefers explicit labelling over text', () => {
    build('<button id="t" aria-label="Close dialog">x</button>')
    expect(describeEl(document.getElementById('t')!)).toBe('button#t "Close dialog"')
  })

  it('falls back to the first class when there is no id and nothing to label with', () => {
    build('<div id="w"><div class="cookie-banner overlay"></div></div>')
    expect(describeEl(document.querySelector('.cookie-banner')!)).toBe('div.cookie-banner')
  })

  it('drops text that is too long to be a label', () => {
    build(`<section class="content"><p>${'word '.repeat(40)}</p></section>`)
    expect(describeEl(document.querySelector('.content')!)).toBe('section.content')
  })

  it('never takes text from html, whatever the page contains', () => {
    build('<p>short</p>')
    expect(describeEl(document.documentElement)).toBe('html')
  })

  it('does not let a quote in a label unbalance the description', () => {
    build('<button id="t" aria-label=\'say "hi" now\'>x</button>')
    expect(describeEl(document.getElementById('t')!)).toBe('button#t "say \'hi\' now"')
  })

  it('collapses whitespace and truncates, so one field cannot flood the payload', () => {
    build(`<button id="t" aria-label="${'x'.repeat(200)}">y</button>`)
    const out = describeEl(document.getElementById('t')!)
    expect(out.length).toBeLessThan(80)
    build('<button id="u" aria-label="a\n\n   b">y</button>')
    expect(describeEl(document.getElementById('u')!)).toBe('button#u "a b"')
  })

  it('survives an element whose getters throw, rather than losing the answer', () => {
    // A hostile page can define these. The verdict half of the probe is
    // computed first and separately guarded, so a throwing description costs
    // the label and not the file-input refusal.
    build('<div id="t">x</div>')
    const el = document.getElementById('t')!
    Object.defineProperty(el, 'textContent', {
      get() {
        throw new Error('nope')
      },
    })
    expect(describeEl(el)).toBe('unknown')
  })
})

/**
 * The file chooser, PREVENTED (#169).
 *
 * A JS-driven upload button (`<button onclick="input.click()">`) is invisible
 * to the static guard, and the OS chooser it used to open blocked the USER's
 * window while the page kept reading perfectly healthy. Interception
 * (`Page.setInterceptFileChooserDialog`, armed per attach now that the same
 * client owns `Page`) stops the picker outright: Chrome emits
 * `Page.fileChooserOpened` instead, `dialogs.ts` records it, and the act
 * reports it. These tests mock the dialogs seam and assert what an act DOES
 * with each recorded outcome; the event-to-record plumbing has its own tests
 * in dialogs.test.ts, the same split the delivery probe uses.
 */
describe('file chooser interception', () => {
  it('arms interception at attach, where the old invariant forbade it', async () => {
    // The inverse of the pre-#169 test that pinned these methods' ABSENCE:
    // Page ownership makes interception real instead of a silent no-op, so
    // the attach arms it eagerly and the act itself never has to.
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    const cdp = installCdpMock()

    await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    const methods = methodsOf(cdp)
    expect(methods).toContain('Page.enable')
    expect(methods).toContain('Page.setInterceptFileChooserDialog')
  })

  it('fails the act and says the picker did NOT open', async () => {
    // A failure, not a success with a flag: the page is waiting on a file
    // that will never arrive, and the agent must switch to the upload route.
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    installCdpMock()
    vi.mocked(chooserInterceptedSince).mockReturnValue({ at: Date.now(), mode: 'selectSingle' })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(false)
    const error = String(result.error)
    expect(error).toMatch(/file chooser/i)
    expect(error, 'interception makes this claim honest now').toMatch(/no picker opened/i)
    expect(error, 'each repeat re-triggers the chooser').toMatch(/do not repeat the click/i)
    // It must name the route that works, with the AGENT-facing signature.
    expect(error).toMatch(/action="upload"/)
    expect(error).toMatch(/path=/)
    expect(error).not.toMatch(/file_base64|file_name/)
    expect((result.data as { chooser_intercepted?: boolean }).chooser_intercepted).toBe(true)
  })

  it('outranks the undelivered verdict when both fire', async () => {
    // The undelivered advice ends in "close the tab", which is the wrong
    // move here: the interception is direct evidence the action ran in the
    // page, and the useful remedy is the upload route.
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    installCdpMock({ deliveryCount: 0 })
    vi.mocked(chooserInterceptedSince).mockReturnValue({ at: Date.now(), mode: 'selectSingle' })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(false)
    const error = String(result.error)
    expect(error).toMatch(/file chooser/i)
    expect(error, 'the recovery advice for a dead tab must not win here').not.toMatch(
      /close the tab/i,
    )
    const data = result.data as { input_delivered?: string; chooser_intercepted?: boolean }
    expect(data.chooser_intercepted).toBe(true)
    expect(data.input_delivered, 'both facts still ride along on the failure').toBe('no')
  })

  it('names the verb that reached the input, not always "click"', async () => {
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    installCdpMock()
    vi.mocked(chooserInterceptedSince).mockReturnValue({ at: Date.now(), mode: 'selectSingle' })

    const result = await execAct({ tab_id: TAB, action: 'key', ref: '@e1', value: 'Enter' })

    expect(result.ok).toBe(false)
    expect(String(result.error)).toMatch(/the key on @e1 tried to open/)
  })

  it('names what a coordinate hit, since there is no ref to quote', async () => {
    installCdpMock({ pointDescription: 'button "Attach"' })
    vi.mocked(chooserInterceptedSince).mockReturnValue({ at: Date.now(), mode: 'selectSingle' })

    const result = await execAct({ tab_id: TAB, action: 'click', coordinate: [100, 200] })

    expect(result.ok).toBe(false)
    expect(String(result.error)).toMatch(/button "Attach" tried to open/)
  })

  it('keeps the full verification payload on that failure', async () => {
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    installCdpMock()
    vi.mocked(chooserInterceptedSince).mockReturnValue({ at: Date.now(), mode: 'selectSingle' })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    const data = result.data as { input_delivered?: string; settled?: unknown; url?: string }
    expect(data.input_delivered, 'the click DID reach the page; both facts are true').toBe('yes')
    expect(data.settled).toBeDefined()
    expect(data.url).toBe(TAB_URL)
  })

  it('does not report a chooser for an ordinary click', async () => {
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    installCdpMock()

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(true)
    expect((result.data as { chooser_intercepted?: boolean }).chooser_intercepted).toBeUndefined()
  })
})

/**
 * Dialogs the extension OWNS during an act (#169).
 *
 * The dialogs module records what opened and what resolved; these tests
 * assert what an act does with each state. A standing dialog before the act
 * refuses by name; one the act itself raised returns a SUCCESS carrying the
 * answer route (the input was delivered, and failing it would invite the
 * double-submitting retry); one that already resolved (the auto-acked alert)
 * rides the payload as history.
 */
describe('owned dialogs during an act', () => {
  const CONFIRM: StandingDialogT = {
    type: 'confirm',
    message: 'Delete this item?',
    url: TAB_URL,
    openedAt: Date.now(),
    deadlineAt: Date.now() + 60_000,
  }

  it('names the dialog when a synchronous confirm() stalls the dispatch ack itself', async () => {
    // The live-QA branch (2026-08-14): a click handler that calls confirm()
    // suspends the renderer before Chrome acks the press, so execution lands
    // in the InputDispatchStalled catch, never reaching the post-dispatch
    // dialog checks. The opening event has already arrived by then, and the
    // agent must get the same delivered-plus-answer-route success as the
    // async case, not the two-guesses stall copy.
    vi.useFakeTimers()
    try {
      setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
      installCdpMock({ inputAckHangsFrom: 2 }) // the press lands, its ack never returns
      vi.mocked(standingDialog)
        .mockReturnValueOnce(null) // pre-dispatch: nothing standing yet
        .mockReturnValue(CONFIRM) // by the stall deadline the confirm is recorded

      const pending = execAct({ tab_id: TAB, action: 'click', ref: '@e1' })
      await vi.advanceTimersByTimeAsync(60_000)
      const result = await pending

      expect(result.ok, 'the input was delivered; failing it invites a double-submit').toBe(true)
      const data = result.data as { input?: string; dialog?: { message?: string; note?: string } }
      expect(data.input).toBe('trusted')
      expect(data.dialog?.message).toBe('Delete this item?')
      expect(data.dialog?.note).toMatch(/Do not repeat the click/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports unknown delivery when the stall hit before the action was confirmed', async () => {
    // Ack order is not a delivery oracle (measured live: a click whose
    // confirm() opened mid-dispatch stalled the MOVE ack while the press had
    // plainly been processed). So this branch must not claim NOT-sent (a
    // double-submit invitation) nor delivered (skips a needed redo): it says
    // delivery is unknown and teaches answer, re-read, then decide.
    vi.useFakeTimers()
    try {
      setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
      installCdpMock({ inputAckHangsFrom: 1 })
      vi.mocked(standingDialog).mockReturnValueOnce(null).mockReturnValue(CONFIRM)

      const pending = execAct({ tab_id: TAB, action: 'click', ref: '@e1' })
      await vi.advanceTimersByTimeAsync(60_000)
      const result = await pending

      expect(result.ok).toBe(false)
      const error = String(result.error)
      expect(error).toMatch(/Delete this item\?/)
      expect(error).toMatch(/whether the click was processed first is unknown/)
      expect(error).toMatch(/RE-READ/)
      expect(error, 'must not claim the input never went out').not.toMatch(/NOT sent/)
      expect(
        (result.data as { dialog?: { answer_with?: string } }).dialog?.answer_with,
        'the payload still carries the answer route',
      ).toMatch(/chrome_dialog/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses by name when a dialog is standing before the act', async () => {
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    const cdp = installCdpMock()
    vi.mocked(standingDialog).mockReturnValue(CONFIRM)

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(false)
    const error = String(result.error)
    expect(error).toMatch(/NOT sent/)
    expect(error).toMatch(/confirm dialog: "Delete this item\?"/)
    expect(error).toMatch(/chrome_dialog\(tab_id=1/)
    expect(error, 'the fallback must be named or the agent cannot plan').toMatch(
      /dismissed automatically/,
    )
    expect(methodsOf(cdp), 'nothing may be dispatched into a paused page').not.toContain(
      'Input.dispatchMouseEvent',
    )
  })

  it('reports a dialog the act itself raised as a success with the answer route', async () => {
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    installCdpMock()
    // Standing: not before the act (first call), standing after dispatch.
    vi.mocked(standingDialog).mockReturnValueOnce(null).mockReturnValue(CONFIRM)

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok, 'the input WAS delivered; failing it invites a double-submit').toBe(true)
    const data = result.data as {
      dialog?: { type?: string; message?: string; note?: string; answer_with?: string }
    }
    expect(data.dialog?.type).toBe('confirm')
    expect(data.dialog?.message).toBe('Delete this item?')
    expect(data.dialog?.note).toMatch(/do not repeat the click/i)
    expect(data.dialog?.answer_with).toMatch(/chrome_dialog\(tab_id=1/)
  })

  it('prefers the named dialog over the stall guess when the event lands late', async () => {
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    installCdpMock({ rendererHangsAfterDispatch: true })
    // Not standing at either early check; known by the time the liveness
    // probe has failed.
    vi.mocked(standingDialog)
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(null)
      .mockReturnValue(CONFIRM)

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(true)
    const data = result.data as { dialog?: { message?: string } }
    expect(data.dialog?.message, 'the guess would say "two things do that"').toBe(
      'Delete this item?',
    )
  })

  it('reports an auto-acknowledged alert as history on a normal success', async () => {
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    installCdpMock()
    vi.mocked(resolvedDialogSince).mockReturnValue({
      type: 'alert',
      message: 'Saved!',
      openedAt: Date.now(),
      resolvedAt: Date.now(),
      accepted: true,
      by: 'policy',
    })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(true)
    const data = result.data as {
      dialog?: { type?: string; message?: string; resolution?: string }
      settled?: unknown
    }
    expect(data.dialog?.type).toBe('alert')
    expect(data.dialog?.message).toBe('Saved!')
    expect(data.dialog?.resolution).toMatch(/auto-acknowledged/)
    expect(data.settled, 'an acked alert does not cost the verification payload').toBeDefined()
  })

  it('interrupts a wait when a dialog opens instead of burning the timeout', async () => {
    installCdpMock()
    vi.mocked(raceStandingDialog).mockResolvedValue({ kind: 'dialog', dialog: CONFIRM })

    const result = await execAct({
      tab_id: TAB,
      action: 'wait',
      wait_for: { text: 'Done' },
      timeout_ms: 5_000,
    })

    expect(result.ok).toBe(false)
    const error = String(result.error)
    expect(error).toMatch(/wait was interrupted/)
    expect(error).toMatch(/confirm dialog opened: "Delete this item\?"/)
    expect(error).toMatch(/chrome_dialog\(tab_id=1/)
  })
})

describe('wall-clock budget (#162)', () => {
  it('a type whose healthy dispatches outlive the budget fails in time with exact progress', async () => {
    // The measured class: two deadlined dispatches per character, each ack
    // comfortably inside its 8s deadline, the SUM past the wire budget. The
    // old outcome was the backend's bare "timed out after 30s" with NO
    // payload; this is the payload that replaces it.
    vi.useFakeTimers()
    try {
      setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
      const cdp = installCdpMock()
      const inner = cdp.getMockImplementation()!
      cdp.mockImplementation(async (target: unknown, method: string, params?: unknown) => {
        if (method === 'Input.dispatchKeyEvent') vi.setSystemTime(Date.now() + 1_000)
        return inner(target, method as never, params as never)
      })
      const ctx = { deadline: Date.now() + 4_500, budgetMs: 30_000 }

      const result = await execAct({ tab_id: TAB, action: 'type', ref: '@e1', value: 'abcdef' }, ctx)

      expect(result.ok).toBe(false)
      expect(String(result.error)).toMatch(/30s time budget ran out while typing/)
      expect(String(result.error)).toMatch(/3 of 6 characters/)
      expect(String(result.error), 'must warn off re-sending the whole value').toMatch(/PARTIAL/)
      const data = result.data as Record<string, unknown>
      expect(data.budget_exhausted).toBe(true)
      expect(data.delivered_count).toBe(3)
      expect(data.requested_count).toBe(6)
      expect(data.progress_unit).toBe('characters')
      expect(data.input, 'input DID go in; the payload must say so').toBe('trusted')
    } finally {
      vi.useRealTimers()
    }
  })

  it('budget exhausted before dispatch says NOTHING was delivered, and nothing was', async () => {
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    const cdp = installCdpMock()
    const ctx = { deadline: Date.now() - 1, budgetMs: 30_000 }

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' }, ctx)

    expect(result.ok).toBe(false)
    expect(String(result.error)).toMatch(/NOTHING was delivered/)
    const data = result.data as Record<string, unknown>
    expect(data.budget_exhausted).toBe(true)
    expect(data.input).toBe('none')
    // The claim must be true: no input event may have gone out.
    expect(inputEventTypes(cdp)).toEqual([])
  })

  it('budget spent AFTER delivery cheapens verification instead of failing the act', async () => {
    // The other half of the honesty rule: a delivered action is never failed
    // because its verification got cheaper. The renderer-bound enrichments
    // (focused, target_exists) are skipped; the local facts still report.
    vi.useFakeTimers()
    try {
      setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
      const cdp = installCdpMock()
      const inner = cdp.getMockImplementation()!
      cdp.mockImplementation(async (target: unknown, method: string, params?: unknown) => {
        if (
          method === 'Input.dispatchMouseEvent' &&
          (params as { type?: string })?.type === 'mouseReleased'
        ) {
          vi.setSystemTime(Date.now() + 60_000)
        }
        return inner(target, method as never, params as never)
      })
      const ctx = { deadline: Date.now() + 5_000, budgetMs: 30_000 }

      const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' }, ctx)

      expect(result.ok).toBe(true)
      const data = result.data as Record<string, unknown>
      expect(data.input).toBe('trusted')
      expect(data.input_delivered).toBe('yes')
      expect('focused' in data, 'renderer-bound enrichment is skipped past the deadline').toBe(false)
      expect('target_exists' in data).toBe(false)
      expect(data.settled).toBeDefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a fused wait clamps its window to the remaining budget and marks the clamp', async () => {
    // Outside a batch the backend sizes the act budget around the declared
    // wait, so the clamp is a no-op; inside one, the clock is shared and a
    // 10s ask against 1s of remaining budget gets the honest 1s. The advance
    // runs PAST the unclamped ask on purpose: were the clamp broken, the wait
    // would ride its full 10s and the waited_ms assertion fails loudly,
    // instead of the test hanging into a murky timeout.
    vi.useFakeTimers()
    try {
      setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
      installCdpMock({ bodyText: 'nothing relevant here' })
      const ctx = { deadline: Date.now() + 1_000, budgetMs: 30_000 }

      const pending = execAct(
        { tab_id: TAB, action: 'key', value: 'End', wait_for: { text: 'NeverShows' }, timeout_ms: 10_000 },
        ctx,
      )
      await vi.advanceTimersByTimeAsync(12_000)
      const result = await pending

      expect(result.ok).toBe(true)
      const data = result.data as Record<string, unknown>
      expect(data.found).toBe(false)
      expect(data.condition).toBe('text:NeverShows')
      expect(Number(data.waited_ms), 'the 10s ask must clamp to the ~1s remaining').toBeLessThan(2_000)
      expect(data.budget_clamped, 'a miss on a shortened window must say the window was short').toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a bare wait on a spent budget names the budget, never "wait timed out"', async () => {
    // The wait branch returns before the shared pre-dispatch checkpoint, so
    // it carries its own check. Without it, a spent clock produced a 0ms
    // window and "wait timed out on text:x": the page blamed for a wait that
    // never ran.
    installCdpMock()
    const ctx = { deadline: Date.now() - 1, budgetMs: 30_000 }

    const result = await execAct({ tab_id: TAB, action: 'wait', wait_for: { text: 'x' }, timeout_ms: 5_000 }, ctx)

    expect(result.ok).toBe(false)
    expect(String(result.error)).toMatch(/30s time budget/)
    expect(String(result.error)).not.toMatch(/wait timed out/)
    const data = result.data as Record<string, unknown>
    expect(data.budget_exhausted).toBe(true)
    expect(data.input).toBe('none')
  })

  it('a clamped bare wait that misses blames the clamp, with the marker', async () => {
    vi.useFakeTimers()
    try {
      installCdpMock({ bodyText: 'nothing relevant here' })
      const ctx = { deadline: Date.now() + 1_000, budgetMs: 30_000 }

      const pending = execAct({ tab_id: TAB, action: 'wait', wait_for: { text: 'NeverShows' }, timeout_ms: 10_000 }, ctx)
      await vi.advanceTimersByTimeAsync(12_000)
      const result = await pending

      expect(result.ok).toBe(false)
      expect(String(result.error)).toMatch(/clamped from 10000ms/)
      const data = result.data as Record<string, unknown>
      expect(data.budget_clamped).toBe(true)
      expect(Number(data.waited_ms)).toBeLessThan(2_000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('the widened settle clamps its in-page deadline to the remaining budget', async () => {
    // The settle probe runs IN the page for its whole window (one evaluate,
    // not a poll), so an unclamped 20s ask against ~1.5s of budget would
    // still be sitting in the page when the backend gave up. The in-page
    // deadline is where the clamp must land to matter (#168's pattern).
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    const cdp = installCdpMock({ settleValue: 'deadline' })
    const ctx = { deadline: Date.now() + 1_500, budgetMs: 30_000 }

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1', timeout_ms: 20_000 }, ctx)

    expect(result.ok).toBe(true)
    const data = result.data as Record<string, unknown>
    expect(data.budget_clamped, 'an unsettled clamped window must carry the marker').toBe(true)
    const settleProbes = cdp.mock.calls.filter(
      (c) => c[1] === 'Runtime.evaluate' && String((c[2] as { expression?: string }).expression).includes('MutationObserver'),
    )
    expect(settleProbes).toHaveLength(1)
    const expr = String((settleProbes[0][2] as { expression: string }).expression)
    const deadlineMs = Number(expr.match(/Date\.now\(\) \+ (\d+)/)?.[1])
    expect(deadlineMs, 'the 20s ask must shrink to the ~1.5s remaining').toBeLessThanOrEqual(1_500)
    expect(deadlineMs).toBeGreaterThan(0)
  })

  it('a budget dying on the preparatory hover says NO click was pressed, not "mid-action"', async () => {
    // The zero-delivered clicks branch: the prep mouseMoved ate the clock, so
    // the check before the FIRST press throws with delivered 0. "Mid-click"
    // or "see what state that left the control in" would both be claims about
    // input that never happened.
    vi.useFakeTimers()
    try {
      setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
      const cdp = installCdpMock()
      const inner = cdp.getMockImplementation()!
      cdp.mockImplementation(async (target: unknown, method: string, params?: unknown) => {
        if (
          method === 'Input.dispatchMouseEvent' &&
          (params as { type?: string })?.type === 'mouseMoved'
        ) {
          vi.setSystemTime(Date.now() + 60_000)
        }
        return inner(target, method as never, params as never)
      })
      const ctx = { deadline: Date.now() + 5_000, budgetMs: 30_000 }

      const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' }, ctx)

      expect(result.ok).toBe(false)
      expect(String(result.error)).toMatch(/before the click's click was pressed/)
      expect(String(result.error)).not.toMatch(/mid-/)
      const data = result.data as Record<string, unknown>
      expect(data.delivered_count).toBe(0)
      expect(data.input).toBe('none')
      // No press may have gone out; the prep move alone presses nothing.
      const mouseTypes = cdp.mock.calls
        .filter((c) => c[1] === 'Input.dispatchMouseEvent')
        .map((c) => (c[2] as { type: string }).type)
      expect(mouseTypes).toEqual(['mouseMoved'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('a drag that cannot afford its press is refused with nothing sent', async () => {
    // The drag arm re-checks the clock AFTER destination resolution, because
    // that resolution can eat what the shared pre-dispatch checkpoint saw as
    // remaining, and once the press goes out the drag MUST complete (a held
    // button is worse than a refusal). Refusing here is the last moment
    // "NOTHING was delivered" is still true.
    vi.useFakeTimers()
    try {
      setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
      const cdp = installCdpMock()
      const inner = cdp.getMockImplementation()!
      cdp.mockImplementation(async (target: unknown, method: string, params?: unknown) => {
        // Destination geometry (getBoundingClientRect) burns the whole clock.
        if (
          method === 'Runtime.callFunctionOn' &&
          String((params as { functionDeclaration?: string })?.functionDeclaration).includes('getBoundingClientRect')
        ) {
          vi.setSystemTime(Date.now() + 6_000)
        }
        return inner(target, method as never, params as never)
      })
      const ctx = { deadline: Date.now() + 5_000, budgetMs: 30_000 }

      const result = await execAct({ tab_id: TAB, action: 'drag', coordinate: [10, 10], to_ref: '@e1' }, ctx)

      expect(result.ok).toBe(false)
      expect(String(result.error)).toMatch(/NOTHING was delivered/)
      const data = result.data as Record<string, unknown>
      expect(data.budget_exhausted).toBe(true)
      expect(data.input).toBe('none')
      // The claim must be true: no mouse event may have gone out.
      expect(inputEventTypes(cdp)).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('a degraded drag says so: the glide was dropped and the payload marks it', async () => {
    // Zero-glide drags can register as plain clicks on delta-tracking pages,
    // so ok:true alone would be an unverified claim.
    vi.useFakeTimers()
    try {
      setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
      const cdp = installCdpMock()
      const inner = cdp.getMockImplementation()!
      cdp.mockImplementation(async (target: unknown, method: string, params?: unknown) => {
        // The press lands, then the clock dies: glide unaffordable.
        if (
          method === 'Input.dispatchMouseEvent' &&
          (params as { type?: string })?.type === 'mousePressed'
        ) {
          vi.setSystemTime(Date.now() + 60_000)
        }
        return inner(target, method as never, params as never)
      })
      const ctx = { deadline: Date.now() + 5_000, budgetMs: 30_000 }

      const result = await execAct({ tab_id: TAB, action: 'drag', coordinate: [10, 10], to_ref: '@e1' }, ctx)

      expect(result.ok).toBe(true)
      const data = result.data as Record<string, unknown>
      expect(data.drag_degraded).toBe(true)
      expect(data.drag_moves_sent).toBe(0)
      // The button was still released: press and release both went out.
      const mouseTypes = cdp.mock.calls
        .filter((c) => c[1] === 'Input.dispatchMouseEvent')
        .map((c) => (c[2] as { type: string }).type)
      expect(mouseTypes).toContain('mousePressed')
      expect(mouseTypes).toContain('mouseReleased')
    } finally {
      vi.useRealTimers()
    }
  })

  it('no context means no budget: the act behaves exactly as before', async () => {
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    installCdpMock()

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(true)
    const data = result.data as Record<string, unknown>
    expect('budget_exhausted' in data).toBe(false)
    expect(data.focused, 'no deadline, no enrichment skip').toBeDefined()
  })
})

/**
 * #160: every trust probe runs in the isolated probe world, where the page
 * cannot override the primitives that answer it. The mock layer already
 * THROWS on any world-less trust call (see installCdpMock), so a main-world
 * regression fails half this file; these tests pin the positive shape, the
 * fail-closed rule, and the rebuild-once staleness recovery explicitly.
 */
describe('isolated probe world (#160)', () => {
  it('mints the element handle in the probe world and pays one world per act', async () => {
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    const cdp = installCdpMock()

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(true)
    const worldCalls = cdp.mock.calls.filter(
      (c) =>
        c[1] === 'Page.createIsolatedWorld' &&
        (c[2] as { worldName?: string }).worldName === 'nymeria_probe',
    )
    expect(worldCalls).toHaveLength(1)
    const resolve = cdp.mock.calls.find((c) => c[1] === 'DOM.resolveNode')
    expect((resolve?.[2] as { executionContextId?: number }).executionContextId).toBe(88)
  })

  it('describes a bare coordinate in the probe world', async () => {
    const cdp = installCdpMock({ pointDescription: 'button "Pay"' })

    const result = await execAct({ tab_id: TAB, action: 'click', coordinate: [10, 20] })

    expect(result.ok).toBe(true)
    const describe = cdp.mock.calls.find(
      (c) =>
        c[1] === 'Runtime.evaluate' &&
        String((c[2] as { expression?: string }).expression).includes('elementFromPoint'),
    )
    expect((describe?.[2] as { contextId?: number }).contextId).toBe(88)
  })

  it('reads the scroll dispatch centre in the probe world', async () => {
    const cdp = installCdpMock()

    const result = await execAct({ tab_id: TAB, action: 'scroll', direction: 'down' })

    expect(result.ok).toBe(true)
    const centre = cdp.mock.calls.find(
      (c) =>
        c[1] === 'Runtime.evaluate' &&
        String((c[2] as { expression?: string }).expression).includes('innerWidth'),
    )
    expect((centre?.[2] as { contextId?: number }).contextId).toBe(88)
  })

  it('judges a fused text wait condition in the probe world', async () => {
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    const cdp = installCdpMock({ bodyText: 'Welcome back' })

    const result = await execAct({
      tab_id: TAB,
      action: 'click',
      ref: '@e1',
      wait_for: { text: 'Welcome' },
      timeout_ms: 300,
    })

    expect(result.ok).toBe(true)
    expect((result.data as { found?: boolean }).found).toBe(true)
    const textProbe = cdp.mock.calls.find(
      (c) =>
        c[1] === 'Runtime.evaluate' &&
        String((c[2] as { expression?: string }).expression).includes('innerText.includes'),
    )
    expect((textProbe?.[2] as { contextId?: number }).contextId).toBe(88)
  })

  it('rebuilds a dead probe world once and completes the resolution', async () => {
    installCdpMock()
    const send = chrome.debugger.sendCommand as unknown as ReturnType<typeof vi.fn>
    const original = send.getMockImplementation() as (...a: unknown[]) => Promise<unknown>
    let evals = 0
    send.mockImplementation(async (...args: unknown[]) => {
      const method = args[1] as string
      const params = args[2] as { expression?: string } | undefined
      if (method === 'Runtime.evaluate' && params?.expression?.includes('querySelector')) {
        evals += 1
        // The cached world died with its document: the first in-world call
        // fails with the context-gone shape, the rebuilt world answers.
        if (evals === 1) throw new Error('Cannot find context with specified id')
        return { result: { objectId: 'css-obj' } }
      }
      return original(...args)
    })

    const resolution = await __test.resolveTarget(TAB, 'css=.btn', TAB_URL)

    expect(resolution.ok).toBe(true)
    const worldCalls = (send.mock.calls as unknown[][]).filter(
      (c) =>
        c[1] === 'Page.createIsolatedWorld' &&
        (c[2] as { worldName?: string }).worldName === 'nymeria_probe',
    )
    expect(worldCalls, 'create, then one rebuild').toHaveLength(2)
  })

  it('fails CLOSED when no probe world can be had: no main-world fallback', async () => {
    const cdp = installCdpMock({ probeWorld: false })

    const resolution = await __test.resolveTarget(TAB, 'css=.btn', TAB_URL)

    expect(resolution.ok).toBe(false)
    if (!resolution.ok) expect(resolution.error).toMatch(/isolated inspection context/)
    // The teeth: a fallback would issue a context-less querySelector evaluate.
    const mainWorldQueries = cdp.mock.calls.filter(
      (c) =>
        c[1] === 'Runtime.evaluate' &&
        String((c[2] as { expression?: string }).expression).includes('querySelector') &&
        (c[2] as { contextId?: number }).contextId === undefined,
    )
    expect(mainWorldQueries).toHaveLength(0)
  })

  it('a ref act with no obtainable world refuses as INFRASTRUCTURE, not as a stale ref', async () => {
    // The split matters (review round): "no world" says nothing about the
    // element, so a stale_refs flag here would send the agent into a
    // pointless re-read loop when the honest advice is retry / fresh tab.
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    const cdp = installCdpMock({ probeWorld: false })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/isolated inspection context/)
    expect((result.data as Record<string, unknown> | undefined)?.stale_refs).toBeUndefined()
    expect(inputEventTypes(cdp)).toHaveLength(0)
  })

  it('resolves an xpath= target through the probe world', async () => {
    // The mock throws on any world-less document.evaluate(, so this passing
    // IS the proof the xpath branch inherited the world (review gap: css was
    // covered, xpath only ever asserted its no-match error string).
    const cdp = installCdpMock()

    const result = await execAct({ tab_id: TAB, action: 'click', ref: 'xpath=//button[1]' })

    expect(result.ok).toBe(true)
    const xpathEval = cdp.mock.calls.find(
      (c) =>
        c[1] === 'Runtime.evaluate' &&
        String((c[2] as { expression?: string }).expression).includes('document.evaluate('),
    )
    expect((xpathEval?.[2] as { contextId?: number }).contextId).toBe(88)
  })
})

/**
 * The mint-fingerprint re-check (#160 review round): a ref can stay LIVE
 * while its meaning changes (a framework re-render reusing the node, a
 * "Confirm" relabeled "Delete"), which isConnected can never see. The
 * mint-time AX role+name is re-read through the same browser computation
 * that minted it, and a mismatch refuses BEFORE any input goes out.
 */
describe('ref fingerprints', () => {
  const mintedRef = (name: string, role = 'button') =>
    new Map([['e1', { backendNodeId: 100, role, name }]])

  it('refuses a click on an element whose name changed since the read', async () => {
    setRefs(TAB, mintedRef('Confirm'), TAB_URL)
    const cdp = installCdpMock({ axName: 'Delete' })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/was button "Confirm", it is now button "Delete"/)
    expect(result.error).toMatch(/NOT sent/)
    const data = result.data as Record<string, unknown>
    expect(data.stale_refs).toBe(true)
    expect(data.reason).toBe('changed')
    // The teeth: nothing was dispatched.
    expect(inputEventTypes(cdp)).toHaveLength(0)
  })

  it('refuses on a role change too', async () => {
    setRefs(TAB, mintedRef('Pay', 'button'), TAB_URL)
    const cdp = installCdpMock({ axRole: 'link', axName: 'Pay' })

    const result = await execAct({ tab_id: TAB, action: 'type', ref: '@e1', value: 'x' })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/changed since you read the page/)
    expect(inputEventTypes(cdp)).toHaveLength(0)
    expect(cdp.mock.calls.some((c) => c[1] === 'Input.dispatchKeyEvent')).toBe(false)
  })

  it('an empty mint name compares role only: label drift elsewhere does not bounce', async () => {
    setRefs(TAB, mintedRef('', 'button'), TAB_URL)
    const cdp = installCdpMock({ axRole: 'button', axName: 'anything at all' })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(true)
    // The check RAN (one AX read) and the role matched; with the feature
    // deleted this call disappears, so ok alone is not the payoff.
    expect(cdp.mock.calls.filter((c) => c[1] === 'Accessibility.getPartialAXTree')).toHaveLength(1)
  })

  it('a node that left the AX tree refuses with the distinct hidden copy', async () => {
    setRefs(TAB, mintedRef('Confirm'), TAB_URL)
    const cdp = installCdpMock({ axIgnored: true })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/no longer visible to the accessibility tree/)
    expect((result.data as Record<string, unknown>).reason).toBe('hidden')
    expect(inputEventTypes(cdp)).toHaveLength(0)
  })

  it('upload skips the fingerprint check: AX-hidden inputs are its everyday target', async () => {
    setRefs(TAB, mintedRef('resume upload', 'button'), TAB_URL)
    const cdp = installCdpMock({ axIgnored: true })

    const result = await execAct({
      tab_id: TAB,
      action: 'upload',
      ref: '@e1',
      file_name: 'cv.pdf',
      file_base64: 'aGVsbG8=',
    })

    expect(result.ok).toBe(true)
    expect(cdp.mock.calls.some((c) => c[1] === 'Accessibility.getPartialAXTree')).toBe(false)
  })

  it('an unchanged element pays exactly one AX read and proceeds', async () => {
    setRefs(TAB, mintedRef('Pay'), TAB_URL)
    const cdp = installCdpMock({ axRole: 'button', axName: 'Pay' })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(true)
    const axCalls = cdp.mock.calls.filter((c) => c[1] === 'Accessibility.getPartialAXTree')
    expect(axCalls).toHaveLength(1)
  })

  it('a ref minted with an EMPTY fingerprint is not checked at all', async () => {
    // Role and name are required fields, but both empty (a node the AX tree
    // gave nothing for) means there is nothing to compare: the act must not
    // spend an AX round trip, and must not bounce on the mock's hostile
    // axIgnored default either.
    setRefs(TAB, new Map([['e1', fpRef(100, { role: '', name: '' })]]), TAB_URL)
    const cdp = installCdpMock({ axIgnored: true })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(true)
    expect(cdp.mock.calls.some((c) => c[1] === 'Accessibility.getPartialAXTree')).toBe(false)
  })

  it('an AX read that fails leaves the act alone: fail-open on error, closed on mismatch', async () => {
    setRefs(TAB, mintedRef('Pay'), TAB_URL)
    installCdpMock()
    const send = chrome.debugger.sendCommand as unknown as ReturnType<typeof vi.fn>
    const original = send.getMockImplementation() as (...a: unknown[]) => Promise<unknown>
    send.mockImplementation(async (...args: unknown[]) => {
      if (args[1] === 'Accessibility.getPartialAXTree') throw new Error('No AX node for id')
      return original(...args)
    })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(true)
  })

  it('a session-layer failure in the AX read RETHROWS: the tab story outranks fail-open', async () => {
    // Fail-open is for probe errors. CdpCallTimeout means the TAB is wedged,
    // and swallowing it would dispatch input into a tab whose state is
    // unknowable, with the class's honest copy discarded.
    setRefs(TAB, mintedRef('Pay'), TAB_URL)
    const cdp = installCdpMock()
    const send = chrome.debugger.sendCommand as unknown as ReturnType<typeof vi.fn>
    const original = send.getMockImplementation() as (...a: unknown[]) => Promise<unknown>
    send.mockImplementation(async (...args: unknown[]) => {
      if (args[1] === 'Accessibility.getPartialAXTree') {
        throw new CdpCallTimeout('Accessibility.getPartialAXTree', 15_000)
      }
      return original(...args)
    })

    await expect(execAct({ tab_id: TAB, action: 'click', ref: '@e1' })).rejects.toThrow(
      /did not answer/,
    )
    expect(inputEventTypes(cdp)).toHaveLength(0)
  })

  it('a purely numeric tick in the name does NOT refuse: counters are the same element', async () => {
    setRefs(TAB, mintedRef('Cart (3)'), TAB_URL)
    const cdp = installCdpMock({ axName: 'Cart (4)' })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(true)
    // The gate ran (one AX read) and passed; it was not skipped.
    expect(cdp.mock.calls.filter((c) => c[1] === 'Accessibility.getPartialAXTree')).toHaveLength(1)
  })

  it('a text change around unchanged digits still refuses', async () => {
    setRefs(TAB, mintedRef('Cart (3)'), TAB_URL)
    const cdp = installCdpMock({ axName: 'Delete (3)' })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/changed since you read the page/)
    expect(inputEventTypes(cdp)).toHaveLength(0)
  })

  it("a drag destination's drift refuses the drag before the press", async () => {
    setRefs(
      TAB,
      new Map([
        ['e1', { backendNodeId: 100, role: 'listitem', name: 'Draft report' }],
        ['e2', { backendNodeId: 200, role: 'button', name: 'Archive' }],
      ]),
      TAB_URL,
    )
    installCdpMock()
    const send = chrome.debugger.sendCommand as unknown as ReturnType<typeof vi.fn>
    const original = send.getMockImplementation() as (...a: unknown[]) => Promise<unknown>
    send.mockImplementation(async (...args: unknown[]) => {
      const params = args[2] as { backendNodeId?: number } | undefined
      if (args[1] === 'Accessibility.getPartialAXTree') {
        // The SOURCE still matches its mint; only the DESTINATION drifted.
        const unchanged = params?.backendNodeId === 100
        return {
          nodes: [
            {
              backendDOMNodeId: params?.backendNodeId,
              ignored: false,
              role: { value: unchanged ? 'listitem' : 'button' },
              name: { value: unchanged ? 'Draft report' : 'Delete forever' },
            },
          ],
        }
      }
      return original(...args)
    })

    const result = await execAct({ tab_id: TAB, action: 'drag', ref: '@e1', to_ref: '@e2' })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/drag destination/)
    expect(result.error).toMatch(/was button "Archive", it is now button "Delete forever"/)
    const mouseCalls = (send.mock.calls as unknown[][]).filter(
      (c) => c[1] === 'Input.dispatchMouseEvent',
    )
    expect(mouseCalls).toHaveLength(0)
  })
})

/**
 * failed_requests classification and ranking (#166): the QA round measured a
 * successful upload whose payload carried five failed third-party telemetry
 * beacons in the exact field where a broken first-party POST would show. The
 * cap is filled by rank (data-class before telemetry-shaped, same-origin
 * before cross within the class), and every entry says which side of the
 * origin line it is on.
 */
describe('failed_requests classification', () => {
  const future = () => Date.now() + 5_000

  it('annotates same_origin and keeps the first-party POST ahead of telemetry noise', async () => {
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    installCdpMock()
    // The one that matters FIRST, so recency alone would evict it: the
    // page's own API rejecting...
    pushNetwork(TAB, {
      url: 'https://example.com/api/submit',
      method: 'POST',
      status: 500,
      resource_type: 'XHR',
      ts: future(),
    })
    // ...then five NEWER third-party beacon failures, the QA-measured
    // drowning shape. A plain last-5-by-recency cap would report only these.
    for (let i = 0; i < 5; i += 1) {
      pushNetwork(TAB, {
        url: `https://telemetry${i}.example.net/collect`,
        method: 'POST',
        error: 'net::ERR_NAME_NOT_RESOLVED',
        resource_type: 'Ping',
        ts: future() + 100 + i,
      })
    }

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(true)
    const failed = (result.data as { failed_requests?: Record<string, unknown>[] }).failed_requests
    expect(failed).toBeDefined()
    expect(failed).toHaveLength(5)
    const firstParty = failed?.find((e) => e.url === 'https://example.com/api/submit')
    expect(firstParty, 'the broken first-party POST survives the cap').toBeDefined()
    expect(firstParty?.same_origin).toBe(true)
    const beacons = failed?.filter((e) => String(e.url).includes('telemetry')) ?? []
    for (const b of beacons) expect(b.same_origin).toBe(false)
  })

  it('a third-party fetch failure outranks a same-origin tracker pixel', async () => {
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    installCdpMock()
    // The cross-origin API fetch failure FIRST (a first-party api.* domain
    // is cross-ORIGIN and still data-class: type outranks origin)...
    pushNetwork(TAB, {
      url: 'https://api.example.net/v1/checkout',
      method: 'POST',
      status: 502,
      resource_type: 'Fetch',
      ts: future(),
    })
    // ...then six NEWER same-origin tracker pixels, so recency alone would
    // evict the API failure.
    for (let i = 0; i < 6; i += 1) {
      pushNetwork(TAB, {
        url: `https://example.com/pixels/${i}.gif`,
        method: 'GET',
        status: 404,
        resource_type: 'Image',
        ts: future() + 100 + i,
      })
    }

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    const failed = (result.data as { failed_requests?: Record<string, unknown>[] }).failed_requests
    // The cap held: ranking reorders WITHIN five entries, it does not widen
    // the report (a removed cap would pass the survives-assert trivially).
    expect(failed).toHaveLength(5)
    const api = failed?.find((e) => String(e.url).includes('api.example.net'))
    expect(api, 'the data-class failure survives six pixels').toBeDefined()
    expect(api?.same_origin).toBe(false)
  })

  it('judges same_origin against the page the action ran ON, not the page it landed on', async () => {
    // A submit that both fails its POST and navigates: the failures in the
    // window were issued by the urlBefore document, so a POST back to that
    // origin is first-party even though the tab now reads a different origin.
    installCdpMock()
    pushNetwork(TAB, {
      url: 'https://checkout.example.org/api/pay',
      method: 'POST',
      status: 500,
      resource_type: 'XHR',
      ts: future(),
    })
    const get = chrome.tabs.get as unknown as ReturnType<typeof vi.fn>
    get.mockImplementation(async () => ({ id: TAB, url: 'https://example.com/error' }))

    const verification = await __test.buildVerification({
      tabId: TAB,
      action: 'click',
      target: '@e1',
      startedAt: Date.now() - 1_000,
      urlBefore: 'https://checkout.example.org/basket',
      navSeqBefore: 0,
      objectId: null,
      elementSession: TAB,
      inputMode: 'trusted',
      settleResult: null,
      budgetDeadline: null,
    })

    const failed = verification.failed_requests as Record<string, unknown>[]
    expect(failed).toHaveLength(1)
    expect(failed[0].same_origin, 'judged against urlBefore').toBe(true)
  })

  it('an unparseable request URL is reported without a same_origin claim', async () => {
    setRefs(TAB, new Map([['e1', fpRef(100)]]), TAB_URL)
    installCdpMock()
    pushNetwork(TAB, {
      url: 'not a url at all',
      method: 'GET',
      error: 'net::ERR_FAILED',
      resource_type: 'XHR',
      ts: future(),
    })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    const failed = (result.data as { failed_requests?: Record<string, unknown>[] }).failed_requests
    expect(failed).toHaveLength(1)
    expect(failed?.[0].url).toBe('not a url at all')
    expect('same_origin' in (failed?.[0] ?? {})).toBe(false)
  })
})
