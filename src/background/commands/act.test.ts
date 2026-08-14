import { beforeEach, describe, expect, it, vi } from 'vitest'
import { execAct, __test } from './act'
import { CdpCallTimeout, resetForTests as resetDebugger } from '../debuggerSession'
import { push as pushConsole, resetForTests as resetConsole } from '../consoleBuffer'
import { resetForTests as resetDelivery } from '../delivery'
import {
  chooserInterceptedSince,
  raceStandingDialog,
  resolvedDialogSince,
  standingDialog,
  type StandingDialog as StandingDialogT,
} from '../dialogs'
import { resetForTests as resetRefs, set as setRefs } from '../snapshotRefs'

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

interface MockOptions {
  /** null means the element has no layout box (hidden / zero-size). */
  geometry?: { x: number; y: number; w: number; h: number } | null
  hit?: { hit: boolean; blocker?: string }
  value?: string | null
  resolveNode?: boolean
  settleValue?: string
  bodyText?: string
  selectMatches?: boolean
  /** false models a tab where the probe's isolated world cannot be created. */
  deliveryWorld?: boolean
  /** How many events the page saw. 0 is the suppressed-tab case. */
  deliveryCount?: number
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
  /** 'timeout' models the session layer failing the connectedness probe. */
  connectedThrows?: 'timeout'
  /** true models the page asking for the OS file chooser during the action. */
  fileChooserOpened?: boolean
  /** What `elementFromPoint` finds under a bare coordinate. */
  pointDescription?: string
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
    deliveryCount = 1,
    deliveryReadThrows,
    rendererHangs,
    rendererHangsAfterDispatch,
    inputAckHangsFrom,
    isFileInput = false,
    targetConnected = true,
    connectedThrows,
    fileChooserOpened = false,
    pointDescription = 'body',
    pageHasFrames = false,
    targetInTopDocument = true,
  } = opts
  const PROBE_CONTEXT = 77
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
      return resolveNode ? { object: { objectId: 'obj-1' } } : { object: {} }
    }
    if (method === 'Runtime.callFunctionOn') {
      const fn = String(params.functionDeclaration ?? '')
      if (fn.includes('getBoundingClientRect')) {
        return { result: { value: geometry } }
      }
      if (fn.includes('const isFile =')) return { result: { value: isFileInput } }
      if (fn.includes('elementFromPoint')) return { result: { value: hit } }
      if (fn.includes('isConnected')) {
        if (connectedThrows === 'timeout') throw new CdpCallTimeout('Runtime.callFunctionOn', 15_000)
        return { result: { value: targetConnected } }
      }
      if (fn.includes('ownerDocument')) return { result: { value: targetInTopDocument } }
      if (fn.includes('this.options')) return { result: { value: selectMatches } }
      if (fn.includes('this.checked') && fn.includes('return')) return { result: { value: value } }
      if (fn.includes('this.value !== undefined')) return { result: { value } }
      return { result: { value: undefined } }
    }
    if (method === 'Page.getFrameTree') {
      return deliveryWorld ? { frameTree: { frame: { id: 'frame-1' } } } : {}
    }
    if (method === 'Page.createIsolatedWorld') {
      return { executionContextId: PROBE_CONTEXT }
    }
    if (method === 'Runtime.evaluate') {
      const expression = String(params.expression ?? '')
      // The delivery probe, addressed to its own isolated world. Answered by
      // count rather than by running the page-side code: that logic has its own
      // executed-for-real tests in delivery.test.ts, and here we only care what
      // an action DOES with each outcome.
      if (params.contextId === PROBE_CONTEXT) {
        if (expression.includes('addEventListener')) return { result: { value: true } }
        if (expression.includes('querySelectorAll')) {
          return { result: { value: !pageHasFrames } }
        }
        if (deliveryReadThrows) throw new Error(deliveryReadThrows)
        return { result: { value: { n: deliveryCount, f: fileChooserOpened } } }
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
        const needle = expression.slice(expression.indexOf('includes(') + 9, expression.lastIndexOf(')'))
        return { result: { value: bodyText.includes(JSON.parse(needle)) } }
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
  resetDelivery()
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
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
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
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
    const cdp = installCdpMock()

    await execAct({ tab_id: TAB, action: 'double_click', ref: '@e1' })

    const presses = cdp.mock.calls
      .filter((c) => c[1] === 'Input.dispatchMouseEvent' && (c[2] as { type: string }).type === 'mousePressed')
      .map((c) => (c[2] as { clickCount: number }).clickCount)
    expect(presses).toEqual([1, 2])
  })

  it('falls back to synthetic dispatch when the element has no layout box, and says so', async () => {
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
    const cdp = installCdpMock({ geometry: null })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(true)
    const data = result.data as { input: string; synthetic_reason?: string }
    expect(data.input).toBe('synthetic')
    expect(data.synthetic_reason).toMatch(/no layout box/)
    expect(inputEventTypes(cdp)).toHaveLength(0)
  })

  it('refuses the click when another element covers the point, and names it', async () => {
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
    const cdp = installCdpMock({ hit: { hit: false, blocker: 'div#cookie-banner' } })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/covered by div#cookie-banner/)
    expect((result.data as { intercepted_by: string }).intercepted_by).toBe('div#cookie-banner')
    // Nothing was clicked: refusing beats clicking the overlay.
    expect(inputEventTypes(cdp)).toHaveLength(0)
  })

  it('fills by inserting text into the focused element and reports the previous value', async () => {
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
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
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), 'https://example.com/checkout')
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
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
    installCdpMock()

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e99' })

    expect(result.ok).toBe(false)
    expect((result.data as { reason: string }).reason).toBe('unknown-ref')
  })

  it('reports a ref that resolves to nothing as stale rather than acting', async () => {
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
    const cdp = installCdpMock({ resolveNode: false })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/no longer exists/)
    expect(inputEventTypes(cdp)).toHaveLength(0)
  })
})

describe('verification payload', () => {
  it('surfaces console errors raised since the action started', async () => {
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
    installCdpMock()
    // An error from before the action must not be attributed to it.
    pushConsole(TAB, { level: 'error', text: 'stale earlier error', ts: Date.now() - 60_000 })

    const pending = execAct({ tab_id: TAB, action: 'click', ref: '@e1' })
    pushConsole(TAB, { level: 'error', text: 'POST /cart 500', ts: Date.now() + 5 })
    const result = await pending

    const errors = (result.data as { console_errors?: { text: string }[] }).console_errors ?? []
    expect(errors.map((e) => e.text)).toEqual(['POST /cart 500'])
  })

  it('reports a URL change caused by the action', async () => {
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
    const cdp = installCdpMock()
    // Semantic, not positional: the URL flips once input has been dispatched,
    // which is what "changed because of the action" means. A positional
    // once-mock here breaks every time an unrelated `tabs.get` joins the flow
    // (the attach pre-flight did exactly that).
    const get = chrome.tabs.get as unknown as ReturnType<typeof vi.fn>
    get.mockImplementation(async () => ({
      id: TAB,
      url: inputEventTypes(cdp).length > 0 ? 'https://example.com/thanks' : TAB_URL,
    }))

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    const data = result.data as { url_changed: boolean; url: string }
    expect(data.url_changed).toBe(true)
    expect(data.url).toBe('https://example.com/thanks')
  })

  it('waits for the page to settle and reports the outcome', async () => {
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
    installCdpMock({ settleValue: 'quiet' })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    const settled = (result.data as { settled: { settled: boolean; reason: string } }).settled
    expect(settled.settled).toBe(true)
    expect(settled.reason).toBe('quiet')
  })

  it('reports a deadline settle without failing the action', async () => {
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
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
})

describe('argument handling', () => {
  it('rejects an unknown target format', async () => {
    installCdpMock()
    const result = await execAct({ tab_id: TAB, action: 'click', ref: 'plain-string' })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/must start with @, css=, or xpath=/)
  })

  it('requires a value for fill', async () => {
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
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
    ;(chrome.debugger.sendCommand as unknown) = vi.fn(async () => ({ result: { subtype: 'null' } }))
    const resolution = await __test.resolveTarget(TAB, 'css=#missing', TAB_URL)
    expect(resolution.ok).toBe(false)
    if (!resolution.ok) expect(resolution.error).toMatch(/matched no element/)
  })

  it('selects by visible label, not just by option value', async () => {
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
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
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
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
    setRefs(TAB, new Map([['e1', { backendNodeId: 77 }]]), TAB_URL)

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
    setRefs(TAB, new Map([['e1', { backendNodeId: 77 }]]), TAB_URL)

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
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
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
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
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
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
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
      setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
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
      setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
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
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
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
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
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
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
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
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
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
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
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
      setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
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
      setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
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
      setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
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
      setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
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
      setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
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
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
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
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
    installCdpMock({ deliveryCount: 0 })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    const data = result.data as { input: string; input_delivered: string }
    expect(data.input).toBe('trusted')
    expect(data.input_delivered).toBe('no')
  })

  it('succeeds and records delivery when the event arrived', async () => {
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
    installCdpMock({ deliveryCount: 1 })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(true)
    expect((result.data as { input_delivered: string }).input_delivered).toBe('yes')
  })

  it('does not fail the command when delivery could not be proven either way', async () => {
    // Unprovable is not the same as failed. Turning "we could not check" into
    // an error would make the tool unusable wherever the probe cannot run.
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
    installCdpMock({ deliveryWorld: false })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(true)
    expect((result.data as { input_delivered: string }).input_delivered).toBe('unknown')
  })

  it('treats an action that navigated the page as delivered', async () => {
    // The probe died with its document, so the count is unreadable, but a
    // navigation is proof the input landed.
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
    installCdpMock({ deliveryReadThrows: 'Cannot find context with specified id' })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(true)
    expect((result.data as { input_delivered: string }).input_delivered).toBe('yes')
  })

  it('checks delivery for every verb that goes in through browser-level input', async () => {
    for (const action of ['click', 'double_click', 'right_click', 'key', 'type']) {
      resetRefs()
      resetDelivery()
      setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
      installCdpMock({ deliveryCount: 0 })

      const result = await execAct({ tab_id: TAB, action, ref: '@e1', value: 'a' })

      expect(result.ok, `${action} must report an undelivered event as a failure`).toBe(false)
      expect(result.error, `${action} error text`).toMatch(/received no event/)
    }
  })

  it('does not probe the verbs that never touch the browser input gate', async () => {
    // `fill` is Input.insertText, an IME commit on a path the gate does not
    // consult: it kept working live while every other verb was suppressed.
    // `select` and `check` run in-page, and `check` already verifies itself.
    for (const [action, extra] of [
      ['fill', { value: 'x' }],
      ['select', { value: 'Option 2' }],
      ['check', {}],
    ] as const) {
      resetRefs()
      resetDelivery()
      setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
      const cdp = installCdpMock({ deliveryCount: 0, value: 'false' })

      const result = await execAct({ tab_id: TAB, action, ref: '@e1', ...extra })

      expect(result.ok, `${action} must not be failed by the delivery probe`).toBe(true)
      expect((result.data as Record<string, unknown>).input_delivered).toBeUndefined()
      expect(
        methodsOf(cdp),
        `${action} must not pay for a probe it does not need`,
      ).not.toContain('Page.createIsolatedWorld')
    }
  })

  it('arms the probe after target resolution so setup cannot be counted as delivery', async () => {
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
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
   * The probe watches one document, the top one, but this tool deliberately
   * acts inside iframes: cross-origin frames are where payment fields and
   * consent dialogs live, and the whole `elementSession` / `frameOffset`
   * machinery exists for them. Events dispatched inside a frame never reach the
   * top window, so a zero count there means "not seen here", not "not
   * delivered". Failing on it would tell the agent to abandon a working tab and
   * retry in a fresh one, where the identical failure repeats.
   */

  it('does not fail a click whose target lives inside an iframe', async () => {
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
    installCdpMock({ deliveryCount: 0, pageHasFrames: true, targetInTopDocument: false })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok, 'an unwatched frame is not evidence of suppression').toBe(true)
    expect((result.data as { input_delivered: string }).input_delivered).toBe('unknown')
  })

  it('still fails when the target is in the top document the probe watched', async () => {
    // Frames exist, but this target is not in one, so a zero count is real.
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
    installCdpMock({ deliveryCount: 0, pageHasFrames: true, targetInTopDocument: true })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/received no event/)
  })

  it('trusts a zero count outright when the document has no frames at all', async () => {
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
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
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
    installCdpMock({ geometry: null, deliveryCount: 0 })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(true)
    expect((result.data as { input: string }).input).toBe('synthetic')
    expect((result.data as Record<string, unknown>).input_delivered).toBeUndefined()
  })

  it('does not fail a type of the empty string, which dispatches nothing', async () => {
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
    installCdpMock({ deliveryCount: 0 })

    const result = await execAct({ tab_id: TAB, action: 'type', ref: '@e1', value: '' })

    expect(result.ok).toBe(true)
    expect((result.data as Record<string, unknown>).input_delivered).toBeUndefined()
  })

  it('still checks a click that did go in as trusted input', async () => {
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
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
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
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
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
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
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
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
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
    installCdpMock({ connectedThrows: 'timeout' })

    await expect(execAct({ tab_id: TAB, action: 'click', ref: '@e1' })).rejects.toThrow(
      /did not answer/i,
    )
  })

  it('gives a detached drag DESTINATION the same honest error as a detached source', async () => {
    // A detached node has a zero rect, so geometry returns null and the drag
    // used to fail with "needs a resolvable to_ref destination", which is
    // false (it resolved fine) and never tells the agent to re-read.
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
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
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
    installCdpMock()

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(true)
    expect((result.data as { hit?: string }).hit).toBeUndefined()
    expect((result.data as { target?: string }).target).toBe('@e1')
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
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
    const cdp = installCdpMock()

    await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    const methods = methodsOf(cdp)
    expect(methods).toContain('Page.enable')
    expect(methods).toContain('Page.setInterceptFileChooserDialog')
  })

  it('fails the act and says the picker did NOT open', async () => {
    // A failure, not a success with a flag: the page is waiting on a file
    // that will never arrive, and the agent must switch to the upload route.
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
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
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
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
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
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
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
    installCdpMock()
    vi.mocked(chooserInterceptedSince).mockReturnValue({ at: Date.now(), mode: 'selectSingle' })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    const data = result.data as { input_delivered?: string; settled?: unknown; url?: string }
    expect(data.input_delivered, 'the click DID reach the page; both facts are true').toBe('yes')
    expect(data.settled).toBeDefined()
    expect(data.url).toBe(TAB_URL)
  })

  it('does not report a chooser for an ordinary click', async () => {
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
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
      setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
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

  it('teaches answer-then-retry when the stall hit before the action went out', async () => {
    // Stalling on the opening pointer move means no button was ever pressed:
    // with a dialog standing the honest story is the blocked-act one (answer
    // it, then retry), not "the click was sent".
    vi.useFakeTimers()
    try {
      setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
      installCdpMock({ inputAckHangsFrom: 1 })
      vi.mocked(standingDialog).mockReturnValueOnce(null).mockReturnValue(CONFIRM)

      const pending = execAct({ tab_id: TAB, action: 'click', ref: '@e1' })
      await vi.advanceTimersByTimeAsync(60_000)
      const result = await pending

      expect(result.ok).toBe(false)
      const error = String(result.error)
      expect(error).toMatch(/NOT sent/)
      expect(error).toMatch(/Delete this item\?/)
      expect(error).toMatch(/then retry/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses by name when a dialog is standing before the act', async () => {
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
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
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
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
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
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
    setRefs(TAB, new Map([['e1', { backendNodeId: 100 }]]), TAB_URL)
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
