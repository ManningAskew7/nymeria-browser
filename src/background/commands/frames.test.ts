import { beforeEach, describe, expect, it, vi } from 'vitest'
import { execAct } from './act'
import { execSnapshot } from './snapshot'
import {
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
  function withFrameDelivery(opts: { count: number; frameless: boolean; direct: boolean }) {
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
        if (params.expression.includes('__nymDelivery')) return { result: { value: { n: opts.count } } }
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
    setRefs(TAB, new Map([['e1', { backendNodeId: 7, frameTargetId: FRAME_TARGET, role: 'button', name: 'Pay' }]]), TAB_URL)

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
})
