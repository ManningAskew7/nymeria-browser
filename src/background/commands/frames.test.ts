import { beforeEach, describe, expect, it, vi } from 'vitest'
import { __test as actTest, execAct } from './act'
import { execSnapshot } from './snapshot'
import {
  CdpCallTimeout,
  frameSessions,
  installCdpEventRouter,
  resetForTests as resetDebugger,
  sendCommand,
} from '../debuggerSession'
import { resetForTests as resetConsole } from '../consoleBuffer'
import { resetForTests as resetRefs, resolve as resolveRef, set as setRefs } from '../snapshotRefs'
import { resetForTests as resetWorlds } from '../worlds'

/**
 * Cross-origin iframes are the case that decides whether a checkout flow can
 * be completed at all: payment fields and consent dialogs live in them, they
 * run in their own renderer, and they are absent from the page's own tree.
 */

const TAB = 1
// Must match the tab url in the chrome mock, or refs read as stale.
const TAB_URL = 'https://example.com'
const FRAME_SESSION = 'SESSION-ABC'
const FRAME_TARGET = 'FRAME-TARGET-1'

type CdpListener = (source: { tabId: number }, method: string, params: unknown) => void

function cdpEmitter(): CdpListener {
  installCdpEventRouter()
  const addListener = chrome.debugger.onEvent.addListener as unknown as ReturnType<typeof vi.fn>
  return addListener.mock.calls.at(-1)?.[0] as CdpListener
}

interface MockOpts {
  /** Rect the element reports inside its own frame. */
  frameLocalRect?: { x: number; y: number; w: number; h: number }
  /** Rect the <iframe> element reports in the main document. */
  iframeRect?: { left: number; top: number }
}

function installCdpMock(opts: MockOpts = {}) {
  const local = opts.frameLocalRect ?? { x: 30, y: 40, w: 100, h: 20 }
  const iframeRect = opts.iframeRect ?? { left: 200, top: 300 }

  const sendCommandMock = vi.fn(
    async (target: unknown, method: string, params: Record<string, unknown> = {}) => {
      const sessionId = (target as { sessionId?: string }).sessionId
      if (method === 'DOM.resolveNode') return { object: { objectId: `obj-${sessionId ?? 'root'}` } }
      if (method === 'DOM.getFrameOwner') return { backendNodeId: 555 }
      // Worlds: each session answers with its own frame and context id, so
      // probes minted for a frame element run in THAT frame's world.
      if (method === 'Page.getFrameTree') {
        return { frameTree: { frame: { id: sessionId ? 'frame-child' : 'frame-root' } } }
      }
      if (method === 'Page.createIsolatedWorld') {
        return { executionContextId: sessionId ? 99 : 88 }
      }
      if (method === 'Runtime.callFunctionOn') {
        const fn = String(params.functionDeclaration ?? '')
        if (fn.includes('getComputedStyle')) {
          // The iframe element's own position in the main document.
          return { result: { value: { x: iframeRect.left, y: iframeRect.top } } }
        }
        if (fn.includes('getBoundingClientRect')) {
          return { result: { value: local } }
        }
        if (fn.includes('elementFromPoint')) return { result: { value: { hit: true } } }
        if (fn.includes('isConnected')) return { result: { value: true } }
        return { result: { value: undefined } }
      }
      if (method === 'Runtime.evaluate') {
        const expression = String(params.expression ?? '')
        if (expression.includes('MutationObserver')) return { result: { value: 'quiet' } }
        if (expression.includes('activeElement')) return { result: { value: null } }
        return { result: { value: undefined } }
      }
      return {}
    },
  )
  ;(chrome.debugger.sendCommand as unknown) = sendCommandMock
  return sendCommandMock
}

/** Attach the tab, then announce a cross-origin frame the way Chrome does. */
async function attachFrame(): Promise<void> {
  await sendCommand(TAB, 'Runtime.evaluate', { expression: '1' })
  cdpEmitter()({ tabId: TAB }, 'Target.attachedToTarget', {
    sessionId: FRAME_SESSION,
    targetInfo: { targetId: FRAME_TARGET, type: 'iframe', url: 'https://pay.example/card' },
  })
}

beforeEach(() => {
  resetRefs()
  resetDebugger()
  resetConsole()
  resetWorlds()
})

describe('frame session discovery', () => {
  it('records an attached cross-origin frame for the tab', async () => {
    installCdpMock()
    await attachFrame()

    const frames = frameSessions(TAB)
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({
      sessionId: FRAME_SESSION,
      targetId: FRAME_TARGET,
      url: 'https://pay.example/card',
    })
  })

  it('ignores non-iframe targets', async () => {
    installCdpMock()
    await sendCommand(TAB, 'Runtime.evaluate', { expression: '1' })
    cdpEmitter()({ tabId: TAB }, 'Target.attachedToTarget', {
      sessionId: 'worker-1',
      targetInfo: { targetId: 'W1', type: 'worker', url: 'https://shop.example/sw.js' },
    })

    expect(frameSessions(TAB)).toHaveLength(0)
  })

  it('forgets a frame when it detaches', async () => {
    installCdpMock()
    await attachFrame()
    expect(frameSessions(TAB)).toHaveLength(1)

    cdpEmitter()({ tabId: TAB }, 'Target.detachedFromTarget', { sessionId: FRAME_SESSION })
    expect(frameSessions(TAB)).toHaveLength(0)
  })
})

describe('frame-scoped refs', () => {
  it('keeps refs with the same backendNodeId in different frames distinct', () => {
    // backendNodeId is a PROCESS-global counter, so the same number really
    // does occur in two frames. Without the frame id the second ref would
    // resolve to the first frame's element and click the wrong thing.
    setRefs(
      TAB,
      new Map([
        ['e1', { backendNodeId: 42, role: 'button', name: 'Pay' }],
        ['e2', { backendNodeId: 42, frameTargetId: FRAME_TARGET, role: 'button', name: 'Pay' }],
      ]),
      TAB_URL,
    )

    const main = resolveRef(TAB, '@e1', TAB_URL)
    const framed = resolveRef(TAB, '@e2', TAB_URL)

    expect(main.ok && main.frameTargetId).toBeUndefined()
    expect(framed.ok && framed.frameTargetId).toBe(FRAME_TARGET)
  })

  it('resolves a frame ref through that frame session, not the page session', async () => {
    const cdp = installCdpMock()
    await attachFrame()
    setRefs(TAB, new Map([['e1', { backendNodeId: 7, frameTargetId: FRAME_TARGET, role: 'button', name: 'Pay' }]]), TAB_URL)

    await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    const resolveCall = cdp.mock.calls.find((c) => c[1] === 'DOM.resolveNode')
    expect(resolveCall?.[0]).toMatchObject({ tabId: TAB, sessionId: FRAME_SESSION })

    // The follow-up element calls must use the same session: an objectId from
    // a frame is meaningless on the page session, so running geometry or the
    // hit test on the root would read the wrong element (or nothing).
    const elementCalls = cdp.mock.calls.filter((c) => {
      if (c[1] !== 'Runtime.callFunctionOn') return false
      const fn = String((c[2] as { functionDeclaration?: string }).functionDeclaration)
      return /getBoundingClientRect|elementFromPoint|isConnected/.test(fn)
    })
    expect(elementCalls.length).toBeGreaterThan(0)
    for (const call of elementCalls) {
      expect(call[0]).toMatchObject({ tabId: TAB, sessionId: FRAME_SESSION })
    }
  })
})

describe('frame input dispatch', () => {
  it("dispatches a frame ref's click on the FRAME's own session at frame-local coordinates", async () => {
    // Root-session dispatch at composed root coordinates was measured live
    // (2026-08-15) never to reach OOPIF content: acked ok, nothing arrived.
    // The frame's own session is the delivery channel, and the coordinates
    // stay in the frame's viewport space end to end, so no offset exists.
    const cdp = installCdpMock({
      frameLocalRect: { x: 30, y: 40, w: 100, h: 20 },
      iframeRect: { left: 200, top: 300 },
    })
    await attachFrame()
    setRefs(TAB, new Map([['e1', { backendNodeId: 7, frameTargetId: FRAME_TARGET, role: 'button', name: 'Pay' }]]), TAB_URL)

    await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    const pressed = cdp.mock.calls.find(
      (c) => c[1] === 'Input.dispatchMouseEvent' && (c[2] as { type: string }).type === 'mousePressed',
    )
    // The frame-local point, verbatim. The iframe's own position on the
    // page (200, 300) must appear NOWHERE in the dispatch.
    expect(pressed?.[2]).toMatchObject({ x: 30, y: 40 })
    expect(pressed?.[0]).toEqual({ tabId: TAB, sessionId: FRAME_SESSION })
    // No offset is measured at all: the owner lookup was the old shape.
    expect(cdp.mock.calls.some((c) => c[1] === 'DOM.getFrameOwner')).toBe(false)
  })

  it('dispatches a main-document click on the root session, un-offset', async () => {
    const cdp = installCdpMock({ frameLocalRect: { x: 30, y: 40, w: 100, h: 20 } })
    await attachFrame()
    setRefs(TAB, new Map([['e1', { backendNodeId: 7, role: 'button', name: 'Pay' }]]), TAB_URL)

    await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    const pressed = cdp.mock.calls.find(
      (c) => c[1] === 'Input.dispatchMouseEvent' && (c[2] as { type: string }).type === 'mousePressed',
    )
    expect(pressed?.[2]).toMatchObject({ x: 30, y: 40 })
    expect(pressed?.[0]).toEqual({ tabId: TAB })
    expect(cdp.mock.calls.some((c) => c[1] === 'DOM.getFrameOwner')).toBe(false)
  })

  it('sends fill (focus, select-all, insertText) entirely on the frame session', async () => {
    // The pre-fix shape was a cross-session SPLIT: DOM.focus went to the
    // frame while Input.insertText went to the root, whose IME commits into
    // the ROOT document's focused element. Text never reached the frame.
    const cdp = installCdpMock()
    await attachFrame()
    setRefs(TAB, new Map([['e1', { backendNodeId: 7, frameTargetId: FRAME_TARGET, role: 'textbox', name: 'Card number' }]]), TAB_URL)

    await execAct({ tab_id: TAB, action: 'fill', ref: '@e1', value: '4242' })

    const focus = cdp.mock.calls.find((c) => c[1] === 'DOM.focus')
    expect(focus?.[0]).toEqual({ tabId: TAB, sessionId: FRAME_SESSION })
    const insert = cdp.mock.calls.find((c) => c[1] === 'Input.insertText')
    expect(insert?.[0]).toEqual({ tabId: TAB, sessionId: FRAME_SESSION })
    expect(insert?.[2]).toMatchObject({ text: '4242' })
  })

  it('sends type and key events on the frame session', async () => {
    const cdp = installCdpMock()
    await attachFrame()
    setRefs(TAB, new Map([['e1', { backendNodeId: 7, frameTargetId: FRAME_TARGET, role: 'textbox', name: 'Card number' }]]), TAB_URL)

    await execAct({ tab_id: TAB, action: 'type', ref: '@e1', value: 'hi' })
    await execAct({ tab_id: TAB, action: 'key', ref: '@e1', value: 'Enter' })

    const keyEvents = cdp.mock.calls.filter((c) => c[1] === 'Input.dispatchKeyEvent')
    expect(keyEvents.length).toBeGreaterThan(0)
    for (const call of keyEvents) {
      expect(call[0]).toEqual({ tabId: TAB, sessionId: FRAME_SESSION })
    }
  })

  it('a covered frame target refuses without offering the root-coordinate escape', async () => {
    // The taught click-through is a bare-coordinate act, which dispatches on
    // the ROOT session: measured never to arrive inside a cross-origin
    // frame. Offering it for a frame target teaches a guaranteed no-op, and
    // a frame-local click_point would be a mixed-space trap for the same
    // move. The frame exit is the covering element's own ref.
    const cdp = installCdpMock()
    const send = chrome.debugger.sendCommand as unknown as ReturnType<typeof vi.fn>
    const original = send.getMockImplementation() as (...a: unknown[]) => Promise<unknown>
    send.mockImplementation(async (...args: unknown[]) => {
      const sessionId = (args[0] as { sessionId?: string }).sessionId
      const params = args[2] as { functionDeclaration?: string } | undefined
      const fn = String(params?.functionDeclaration ?? '')
      if (args[1] === 'Runtime.callFunctionOn' && sessionId && fn.includes('elementFromPoint')) {
        return { result: { value: { hit: false, blocker: 'div#overlay' } } }
      }
      return original(...args)
    })
    await attachFrame()
    setRefs(TAB, new Map([['e1', { backendNodeId: 7, frameTargetId: FRAME_TARGET, role: 'button', name: 'Pay' }]]), TAB_URL)

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/covered by div#overlay/)
    expect(result.error).toMatch(/own @ref/)
    expect(result.error).not.toMatch(/coordinate=\[/)
    expect((result.data as { click_point?: unknown })?.click_point).toBeUndefined()
    expect(cdp.mock.calls.some((c) => c[1] === 'Input.dispatchMouseEvent')).toBe(false)
  })
})

describe('coordinate acts over frames', () => {
  function overrideForPoint(opts: { ownerAtPoint: boolean }) {
    const send = chrome.debugger.sendCommand as unknown as ReturnType<typeof vi.fn>
    const original = send.getMockImplementation() as (...a: unknown[]) => Promise<unknown>
    send.mockImplementation(async (...args: unknown[]) => {
      const method = args[1]
      const params = (args[2] ?? {}) as { expression?: string; functionDeclaration?: string }
      if (method === 'Runtime.evaluate' && params.expression?.includes('elementFromPoint')) {
        return {
          result: {
            value: { description: 'iframe', opensFileChooser: false, frameOwner: true },
          },
        }
      }
      if (
        method === 'Runtime.callFunctionOn' &&
        params.functionDeclaration?.includes('elementFromPoint(x, y) === this')
      ) {
        return { result: { value: opts.ownerAtPoint } }
      }
      return original(...args)
    })
    return send
  }

  it('a coordinate click aimed into a cross-origin frame refuses before dispatch', async () => {
    // Bare coordinates ride the root session, measured never to arrive
    // inside an OOPIF: proceeding is a knowing no-op wearing ok:true.
    const cdp = installCdpMock()
    overrideForPoint({ ownerAtPoint: true })
    await attachFrame()

    const result = await execAct({ tab_id: TAB, action: 'click', coordinate: [150, 250] })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/cross-origin frame/)
    expect(result.error).toMatch(/@ref/)
    expect((result.data as { refused?: string }).refused).toBe('cross_origin_frame_coordinate')
    expect(cdp.mock.calls.some((c) => c[1] === 'Input.dispatchMouseEvent')).toBe(false)
  })

  it('a session-layer failure during the owner check fails the act, never fails OPEN', async () => {
    // "Chrome did not answer the frame checks" is not "no frame matched":
    // swallowing the timeout would dispatch root input into an OOPIF the
    // refusal existed to protect, ok:true over a knowing no-op.
    installCdpMock()
    overrideForPoint({ ownerAtPoint: true })
    const send = chrome.debugger.sendCommand as unknown as ReturnType<typeof vi.fn>
    const prev = send.getMockImplementation() as (...a: unknown[]) => Promise<unknown>
    send.mockImplementation(async (...args: unknown[]) => {
      if (args[1] === 'DOM.getFrameOwner') throw new CdpCallTimeout('DOM.getFrameOwner', 15_000)
      return prev(...args)
    })
    await attachFrame()

    await expect(execAct({ tab_id: TAB, action: 'click', coordinate: [150, 250] })).rejects.toThrow(
      CdpCallTimeout,
    )
    expect(send.mock.calls.some((c) => c[1] === 'Input.dispatchMouseEvent')).toBe(false)
  })

  it('a coordinate click on a SAME-PROCESS iframe still dispatches (no session claims it)', async () => {
    const cdp = installCdpMock()
    overrideForPoint({ ownerAtPoint: false })
    await attachFrame()

    const result = await execAct({ tab_id: TAB, action: 'click', coordinate: [150, 250] })

    expect(result.ok).toBe(true)
    const pressed = cdp.mock.calls.find(
      (c) => c[1] === 'Input.dispatchMouseEvent' && (c[2] as { type: string }).type === 'mousePressed',
    )
    expect(pressed?.[2]).toMatchObject({ x: 150, y: 250 })
    expect(pressed?.[0]).toEqual({ tabId: TAB })
  })
})

describe('keyboard follows focus across the frame boundary', () => {
  function overrideFocus(opts: { frameHasFocus: boolean; inner?: { tag: string; label: string } }) {
    const send = chrome.debugger.sendCommand as unknown as ReturnType<typeof vi.fn>
    const original = send.getMockImplementation() as (...a: unknown[]) => Promise<unknown>
    send.mockImplementation(async (...args: unknown[]) => {
      const target = args[0] as { sessionId?: string }
      const method = args[1]
      const params = (args[2] ?? {}) as { expression?: string; functionDeclaration?: string }
      if (method === 'Runtime.evaluate' && params.expression?.includes('activeElement')) {
        return target.sessionId
          ? { result: { value: opts.inner ?? null } }
          : { result: { value: { tag: 'iframe', label: '' } } }
      }
      if (
        method === 'Runtime.callFunctionOn' &&
        params.functionDeclaration?.includes('document.activeElement === this')
      ) {
        return { result: { value: opts.frameHasFocus } }
      }
      return original(...args)
    })
    return send
  }

  it("ref-less type dispatches on the frame session when the frame holds the page's focus", async () => {
    const cdp = installCdpMock()
    overrideFocus({ frameHasFocus: true })
    await attachFrame()

    const result = await execAct({ tab_id: TAB, action: 'type', value: 'hi' })

    expect(result.ok).toBe(true)
    const keyEvents = cdp.mock.calls.filter((c) => c[1] === 'Input.dispatchKeyEvent')
    expect(keyEvents.length).toBeGreaterThan(0)
    for (const call of keyEvents) {
      expect(call[0]).toEqual({ tabId: TAB, sessionId: FRAME_SESSION })
    }
  })

  it('ref-less type stays on the root when no frame holds focus', async () => {
    const cdp = installCdpMock()
    overrideFocus({ frameHasFocus: false })
    await attachFrame()

    await execAct({ tab_id: TAB, action: 'type', value: 'h' })

    const keyEvents = cdp.mock.calls.filter((c) => c[1] === 'Input.dispatchKeyEvent')
    expect(keyEvents.length).toBeGreaterThan(0)
    for (const call of keyEvents) {
      expect(call[0]).toEqual({ tabId: TAB })
    }
  })

  it('a ref-less type into a focused frame arms the probe in that frame and verifies delivery', async () => {
    // The keystrokes and the delivery probe must agree on the document:
    // routed keys with a root-armed probe would count zero and report
    // "unknown" forever, the exact shrug this pass removes.
    installCdpMock()
    const send = overrideFocus({ frameHasFocus: true })
    const prev = send.getMockImplementation() as (...a: unknown[]) => Promise<unknown>
    send.mockImplementation(async (...args: unknown[]) => {
      const method = args[1]
      const params = (args[2] ?? {}) as { expression?: string }
      if (method === 'Runtime.evaluate' && params.expression) {
        if (params.expression.includes('addEventListener')) return { result: { value: true } }
        if (params.expression.includes('__nymDelivery')) return { result: { value: { n: 1 } } }
      }
      return prev(...args)
    })
    await attachFrame()

    const result = await execAct({ tab_id: TAB, action: 'type', value: 'hi' })

    expect(result.ok).toBe(true)
    expect((result.data as { input_delivered?: string }).input_delivered).toBe('yes')
    const arm = send.mock.calls.find(
      (c) =>
        c[1] === 'Runtime.evaluate' &&
        String((c[2] as { expression?: string }).expression ?? '').includes('addEventListener'),
    )
    expect(arm?.[0]).toEqual({ tabId: TAB, sessionId: FRAME_SESSION })
  })

  it("the focused payload descends into the frame instead of stopping at tag 'iframe'", async () => {
    // Live QA misread `focused: {tag: "iframe"}` twice as a failed click;
    // the payload now names the frame's own focused element and its frame.
    installCdpMock()
    overrideFocus({ frameHasFocus: true, inner: { tag: 'input', label: 'Card number' } })
    await attachFrame()
    setRefs(TAB, new Map([['e1', { backendNodeId: 7, frameTargetId: FRAME_TARGET, role: 'button', name: 'Pay' }]]), TAB_URL)

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(true)
    expect((result.data as { focused?: unknown }).focused).toMatchObject({
      tag: 'input',
      label: 'Card number',
      frame_url: 'https://pay.example/card',
    })
  })
})

describe('in-frame delivery verification', () => {
  /** Extend the base mock with delivery-probe answers for the FRAME session:
   *  the probe arms in the frame's own world, so in-frame acts get a real
   *  verdict instead of a permanent "unknown". */
  function withFrameDelivery(opts: {
    count: number
    frameless: boolean
    direct: boolean
    /** Full probe-read value overriding `count`: the enriched #176 shape. */
    read?: Record<string, unknown>
  }) {
    const send = chrome.debugger.sendCommand as unknown as ReturnType<typeof vi.fn>
    const original = send.getMockImplementation() as (...a: unknown[]) => Promise<unknown>
    send.mockImplementation(async (...args: unknown[]) => {
      const method = args[1]
      const params = (args[2] ?? {}) as { expression?: string; functionDeclaration?: string }
      if (method === 'Runtime.evaluate' && params.expression) {
        if (params.expression.includes('addEventListener')) return { result: { value: true } }
        if (params.expression.includes("querySelectorAll('iframe,frame')")) {
          return { result: { value: opts.frameless } }
        }
        if (params.expression.includes('__nymDelivery')) {
          return { result: { value: opts.read ?? { n: opts.count } } }
        }
      }
      if (method === 'Runtime.callFunctionOn' && params.functionDeclaration?.includes('ownerDocument === document')) {
        return { result: { value: opts.direct } }
      }
      return original(...args)
    })
    return send
  }

  it("a frame click that arrived reports input_delivered 'yes' from the frame's own probe", async () => {
    installCdpMock()
    const send = withFrameDelivery({ count: 1, frameless: true, direct: true })
    await attachFrame()
    setRefs(TAB, new Map([['e1', { backendNodeId: 7, frameTargetId: FRAME_TARGET, role: 'button', name: 'Pay' }]]), TAB_URL)

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(true)
    expect((result.data as { input_delivered?: string }).input_delivered).toBe('yes')
    // The probe's arm ran in the FRAME's session, not the root's.
    const arm = send.mock.calls.find(
      (c) =>
        c[1] === 'Runtime.evaluate' &&
        String((c[2] as { expression?: string }).expression ?? '').includes('addEventListener'),
    )
    expect(arm?.[0]).toEqual({ tabId: TAB, sessionId: FRAME_SESSION })
  })

  it("the frame's own probe carries the #176 diagnosis fields on a click", async () => {
    // The QA shape this pass exists for: press and release arrive in the
    // frame, no click composes, activation never granted. The payload must
    // say all of that from the frame's own probe, in one read.
    installCdpMock()
    withFrameDelivery({
      count: 2,
      frameless: true,
      direct: true,
      read: { n: 2, types: { mousedown: 1, mouseup: 1 }, prevented: null, ua: { a: false, h: false } },
    })
    await attachFrame()
    setRefs(TAB, new Map([['e1', { backendNodeId: 7, frameTargetId: FRAME_TARGET, role: 'button', name: 'Pay' }]]), TAB_URL)

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(true)
    const data = result.data as Record<string, unknown>
    expect(data.input_delivered).toBe('yes')
    expect(data.input_events).toEqual({ mousedown: 1, mouseup: 1 })
    expect(data.default_prevented).toBeUndefined()
    expect(data.user_activation).toEqual({ active: false, has_been_active: false })
  })

  it("a frame fill is verified through its trusted input event (#176 rider)", async () => {
    // Before this pass a frame fill carried no delivery verdict at all: the
    // only verification was a follow-up read. The probe arms in the frame's
    // session for the `input` event insertText commits.
    installCdpMock()
    const send = withFrameDelivery({
      count: 1,
      frameless: true,
      direct: true,
      read: { n: 1, types: { input: 1 } },
    })
    await attachFrame()
    setRefs(TAB, new Map([['e1', { backendNodeId: 7, frameTargetId: FRAME_TARGET, role: 'textbox', name: 'Card' }]]), TAB_URL)

    const result = await execAct({ tab_id: TAB, action: 'fill', ref: '@e1', value: '4242' })

    expect(result.ok).toBe(true)
    const data = result.data as Record<string, unknown>
    expect(data.input_delivered).toBe('yes')
    expect(data.input_events).toEqual({ input: 1 })
    const arm = send.mock.calls.find(
      (c) =>
        c[1] === 'Runtime.evaluate' &&
        String((c[2] as { expression?: string }).expression ?? '').includes('addEventListener'),
    )
    expect(arm?.[0]).toEqual({ tabId: TAB, sessionId: FRAME_SESSION })
    expect(String((arm?.[2] as { expression?: string }).expression)).toContain('"input"')
  })

  it('a frame click counted zero with a conclusive absence FAILS instead of shrugging', async () => {
    // The pre-2026-08-16 shape reported ok:true, input_delivered:"unknown"
    // for every in-frame act: the exact payload the measured silent no-op
    // hid behind for three QA rounds.
    installCdpMock()
    withFrameDelivery({ count: 0, frameless: true, direct: true })
    await attachFrame()
    setRefs(TAB, new Map([['e1', { backendNodeId: 7, frameTargetId: FRAME_TARGET, role: 'button', name: 'Pay' }]]), TAB_URL)

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/received no event/)
    expect((result.data as { input_delivered?: string }).input_delivered).toBe('no')
  })

  it('an inconclusive zero stays unknown and NAMES the nested-frame reason', async () => {
    installCdpMock()
    withFrameDelivery({ count: 0, frameless: false, direct: false })
    await attachFrame()
    setRefs(TAB, new Map([['e1', { backendNodeId: 7, frameTargetId: FRAME_TARGET, role: 'button', name: 'Pay' }]]), TAB_URL)

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(true)
    const data = result.data as { input_delivered?: string; input_delivered_reason?: string }
    expect(data.input_delivered).toBe('unknown')
    expect(data.input_delivered_reason).toMatch(/nested frame/)
  })

  it('a zero in a frame that ITSELF contains frames still FAILS when the target sits directly in it', async () => {
    // The membership branch, not the frameless shortcut: the probed frame has
    // nested frames (frameless false), but the element belongs to the probed
    // document itself, so a zero count is real. The old absence check asked
    // `w === w.top`, which no frame element can satisfy, and this exact case
    // downgraded to a permanent "unknown".
    installCdpMock()
    withFrameDelivery({ count: 0, frameless: false, direct: true })
    await attachFrame()
    setRefs(TAB, new Map([['e1', { backendNodeId: 7, frameTargetId: FRAME_TARGET, role: 'button', name: 'Pay' }]]), TAB_URL)

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/received no event/)
    expect((result.data as { input_delivered?: string }).input_delivered).toBe('no')
  })
})

describe('frame refs across the idle detach', () => {
  it("a held frame ref survives session churn: it re-resolves through the frame's NEW session", async () => {
    // The debugger detaches from the tab 10s after its last command, killing
    // every frame session; the next attach re-announces the same frames
    // under NEW session ids. Session-keyed refs died right here (measured
    // 2026-08-16 live QA: three consecutive stale reads to land one click);
    // target-id-keyed refs must ride through and dispatch on the NEW session.
    const cdp = installCdpMock()
    await attachFrame()
    // frameUrl rides along as a real mint would carry it: the same-document
    // re-announce below must PASS the navigation tripwire, not dodge it.
    setRefs(
      TAB,
      new Map([
        [
          'e1',
          {
            backendNodeId: 7,
            frameTargetId: FRAME_TARGET,
            frameUrl: 'https://pay.example/card',
            role: 'button',
            name: 'Pay',
          },
        ],
      ]),
      TAB_URL,
    )

    cdpEmitter()({ tabId: TAB }, 'Target.detachedFromTarget', { sessionId: FRAME_SESSION })
    cdpEmitter()({ tabId: TAB }, 'Target.attachedToTarget', {
      sessionId: 'SESSION-DEF',
      targetInfo: { targetId: FRAME_TARGET, type: 'iframe', url: 'https://pay.example/card' },
    })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(true)
    const pressed = cdp.mock.calls.find(
      (c) => c[1] === 'Input.dispatchMouseEvent' && (c[2] as { type: string }).type === 'mousePressed',
    )
    expect(pressed?.[0]).toEqual({ tabId: TAB, sessionId: 'SESSION-DEF' })
  })

  it('an act issued BEFORE the re-announce rides the bounded wait instead of refusing', async () => {
    // Chrome re-announces existing frames moments AFTER the attach the
    // command already holds; the live lookup must poll that race out, not
    // refuse frame-gone on its first empty look.
    const cdp = installCdpMock()
    await attachFrame()
    setRefs(TAB, new Map([['e1', { backendNodeId: 7, frameTargetId: FRAME_TARGET, role: 'button', name: 'Pay' }]]), TAB_URL)
    cdpEmitter()({ tabId: TAB }, 'Target.detachedFromTarget', { sessionId: FRAME_SESSION })
    setTimeout(() => {
      cdpEmitter()({ tabId: TAB }, 'Target.attachedToTarget', {
        sessionId: 'SESSION-LATE',
        targetInfo: { targetId: FRAME_TARGET, type: 'iframe', url: 'https://pay.example/card' },
      })
    }, 250)

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(true)
    const pressed = cdp.mock.calls.find(
      (c) => c[1] === 'Input.dispatchMouseEvent' && (c[2] as { type: string }).type === 'mousePressed',
    )
    expect(pressed?.[0]).toEqual({ tabId: TAB, sessionId: 'SESSION-LATE' })
  })

  it('a frame that re-announced under a DIFFERENT document refuses as navigated, nothing dispatched', async () => {
    // The target id survives the frame navigating; the ref's backendNodeId
    // does not, and a cross-process swap can hand the same number to an
    // unrelated element in the new document. The mint-time frame URL is the
    // tripwire.
    const cdp = installCdpMock()
    await attachFrame()
    setRefs(
      TAB,
      new Map([
        [
          'e1',
          {
            backendNodeId: 7,
            frameTargetId: FRAME_TARGET,
            frameUrl: 'https://pay.example/card',
            role: 'button',
            name: 'Pay',
          },
        ],
      ]),
      TAB_URL,
    )
    cdpEmitter()({ tabId: TAB }, 'Target.detachedFromTarget', { sessionId: FRAME_SESSION })
    cdpEmitter()({ tabId: TAB }, 'Target.attachedToTarget', {
      sessionId: 'SESSION-DEF',
      targetInfo: { targetId: FRAME_TARGET, type: 'iframe', url: 'https://pay.example/receipt' },
    })

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/navigated from/)
    expect((result.data as { stale_refs?: boolean; reason?: string })).toMatchObject({
      stale_refs: true,
      reason: 'navigated',
    })
    expect(cdp.mock.calls.some((c) => c[1] === 'Input.dispatchMouseEvent')).toBe(false)
  })

  it('a frame that never re-announces refuses with the frame-gone story, nothing dispatched', async () => {
    const cdp = installCdpMock()
    await attachFrame()
    setRefs(
      TAB,
      new Map([['e1', { backendNodeId: 7, frameTargetId: 'FRAME-TARGET-GONE', role: 'button', name: 'Pay' }]]),
      TAB_URL,
    )

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/no longer part of the page/)
    expect((result.data as { stale_refs?: boolean; reason?: string })).toMatchObject({
      stale_refs: true,
      reason: 'frame-gone',
    })
    expect(cdp.mock.calls.some((c) => c[1] === 'Input.dispatchMouseEvent')).toBe(false)
  })
})

describe('cross-frame drag', () => {
  it('refuses a drag whose source and destination live in different sessions', async () => {
    // One pointer stream goes to ONE session; the root-dispatch alternative
    // is the measured OOPIF no-op. Fail closed, nothing dispatched.
    const cdp = installCdpMock()
    await attachFrame()
    setRefs(
      TAB,
      new Map([
        ['e1', { backendNodeId: 7, frameTargetId: FRAME_TARGET, role: 'listitem', name: 'Card' }],
        ['e2', { backendNodeId: 8, role: 'list', name: 'Saved cards' }],
      ]),
      TAB_URL,
    )

    const result = await execAct({ tab_id: TAB, action: 'drag', ref: '@e1', to_ref: '@e2' })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/cannot cross a frame boundary/)
    expect((result.data as { cross_frame?: boolean })?.cross_frame).toBe(true)
    expect(cdp.mock.calls.some((c) => c[1] === 'Input.dispatchMouseEvent')).toBe(false)
  })

  it('dispatches a same-frame drag entirely on that frame session, frame-local', async () => {
    const cdp = installCdpMock({ frameLocalRect: { x: 30, y: 40, w: 100, h: 20 } })
    await attachFrame()
    setRefs(
      TAB,
      new Map([
        ['e1', { backendNodeId: 7, frameTargetId: FRAME_TARGET, role: 'listitem', name: 'Card' }],
        ['e2', { backendNodeId: 8, frameTargetId: FRAME_TARGET, role: 'list', name: 'Saved cards' }],
      ]),
      TAB_URL,
    )

    const result = await execAct({ tab_id: TAB, action: 'drag', ref: '@e1', to_ref: '@e2' })

    expect(result.ok).toBe(true)
    const mouseEvents = cdp.mock.calls.filter((c) => c[1] === 'Input.dispatchMouseEvent')
    expect(mouseEvents.length).toBeGreaterThan(0)
    for (const call of mouseEvents) {
      expect(call[0]).toEqual({ tabId: TAB, sessionId: FRAME_SESSION })
    }
    const pressed = mouseEvents.find((c) => (c[2] as { type: string }).type === 'mousePressed')
    expect(pressed?.[2]).toMatchObject({ x: 30, y: 40 })
  })
})

describe('frame probe worlds (#160)', () => {
  it("mints a frame ref's handle in that frame session's own world", async () => {
    const cdp = installCdpMock()
    await attachFrame()
    setRefs(TAB, new Map([['e1', { backendNodeId: 7, frameTargetId: FRAME_TARGET, role: 'button', name: 'Pay' }]]), TAB_URL)

    await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    // The world is created ON the frame session (a cross-origin frame's DOM
    // is only reachable from its own session), and the handle resolve carries
    // that session's context id, not the root's.
    const worldCall = cdp.mock.calls.find(
      (c) =>
        c[1] === 'Page.createIsolatedWorld' &&
        (c[0] as { sessionId?: string }).sessionId === FRAME_SESSION,
    )
    expect(worldCall).toBeDefined()
    const resolveCall = cdp.mock.calls.find((c) => c[1] === 'DOM.resolveNode')
    expect(resolveCall?.[0]).toMatchObject({ tabId: TAB, sessionId: FRAME_SESSION })
    expect((resolveCall?.[2] as { executionContextId?: number }).executionContextId).toBe(99)
  })

  it("a frame click no longer depends on the ROOT session's world at all", async () => {
    // The old shape resolved the <iframe> owner in the root world to compose
    // the offset, so a root-world hiccup refused a perfectly measurable
    // frame click. With dispatch on the frame's own session there is nothing
    // left to ask the root: the click must succeed with root world creation
    // broken the whole time.
    const cdp = installCdpMock()
    const send = chrome.debugger.sendCommand as unknown as ReturnType<typeof vi.fn>
    const original = send.getMockImplementation() as (...a: unknown[]) => Promise<unknown>
    send.mockImplementation(async (...args: unknown[]) => {
      const sessionId = (args[0] as { sessionId?: string }).sessionId
      const params = args[2] as { worldName?: string } | undefined
      if (args[1] === 'Page.createIsolatedWorld' && !sessionId && params?.worldName === 'nymeria_probe') {
        return {}
      }
      return original(...args)
    })
    await attachFrame()
    setRefs(TAB, new Map([['e1', { backendNodeId: 7, frameTargetId: FRAME_TARGET, role: 'button', name: 'Pay' }]]), TAB_URL)

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(true)
    const pressed = cdp.mock.calls.find(
      (c) => c[1] === 'Input.dispatchMouseEvent' && (c[2] as { type: string }).type === 'mousePressed',
    )
    expect(pressed?.[0]).toEqual({ tabId: TAB, sessionId: FRAME_SESSION })
  })

  it('a frame session that refuses world creation gets one Page.enable and a retry (throw shape)', async () => {
    // Live-measured 2026-08-15: on the user's Chrome, OOPIF world creation
    // failed until Page was enabled on that session, so every click inside
    // a cross-origin iframe refused. The retry is the fix; this pins it.
    const cdp = installCdpMock()
    const send = chrome.debugger.sendCommand as unknown as ReturnType<typeof vi.fn>
    const original = send.getMockImplementation() as (...a: unknown[]) => Promise<unknown>
    const enabledSessions = new Set<string>()
    send.mockImplementation(async (...args: unknown[]) => {
      const sessionId = (args[0] as { sessionId?: string }).sessionId
      if (args[1] === 'Page.enable' && sessionId) {
        enabledSessions.add(sessionId)
        return {}
      }
      if (args[1] === 'Page.createIsolatedWorld' && sessionId && !enabledSessions.has(sessionId)) {
        throw new Error("'Page.createIsolatedWorld' wasn't found")
      }
      return original(...args)
    })
    await attachFrame()
    setRefs(TAB, new Map([['e1', { backendNodeId: 7, frameTargetId: FRAME_TARGET, role: 'button', name: 'Pay' }]]), TAB_URL)

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(true)
    expect(enabledSessions.has(FRAME_SESSION)).toBe(true)
    expect(cdp.mock.calls.some((c) => c[1] === 'Input.dispatchMouseEvent')).toBe(true)
  })

  it('the enable retry also covers a frame session answering world creation with nothing', async () => {
    installCdpMock()
    const send = chrome.debugger.sendCommand as unknown as ReturnType<typeof vi.fn>
    const original = send.getMockImplementation() as (...a: unknown[]) => Promise<unknown>
    const enabledSessions = new Set<string>()
    send.mockImplementation(async (...args: unknown[]) => {
      const sessionId = (args[0] as { sessionId?: string }).sessionId
      if (args[1] === 'Page.enable' && sessionId) {
        enabledSessions.add(sessionId)
        return {}
      }
      if (args[1] === 'Page.createIsolatedWorld' && sessionId && !enabledSessions.has(sessionId)) {
        return {}
      }
      return original(...args)
    })
    await attachFrame()
    setRefs(TAB, new Map([['e1', { backendNodeId: 7, frameTargetId: FRAME_TARGET, role: 'button', name: 'Pay' }]]), TAB_URL)

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(true)
    expect(enabledSessions.has(FRAME_SESSION)).toBe(true)
  })

  it('a ROOT session world failure gets no enable retry (Page is already enabled per attach)', async () => {
    const cdp = installCdpMock()
    const send = chrome.debugger.sendCommand as unknown as ReturnType<typeof vi.fn>
    const original = send.getMockImplementation() as (...a: unknown[]) => Promise<unknown>
    send.mockImplementation(async (...args: unknown[]) => {
      const sessionId = (args[0] as { sessionId?: string }).sessionId
      const params = args[2] as { worldName?: string } | undefined
      if (args[1] === 'Page.createIsolatedWorld' && !sessionId && params?.worldName === 'nymeria_probe') {
        return {}
      }
      return original(...args)
    })
    await attachFrame()
    setRefs(TAB, new Map([['e1', { backendNodeId: 7, role: 'button', name: 'Pay' }]]), TAB_URL)
    // The attach itself enables Page on the root (#169); the retry would be
    // an ADDITIONAL enable, so compare counts across the act.
    const rootEnables = () =>
      cdp.mock.calls.filter(
        (c) => c[1] === 'Page.enable' && (c[0] as { sessionId?: string }).sessionId === undefined,
      ).length
    const before = rootEnables()

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(false)
    expect(rootEnables()).toBe(before)
  })

})

describe('scoped read of a frame ref', () => {
  it("re-roots INSIDE the frame: the tree comes from the frame's session and mints frame-owned refs", async () => {
    // Backend node ids are process-global, so resolving a frame ref against
    // the ROOT tree silently matched an unrelated main-document node and a
    // scoped read of a payment frame returned the top document as if that
    // were the answer (measured live 2026-08-16, twice).
    const cdp = installCdpMock()
    const send = chrome.debugger.sendCommand as unknown as ReturnType<typeof vi.fn>
    const original = send.getMockImplementation() as (...a: unknown[]) => Promise<unknown>
    send.mockImplementation(async (...args: unknown[]) => {
      const target = args[0] as { sessionId?: string }
      if (args[1] === 'Accessibility.getFullAXTree') {
        if (target.sessionId !== FRAME_SESSION) return { nodes: [] }
        return {
          nodes: [
            {
              nodeId: 'n1',
              backendDOMNodeId: 7,
              role: { value: 'button' },
              name: { value: 'Pay' },
              childIds: [],
            },
          ],
        }
      }
      return original(...args)
    })
    await attachFrame()
    setRefs(
      TAB,
      new Map([['e1', { backendNodeId: 7, frameTargetId: FRAME_TARGET, role: 'button', name: 'Pay' }]]),
      TAB_URL,
      1,
    )

    const result = await execSnapshot({ tab_id: TAB, scope_ref: '@e1' })

    expect(result.ok).toBe(true)
    // The one tree read went to the FRAME's session, not the root's.
    const axReads = cdp.mock.calls.filter((c) => c[1] === 'Accessibility.getFullAXTree')
    expect(axReads.length).toBeGreaterThan(0)
    for (const call of axReads) {
      expect(call[0]).toEqual({ tabId: TAB, sessionId: FRAME_SESSION })
    }
    // The refs it minted stay frame-owned, so acting on them dispatches into
    // the frame rather than resolving root-side.
    const minted = resolveRef(TAB, '@e2', TAB_URL)
    expect(minted.ok && minted.frameTargetId).toBe(FRAME_TARGET)
  })

  it('a scoped read of a frame whose frame is gone refuses honestly', async () => {
    installCdpMock()
    setRefs(
      TAB,
      new Map([['e1', { backendNodeId: 7, frameTargetId: 'FRAME-GONE', role: 'button', name: 'Pay' }]]),
      TAB_URL,
      1,
    )

    const result = await execSnapshot({ tab_id: TAB, scope_ref: '@e1' })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/no longer part of the page/)
  })

  it('a scoped read of a ref whose frame navigated refuses instead of reading the new document', async () => {
    installCdpMock()
    await attachFrame()
    setRefs(
      TAB,
      new Map([
        [
          'e1',
          {
            backendNodeId: 7,
            frameTargetId: FRAME_TARGET,
            frameUrl: 'https://pay.example/old-checkout',
            role: 'button',
            name: 'Pay',
          },
        ],
      ]),
      TAB_URL,
      1,
    )

    const result = await execSnapshot({ tab_id: TAB, scope_ref: '@e1' })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/navigated from/)
  })
})

describe('full-page read mints frame-owned refs', () => {
  it("a frame section's refs carry the frame's target id and mint-time URL", async () => {
    // This mint site is where nearly every real frame ref is born; a ref
    // minted here without its frame would resolve root-side, the exact
    // wrong-element class frame scoping exists to prevent.
    installCdpMock()
    const send = chrome.debugger.sendCommand as unknown as ReturnType<typeof vi.fn>
    const original = send.getMockImplementation() as (...a: unknown[]) => Promise<unknown>
    send.mockImplementation(async (...args: unknown[]) => {
      const target = args[0] as { sessionId?: string }
      if (args[1] === 'Accessibility.getFullAXTree') {
        if (target.sessionId !== FRAME_SESSION) return { nodes: [] }
        return {
          nodes: [
            {
              nodeId: 'n1',
              backendDOMNodeId: 7,
              role: { value: 'button' },
              name: { value: 'Pay' },
              childIds: [],
            },
          ],
        }
      }
      return original(...args)
    })
    await attachFrame()

    const result = await execSnapshot({ tab_id: TAB })

    expect(result.ok).toBe(true)
    const minted = resolveRef(TAB, '@e1', TAB_URL)
    expect(minted.ok && minted.frameTargetId).toBe(FRAME_TARGET)
    expect(minted.ok && minted.frameUrl).toBe('https://pay.example/card')
  })
})

describe('same-process frame refs (reads-honesty pass)', () => {
  const LOCAL_FRAME = 'LOCAL-1'
  const LOCAL_URL = 'https://example.com/widget'

  /**
   * Layer the same-process shape onto the base mock: the root's local tree
   * lists a child frame, per-frame isolated worlds get their own context id,
   * and `DOM.getContentQuads` answers the page-space read the dispatch uses.
   */
  function overrideSameProcess(
    opts: { childFrames?: { frame: { id: string; url?: string } }[]; quads?: number[][] | null } = {},
  ) {
    const send = chrome.debugger.sendCommand as unknown as ReturnType<typeof vi.fn>
    const original = send.getMockImplementation() as (...a: unknown[]) => Promise<unknown>
    send.mockImplementation(async (...args: unknown[]) => {
      const target = args[0] as { sessionId?: string }
      const method = args[1]
      const params = (args[2] ?? {}) as Record<string, unknown>
      if (method === 'Page.getFrameTree' && !target.sessionId) {
        return {
          frameTree: {
            frame: { id: 'frame-root' },
            childFrames: opts.childFrames ?? [{ frame: { id: LOCAL_FRAME, url: LOCAL_URL } }],
          },
        }
      }
      if (method === 'Page.createIsolatedWorld' && params.frameId === LOCAL_FRAME) {
        return { executionContextId: 55 }
      }
      if (method === 'DOM.getContentQuads') {
        if (opts.quads === null) return {}
        return { quads: opts.quads ?? [[230, 340, 330, 340, 330, 360, 230, 360]] }
      }
      return original(...args)
    })
    return send
  }

  function localRef(over: Record<string, unknown> = {}): void {
    setRefs(
      TAB,
      new Map([
        [
          'e1',
          {
            backendNodeId: 7,
            frameTargetId: LOCAL_FRAME,
            frameUrl: LOCAL_URL,
            role: 'button',
            name: 'Pay',
            ...over,
          },
        ],
      ]),
      TAB_URL,
      1,
    )
  }

  it("resolves in the frame's OWN isolated world and dispatches at page coordinates on the root session", async () => {
    const cdp = installCdpMock()
    overrideSameProcess()
    localRef()

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(true)
    // The worlds (trust probe AND delivery) were created per-frame: the root
    // frame's world cannot see this node, and resolving there told a lying
    // "no longer exists" story.
    const worldCreates = cdp.mock.calls.filter((c) => c[1] === 'Page.createIsolatedWorld')
    expect(
      worldCreates.some((c) => (c[2] as { frameId?: string }).frameId === LOCAL_FRAME),
    ).toBe(true)
    expect(
      worldCreates.some((c) => {
        const p = c[2] as { frameId?: string; worldName?: string }
        return p.frameId === LOCAL_FRAME && String(p.worldName).includes('delivery')
      }),
    ).toBe(true)
    const resolveCall = cdp.mock.calls.find((c) => c[1] === 'DOM.resolveNode')
    expect(resolveCall?.[2]).toMatchObject({ executionContextId: 55 })
    // Same-process frames have no session of their own: everything rides root.
    expect(resolveCall?.[0]).toEqual({ tabId: TAB })
    // Dispatch at the browser-composed page-space quad centre, NOT the
    // frame-local rect (30, 40) the probes read.
    const pressed = cdp.mock.calls.find(
      (c) => c[1] === 'Input.dispatchMouseEvent' && (c[2] as { type: string }).type === 'mousePressed',
    )
    expect(pressed?.[0]).toEqual({ tabId: TAB })
    expect(pressed?.[2]).toMatchObject({ x: 280, y: 350 })
  })

  it('a ref whose frame is GONE refuses with the frame-gone story, nothing dispatched', async () => {
    const cdp = installCdpMock()
    overrideSameProcess({ childFrames: [] })
    localRef()

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/no longer part of the page/)
    expect((result.data as { reason?: string }).reason).toBe('frame-gone')
    expect(cdp.mock.calls.some((c) => c[1] === 'Input.dispatchMouseEvent')).toBe(false)
  })

  it('a ref whose frame NAVIGATED refuses naming both URLs, not "no longer exists"', async () => {
    const cdp = installCdpMock()
    overrideSameProcess({
      childFrames: [{ frame: { id: LOCAL_FRAME, url: 'https://example.com/elsewhere' } }],
    })
    localRef()

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/navigated from https:\/\/example\.com\/widget/)
    expect(result.error).toMatch(/elsewhere/)
    expect((result.data as { reason?: string }).reason).toBe('navigated')
    expect(cdp.mock.calls.some((c) => c[1] === 'Input.dispatchMouseEvent')).toBe(false)
  })

  it('fill rides the ROOT session end to end (focus and insertText), resolved in the frame world', async () => {
    // The OOPIF rule is the opposite (everything on the frame session); for a
    // same-process frame the root's IME reaches the field because one
    // renderer owns both documents.
    const cdp = installCdpMock()
    overrideSameProcess()
    localRef({ role: 'textbox', name: 'Card number' })

    const result = await execAct({ tab_id: TAB, action: 'fill', ref: '@e1', value: '4242' })

    expect(result.ok).toBe(true)
    const focus = cdp.mock.calls.find((c) => c[1] === 'DOM.focus')
    expect(focus?.[0]).toEqual({ tabId: TAB })
    const insert = cdp.mock.calls.find((c) => c[1] === 'Input.insertText')
    expect(insert?.[0]).toEqual({ tabId: TAB })
    expect(insert?.[2]).toMatchObject({ text: '4242' })
  })

  it('a covered same-process target TEACHES the root-space coordinate click-through', async () => {
    // Contrast with the OOPIF covered case above, which suppresses the
    // coordinate because bare coordinates never arrive there. Same-process
    // frames DO receive root-session coordinate input, so the taught escape
    // is real, and it must be the PAGE-space point, never the frame-local one.
    const cdp = installCdpMock()
    overrideSameProcess()
    const send = chrome.debugger.sendCommand as unknown as ReturnType<typeof vi.fn>
    const original = send.getMockImplementation() as (...a: unknown[]) => Promise<unknown>
    send.mockImplementation(async (...args: unknown[]) => {
      const params = args[2] as { functionDeclaration?: string } | undefined
      const fn = String(params?.functionDeclaration ?? '')
      if (args[1] === 'Runtime.callFunctionOn' && fn.includes('elementFromPoint')) {
        return { result: { value: { hit: false, blocker: 'div#overlay' } } }
      }
      return original(...args)
    })
    localRef()

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/covered by div#overlay/)
    expect(result.error).toMatch(/coordinate=\[280, 350\]/)
    expect((result.data as { click_point?: number[] }).click_point).toEqual([280, 350])
    expect(cdp.mock.calls.some((c) => c[1] === 'Input.dispatchMouseEvent')).toBe(false)
  })

  it('an unreadable page position degrades to a LABELLED synthetic click, never a wrong-place trusted one', async () => {
    const cdp = installCdpMock()
    overrideSameProcess({ quads: null })
    localRef()

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(true)
    expect((result.data as { input: string }).input).toBe('synthetic')
    expect((result.data as { synthetic_reason?: string }).synthetic_reason).toMatch(
      /position.*could not be read/,
    )
    expect(cdp.mock.calls.some((c) => c[1] === 'Input.dispatchMouseEvent')).toBe(false)
  })

  it('a scoped read of a same-process frame ref re-roots by frameId and mints frame-owned refs', async () => {
    const cdp = installCdpMock()
    overrideSameProcess()
    const send = chrome.debugger.sendCommand as unknown as ReturnType<typeof vi.fn>
    const original = send.getMockImplementation() as (...a: unknown[]) => Promise<unknown>
    send.mockImplementation(async (...args: unknown[]) => {
      if (args[1] === 'Accessibility.getFullAXTree') {
        const params = (args[2] ?? {}) as { frameId?: string }
        if (params.frameId !== LOCAL_FRAME) return { nodes: [] }
        return {
          nodes: [
            {
              nodeId: 'n1',
              backendDOMNodeId: 7,
              role: { value: 'button' },
              name: { value: 'Pay' },
              childIds: [],
            },
          ],
        }
      }
      return original(...args)
    })
    localRef()

    const result = await execSnapshot({ tab_id: TAB, scope_ref: '@e1' })

    expect(result.ok).toBe(true)
    const axReads = cdp.mock.calls.filter((c) => c[1] === 'Accessibility.getFullAXTree')
    expect(
      axReads.some((c) => ((c[2] ?? {}) as { frameId?: string }).frameId === LOCAL_FRAME),
    ).toBe(true)
    const minted = resolveRef(TAB, '@e2', TAB_URL)
    expect(minted.ok && minted.frameTargetId).toBe(LOCAL_FRAME)
  })

  it("an OOPIF's own same-origin child frame renders as a section too", async () => {
    // The per-session local sweep: a same-origin frame nested inside a
    // cross-origin one is invisible to BOTH the root walk (the OOPIF's tree
    // is not local to the root) and the session list (it has no session).
    installCdpMock()
    const send = chrome.debugger.sendCommand as unknown as ReturnType<typeof vi.fn>
    const original = send.getMockImplementation() as (...a: unknown[]) => Promise<unknown>
    send.mockImplementation(async (...args: unknown[]) => {
      const target = args[0] as { sessionId?: string }
      const method = args[1]
      const params = (args[2] ?? {}) as { frameId?: string }
      if (method === 'Page.getFrameTree') {
        if (target.sessionId === FRAME_SESSION) {
          return {
            frameTree: {
              frame: { id: FRAME_TARGET },
              childFrames: [{ frame: { id: 'NESTED-1', url: 'https://pay.example/inner' } }],
            },
          }
        }
        return { frameTree: { frame: { id: 'frame-root' } } }
      }
      if (method === 'Accessibility.getFullAXTree') {
        if (target.sessionId === FRAME_SESSION && params.frameId === 'NESTED-1') {
          return {
            nodes: [
              {
                nodeId: 'i1',
                backendDOMNodeId: 9,
                role: { value: 'textbox' },
                name: { value: 'CVC' },
                childIds: [],
              },
            ],
          }
        }
        if (target.sessionId === FRAME_SESSION && !params.frameId) {
          // The OOPIF's own document is non-empty (it holds the nested
          // iframe), so its section renders and counts as read.
          return {
            nodes: [
              { nodeId: 'o1', role: { value: 'StaticText' }, name: { value: 'pay-frame' }, childIds: [] },
            ],
          }
        }
        return { nodes: [] }
      }
      return original(...args)
    })
    await attachFrame()

    const result = await execSnapshot({ tab_id: TAB })

    expect(result.ok).toBe(true)
    const tree = (result.data as { tree: string }).tree
    // Indented one level: the nested frame belongs to the OOPIF's section,
    // and a flat render read as a sibling of it (QA round 1).
    expect(tree).toMatch(/\n {2}- iframe "https:\/\/pay\.example\/inner"/)
    expect((result.data as { frames_same_process: number }).frames_same_process).toBe(1)
    expect((result.data as { frames_oopif: number }).frames_oopif).toBe(1)
    const minted = resolveRef(TAB, '@e1', TAB_URL)
    expect(minted.ok && minted.frameTargetId).toBe('NESTED-1')
  })
})

describe('QA round 1 fix round: nested-frame acts and frame-aware waits', () => {
  const OUTER = 'LOCAL-OUTER'
  const INNER = 'LOCAL-INNER'
  const INNER_URL = 'https://example.com/deep'

  it("a ref in a DOUBLY-nested local frame dispatches: the occlusion gate tests the OUTERMOST ancestor's owner, not the immediate one", async () => {
    // The live QA bug: the immediate owner of a nested frame lives in the
    // MIDDLE document, so the dispatch document's elementFromPoint can only
    // ever answer the ancestor iframe, and the gate read the target's own
    // ancestor as a blocker: a deterministic false refusal on every nested
    // target. The gate must ask about `path[0]`, the one owner element that
    // actually lives in the dispatch document.
    const cdp = installCdpMock()
    const send = chrome.debugger.sendCommand as unknown as ReturnType<typeof vi.fn>
    const base = send.getMockImplementation() as (...a: unknown[]) => Promise<unknown>
    send.mockImplementation(async (...args: unknown[]) => {
      const target = args[0] as { sessionId?: string }
      const method = args[1]
      const params = (args[2] ?? {}) as Record<string, unknown>
      if (method === 'Page.getFrameTree' && !target.sessionId) {
        return {
          frameTree: {
            frame: { id: 'frame-root' },
            childFrames: [
              {
                frame: { id: OUTER, url: 'https://example.com/outer' },
                childFrames: [{ frame: { id: INNER, url: INNER_URL } }],
              },
            ],
          },
        }
      }
      if (method === 'Page.createIsolatedWorld' && params.frameId === INNER) {
        return { executionContextId: 77 }
      }
      if (method === 'DOM.getContentQuads') {
        return { quads: [[230, 340, 330, 340, 330, 360, 230, 360]] }
      }
      if (method === 'DOM.getFrameOwner') {
        // Distinct owners so the hit test below can tell which one the gate
        // resolved: the outer's owner sits in the dispatch document, the
        // inner's owner sits in the MIDDLE document.
        return { backendNodeId: params.frameId === OUTER ? 600 : 601 }
      }
      if (method === 'DOM.resolveNode' && (args[2] as { backendNodeId?: number }).backendNodeId === 600) {
        return { object: { objectId: 'obj-outer-owner' } }
      }
      if (method === 'DOM.resolveNode' && (args[2] as { backendNodeId?: number }).backendNodeId === 601) {
        return { object: { objectId: 'obj-inner-owner' } }
      }
      if (method === 'Runtime.callFunctionOn') {
        const fn = String((params as { functionDeclaration?: string }).functionDeclaration ?? '')
        const argVals = ((params as { arguments?: { value?: unknown }[] }).arguments ?? []).map(
          (a) => a.value,
        )
        if (fn.includes('elementFromPoint') && argVals[0] === 280) {
          // The dispatch document's element at the point IS the outer
          // iframe: containment for obj-outer-owner, a "blocker" for the
          // cross-document obj-inner-owner (the measured live shape).
          if (params.objectId === 'obj-outer-owner') return { result: { value: { hit: true } } }
          return { result: { value: { hit: false, blocker: 'iframe' } } }
        }
      }
      return base(...args)
    })
    setRefs(
      TAB,
      new Map([
        [
          'e1',
          { backendNodeId: 7, frameTargetId: INNER, frameUrl: INNER_URL, role: 'button', name: 'Go' },
        ],
      ]),
      TAB_URL,
      1,
    )

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(true)
    const ownerAsks = cdp.mock.calls
      .filter((c) => c[1] === 'DOM.getFrameOwner')
      .map((c) => (c[2] as { frameId?: string }).frameId)
    expect(ownerAsks).toContain(OUTER)
    expect(ownerAsks).not.toContain(INNER)
    const pressed = cdp.mock.calls.find(
      (c) => c[1] === 'Input.dispatchMouseEvent' && (c[2] as { type: string }).type === 'mousePressed',
    )
    expect(pressed?.[0]).toEqual({ tabId: TAB })
    expect(pressed?.[2]).toMatchObject({ x: 280, y: 350 })
  })

  it('the wait text condition sees text living in a same-origin frame document', async () => {
    // The live QA bug: `wait_for` text scanned only the root document while
    // the page read includes same-origin frame content, so a wait on text
    // the read showed came back `found: false`. The scan expression is
    // EXECUTED here against a nested document graph, not string-matched.
    installCdpMock()
    const send = chrome.debugger.sendCommand as unknown as ReturnType<typeof vi.fn>
    const base = send.getMockImplementation() as (...a: unknown[]) => Promise<unknown>
    const grand = { body: { innerText: 'deep frame-needle text' }, querySelectorAll: () => [] }
    const child = {
      body: { innerText: 'child text' },
      querySelectorAll: () => [{ contentDocument: grand }],
    }
    const root = {
      body: { innerText: 'root text' },
      // A cross-origin frame answers a null contentDocument: skipped, and it
      // must not abort the scan before the same-origin sibling.
      querySelectorAll: () => [{ contentDocument: null }, { contentDocument: child }],
    }
    send.mockImplementation(async (...args: unknown[]) => {
      const method = args[1]
      const params = (args[2] ?? {}) as { expression?: string }
      if (method === 'Runtime.evaluate' && String(params.expression).includes('scan(document, 0)')) {
        const value = new Function('document', `return ${params.expression}`)(root) as boolean
        return { result: { value } }
      }
      return base(...args)
    })

    const seen = await actTest.performWait(TAB, { text: 'frame-needle' }, 500)
    expect(seen).toEqual({ found: true, condition: 'text:frame-needle' })

    // Negative control: the mock executes the real expression, so an absent
    // needle times out honestly (this is what proves the scan has teeth).
    const missed = await actTest.performWait(TAB, { text: 'nowhere-needle' }, 250)
    expect(missed.found).toBe(false)
  })

  it('the wait text condition sees text living in an OOPIF document (scanned through its own session)', async () => {
    // A page read includes OOPIF content through its flattened session, so
    // the wait must too: the same scan expression runs in each frame
    // session's probe world after the root scan misses (review round).
    installCdpMock()
    await attachFrame()
    const send = chrome.debugger.sendCommand as unknown as ReturnType<typeof vi.fn>
    const base = send.getMockImplementation() as (...a: unknown[]) => Promise<unknown>
    const rootDoc = { body: { innerText: 'root text only' }, querySelectorAll: () => [] }
    const oopifDoc = { body: { innerText: 'the oopif-needle lives here' }, querySelectorAll: () => [] }
    send.mockImplementation(async (...args: unknown[]) => {
      const target = args[0] as { sessionId?: string }
      const method = args[1]
      const params = (args[2] ?? {}) as { expression?: string }
      if (method === 'Runtime.evaluate' && String(params.expression).includes('scan(document, 0)')) {
        const doc = target.sessionId === FRAME_SESSION ? oopifDoc : rootDoc
        const value = new Function('document', `return ${params.expression}`)(doc) as boolean
        return { result: { value } }
      }
      return base(...args)
    })

    const seen = await actTest.performWait(TAB, { text: 'oopif-needle' }, 500)
    expect(seen).toEqual({ found: true, condition: 'text:oopif-needle' })
  })

  it('a gate-time tree walk that answers nothing SKIPS the occlusion gate instead of refusing', async () => {
    // The fail-open contract: with no ancestor chain readable (walk
    // soft-failed, or the frame left between resolve and gate), falling
    // back to the immediate owner would reinstate the nested false refusal
    // this gate was fixed for. The act dispatches; delivery verification
    // backstops.
    const cdp = installCdpMock()
    const send = chrome.debugger.sendCommand as unknown as ReturnType<typeof vi.fn>
    const base = send.getMockImplementation() as (...a: unknown[]) => Promise<unknown>
    let sawQuads = false
    send.mockImplementation(async (...args: unknown[]) => {
      const target = args[0] as { sessionId?: string }
      const method = args[1]
      const params = (args[2] ?? {}) as Record<string, unknown>
      if (method === 'Page.getFrameTree' && !target.sessionId) {
        // The quads read marks the boundary between resolve and gate: the
        // gate's walk (after it) finds the frame gone.
        if (sawQuads) return { frameTree: { frame: { id: 'frame-root' } } }
        return {
          frameTree: {
            frame: { id: 'frame-root' },
            childFrames: [
              {
                frame: { id: OUTER, url: 'https://example.com/outer' },
                childFrames: [{ frame: { id: INNER, url: INNER_URL } }],
              },
            ],
          },
        }
      }
      if (method === 'Page.createIsolatedWorld' && params.frameId === INNER) {
        return { executionContextId: 77 }
      }
      if (method === 'DOM.getContentQuads') {
        sawQuads = true
        return { quads: [[230, 340, 330, 340, 330, 360, 230, 360]] }
      }
      return base(...args)
    })
    setRefs(
      TAB,
      new Map([
        [
          'e1',
          { backendNodeId: 7, frameTargetId: INNER, frameUrl: INNER_URL, role: 'button', name: 'Go' },
        ],
      ]),
      TAB_URL,
      1,
    )

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(true)
    expect(cdp.mock.calls.some((c) => c[1] === 'DOM.getFrameOwner')).toBe(false)
    const pressed = cdp.mock.calls.find(
      (c) => c[1] === 'Input.dispatchMouseEvent' && (c[2] as { type: string }).type === 'mousePressed',
    )
    expect(pressed?.[2]).toMatchObject({ x: 280, y: 350 })
  })
})

describe('same-process frame refs: review-round defenses', () => {
  const NESTED = 'NESTED-1'
  const NESTED_URL = 'https://pay.example/inner'

  /** A same-origin frame nested INSIDE the OOPIF: the dispatch-space reads
   *  must all ride the OOPIF's session, never the root (backend node ids
   *  are per-process, so root-session quads can describe an unrelated
   *  element: the wrong-click class). */
  function overrideNestedInOopif() {
    const send = chrome.debugger.sendCommand as unknown as ReturnType<typeof vi.fn>
    const original = send.getMockImplementation() as (...a: unknown[]) => Promise<unknown>
    send.mockImplementation(async (...args: unknown[]) => {
      const target = args[0] as { sessionId?: string }
      const method = args[1]
      const params = (args[2] ?? {}) as Record<string, unknown>
      if (method === 'Page.getFrameTree') {
        if (target.sessionId === FRAME_SESSION) {
          return {
            frameTree: {
              frame: { id: FRAME_TARGET },
              childFrames: [{ frame: { id: NESTED, url: NESTED_URL } }],
            },
          }
        }
        return { frameTree: { frame: { id: 'frame-root' } } }
      }
      if (method === 'Page.createIsolatedWorld' && params.frameId === NESTED) {
        return { executionContextId: 66 }
      }
      if (method === 'DOM.getContentQuads') {
        // Only the OOPIF session may be asked; a root-session ask is the bug.
        if (target.sessionId !== FRAME_SESSION) {
          throw new Error('getContentQuads asked on the wrong session')
        }
        return { quads: [[110, 210, 130, 210, 130, 230, 110, 230]] }
      }
      return original(...args)
    })
    return send
  }

  it('a ref nested inside an OOPIF reads quads AND dispatches on the OOPIF session', async () => {
    const cdp = installCdpMock()
    overrideNestedInOopif()
    await attachFrame()
    setRefs(
      TAB,
      new Map([
        [
          'e1',
          { backendNodeId: 9, frameTargetId: NESTED, frameUrl: NESTED_URL, role: 'textbox', name: 'CVC' },
        ],
      ]),
      TAB_URL,
      1,
    )

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(true)
    const quadsCall = cdp.mock.calls.find((c) => c[1] === 'DOM.getContentQuads')
    expect(quadsCall?.[0]).toEqual({ tabId: TAB, sessionId: FRAME_SESSION })
    // The per-frame world was created on the OOPIF session with the nested
    // frame's id, and resolution used it.
    expect(
      cdp.mock.calls.some(
        (c) =>
          c[1] === 'Page.createIsolatedWorld' &&
          (c[2] as { frameId?: string }).frameId === NESTED &&
          (c[0] as { sessionId?: string }).sessionId === FRAME_SESSION,
      ),
    ).toBe(true)
    const pressed = cdp.mock.calls.find(
      (c) => c[1] === 'Input.dispatchMouseEvent' && (c[2] as { type: string }).type === 'mousePressed',
    )
    expect(pressed?.[0]).toEqual({ tabId: TAB, sessionId: FRAME_SESSION })
    expect(pressed?.[2]).toMatchObject({ x: 120, y: 220 })
  })

  it('a PARENT-document overlay over the dispatch point refuses before dispatch, naming it', async () => {
    // The frame-local hit test is clear (the overlay lives in the parent),
    // but dispatch hit-tests through the whole page: without the owner gate
    // the trusted click lands on the overlay and the payload blames input
    // suppression.
    const cdp = installCdpMock()
    const send = chrome.debugger.sendCommand as unknown as ReturnType<typeof vi.fn>
    const base = send.getMockImplementation() as (...a: unknown[]) => Promise<unknown>
    send.mockImplementation(async (...args: unknown[]) => {
      const target = args[0] as { sessionId?: string }
      const method = args[1]
      const params = (args[2] ?? {}) as Record<string, unknown>
      if (method === 'Page.getFrameTree' && !target.sessionId) {
        return {
          frameTree: {
            frame: { id: 'frame-root' },
            childFrames: [{ frame: { id: 'LOCAL-1', url: 'https://example.com/widget' } }],
          },
        }
      }
      if (method === 'Page.createIsolatedWorld' && params.frameId === 'LOCAL-1') {
        return { executionContextId: 55 }
      }
      if (method === 'DOM.getContentQuads') {
        return { quads: [[230, 340, 330, 340, 330, 360, 230, 360]] }
      }
      if (method === 'Runtime.callFunctionOn') {
        const fn = String((params as { functionDeclaration?: string }).functionDeclaration ?? '')
        const argVals = ((params as { arguments?: { value?: unknown }[] }).arguments ?? []).map(
          (a) => a.value,
        )
        // The OWNER gate asks at the dispatch point (280, 350): the parent
        // overlay intercepts there. The frame-local hit test (30, 40) stays
        // clear.
        if (fn.includes('elementFromPoint') && argVals[0] === 280) {
          return { result: { value: { hit: false, blocker: 'div#cookie-banner' } } }
        }
      }
      return base(...args)
    })
    setRefs(
      TAB,
      new Map([
        [
          'e1',
          {
            backendNodeId: 7,
            frameTargetId: 'LOCAL-1',
            frameUrl: 'https://example.com/widget',
            role: 'button',
            name: 'Pay',
          },
        ],
      ]),
      TAB_URL,
      1,
    )

    const result = await execAct({ tab_id: TAB, action: 'click', ref: '@e1' })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/covered in the EMBEDDING document by div#cookie-banner/)
    expect((result.data as { occluded_in?: string }).occluded_in).toBe('parent-document')
    expect(cdp.mock.calls.some((c) => c[1] === 'Input.dispatchMouseEvent')).toBe(false)
  })

  it('a frame id that owns a live session is never double-rendered by the local walk', async () => {
    // Belt-and-braces for Chrome-version drift: if getFrameTree ever lists
    // an OOPIF's frame, rendering it under two identities would mint two
    // refs for every element in it (the wrong-click hazard).
    installCdpMock()
    const send = chrome.debugger.sendCommand as unknown as ReturnType<typeof vi.fn>
    const base = send.getMockImplementation() as (...a: unknown[]) => Promise<unknown>
    send.mockImplementation(async (...args: unknown[]) => {
      const target = args[0] as { sessionId?: string }
      const method = args[1]
      if (method === 'Page.getFrameTree' && !target.sessionId) {
        return {
          frameTree: {
            frame: { id: 'frame-root' },
            // Drifted Chrome: the OOPIF's frame appears in the root tree.
            childFrames: [{ frame: { id: FRAME_TARGET, url: 'https://pay.example/card' } }],
          },
        }
      }
      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: [
            {
              nodeId: 'n1',
              backendDOMNodeId: 7,
              role: { value: 'button' },
              name: { value: 'Pay' },
              childIds: [],
            },
          ],
        }
      }
      return base(...args)
    })
    await attachFrame()

    const result = await execSnapshot({ tab_id: TAB })

    expect(result.ok).toBe(true)
    const tree = (result.data as { tree: string }).tree
    const sections = tree.match(/iframe "https:\/\/pay\.example\/card"/g) ?? []
    expect(sections).toHaveLength(1)
  })
})
