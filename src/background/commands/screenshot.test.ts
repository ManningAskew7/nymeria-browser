import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BOX_FN, execScreenshot } from './screenshot'
import { installCdpEventRouter, resetForTests as resetDebugger, sendCommand } from '../debuggerSession'
import { resetForTests as resetRefs, set as setRefs, type RefTarget } from '../snapshotRefs'

const TAB = 1
// Must match the tab url in the chrome mock, or refs read as stale.
const TAB_URL = 'https://example.com'
const LOCAL_FRAME = 'LOCAL-FRAME-1'
const OOPIF_SESSION = 'SESSION-OOPIF'
const OOPIF_TARGET = 'OOPIF-TARGET-1'

interface MockOpts {
  /** Corners of the element `DOM.getContentQuads` answers with, or null for
   *  a node with no layout box. */
  quad?: number[] | null
  /** Several quads, as a wrapped inline element reports. Wins over `quad`. */
  quads?: number[][]
  /** Never answer `DOM.getContentQuads`, as a wedged page does. */
  quadsHang?: boolean
  /** Same-process child frames the root session's tree reports. */
  localFrames?: { id: string; url: string }[]
  /** Drop `Page.getLayoutMetrics`, leaving only the in-page evaluate. */
  noLayoutMetrics?: boolean
  /** Hang the in-page evaluate, leaving only `Page.getLayoutMetrics`. */
  noEvaluate?: boolean
  /** Box a `css=`/`xpath=` target reports, or null for an element with none. */
  selectorBox?: { x: number; y: number; width: number; height: number } | null
  /** Make the probe-world lookup resolve to no element at all. */
  selectorMisses?: boolean
  contentSize?: { width: number; height: number }
}

function installCdpMock(opts: MockOpts = {}) {
  const quad = opts.quad === undefined ? [200, 400, 340, 400, 340, 460, 200, 460] : opts.quad
  const sendCommandMock = vi.fn(
    async (target: unknown, method: string, params: Record<string, unknown> = {}) => {
      if (method === 'Page.captureScreenshot') return { data: 'PNGDATA' }
      if (method === 'Page.getLayoutMetrics') {
        if (opts.noLayoutMetrics) throw new Error('not supported')
        return {
          cssVisualViewport: {
            clientWidth: 1265,
            clientHeight: 705,
            pageX: 7,
            pageY: 407,
            zoom: 1.5,
          },
          cssContentSize: opts.contentSize ?? { width: 1280, height: 5000 },
        }
      }
      if (method === 'Runtime.evaluate') {
        // The selector lookup is the one that runs in the probe world, so a
        // contextId is what separates it from the metrics read.
        if (params.contextId !== undefined) {
          return opts.selectorMisses ? { result: {} } : { result: { objectId: 'obj-selector' } }
        }
        if (opts.noEvaluate) return new Promise<never>(() => {})
        // EVERY number here differs from the layout metrics above, so a test
        // can tell which source answered each field. The width gap is the real
        // one: the scrollbar sits inside innerWidth and outside clientWidth.
        return { result: { value: { width: 1280, height: 720, scale: 2, scrollX: 0, scrollY: 400 } } }
      }
      if (method === 'DOM.getContentQuads') {
        if (opts.quadsHang) return new Promise<never>(() => {})
        if (opts.quads) return { quads: opts.quads }
        return quad ? { quads: [quad] } : {}
      }
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 88 }
      if (method === 'Runtime.callFunctionOn') {
        const box = opts.selectorBox === undefined ? { x: 40, y: 60, width: 220, height: 18 } : opts.selectorBox
        return { result: { value: box } }
      }
      if (method === 'Page.getFrameTree') {
        const sessionId = (target as { sessionId?: string }).sessionId
        return {
          frameTree: {
            frame: { id: sessionId ? 'frame-child' : 'frame-root', url: TAB_URL },
            childFrames: (opts.localFrames ?? []).map((f) => ({ frame: { id: f.id, url: f.url } })),
          },
        }
      }
      return {}
    },
  )
  ;(chrome.debugger.sendCommand as unknown) = sendCommandMock
  return sendCommandMock
}

function seedRef(ref: string, target: Partial<RefTarget> = {}): void {
  const refs = new Map<string, RefTarget>()
  refs.set(ref, { backendNodeId: 77, role: 'button', name: 'Buy', ...target })
  setRefs(TAB, refs, TAB_URL, 9)
}

/** Announce a cross-origin frame the way Chrome does, so `locateFrame` finds
 *  it as an out-of-process session rather than a local one. */
async function attachOopif(): Promise<void> {
  installCdpEventRouter()
  const addListener = chrome.debugger.onEvent.addListener as unknown as ReturnType<typeof vi.fn>
  const emit = addListener.mock.calls.at(-1)?.[0] as (
    source: { tabId: number },
    method: string,
    params: unknown,
  ) => void
  await sendCommand(TAB, 'Runtime.evaluate', { expression: '1' })
  emit({ tabId: TAB }, 'Target.attachedToTarget', {
    sessionId: OOPIF_SESSION,
    targetInfo: { targetId: OOPIF_TARGET, type: 'iframe', url: 'https://pay.example/card' },
  })
}

function captureOf(mock: ReturnType<typeof installCdpMock>) {
  return mock.mock.calls.find((c) => c[1] === 'Page.captureScreenshot')
}

function paramsOf(call: unknown[] | undefined): Record<string, unknown> {
  return (call?.[2] ?? {}) as Record<string, unknown>
}

beforeEach(() => {
  resetDebugger()
  resetRefs()
})

describe('execScreenshot', () => {
  it('captures the requested tab, not whichever tab the user is looking at', async () => {
    // captureVisibleTab is window-scoped: it returns the window's ACTIVE tab.
    // The agent routinely works in a background tab while the user browses in
    // the foreground, so that path returns the wrong page and leaks whatever
    // the user happens to have open.
    const mock = installCdpMock()
    const captureVisibleTab = vi.fn()
    ;(chrome.tabs.captureVisibleTab as unknown) = captureVisibleTab

    const result = await execScreenshot({ tab_id: TAB })

    expect(result.ok).toBe(true)
    expect(captureVisibleTab, 'must not use the window-scoped capture').not.toHaveBeenCalled()
    expect(captureOf(mock)?.[0], 'the capture must be bound to the requested tab').toEqual({
      tabId: TAB,
    })
  })

  it('never sends fromSurface, which Chrome refuses for an extension anyway', async () => {
    // Measured live 2026-08-16: `fromSurface: false` returns
    // "Only screenshots from surface are allowed." for any debugger session an
    // extension owns, so shipping it would have failed EVERY capture, region
    // and full-page included. From a trusted client it is also the OS
    // window-grab path, which silently ignores clip. This test is the tripwire
    // for someone reaching for it again as the backgrounded-tab fix.
    const mock = installCdpMock()

    await execScreenshot({ tab_id: TAB })
    await execScreenshot({ tab_id: TAB, full_page: true })
    await execScreenshot({ tab_id: TAB, region: [0, 0, 50, 50] })

    const captures = mock.mock.calls.filter((c) => c[1] === 'Page.captureScreenshot')
    expect(captures).toHaveLength(3)
    for (const capture of captures) {
      expect(paramsOf(capture)).not.toHaveProperty('fromSurface')
    }
  })

  it('reports the viewport the CAPTURE sees, not the narrower CSS viewport box', async () => {
    // Measured live 2026-08-16: the captured image was 1368 px wide while
    // cssVisualViewport.clientWidth read 1353, the 15 px being the scrollbar,
    // which the captured surface includes and the CSS box excludes. The whole
    // value of these numbers is the image-to-coordinate ratio, so the viewport
    // has to be the one that matches the image: innerWidth. The other is ~1%
    // wrong, about 23 px of aim error at x=1200.
    installCdpMock()

    const result = await execScreenshot({ tab_id: TAB, full_page: false })

    const data = result.data as {
      viewport: { width: number; height: number }
      scale: number
      zoom: number
      scroll: { x: number; y: number }
      region: unknown
    }
    expect(data.viewport).toEqual({ width: 1280, height: 720 })
    expect(data.scroll).toEqual({ x: 0, y: 400 })
    // Zoom is the one fact only Page.getLayoutMetrics carries: innerWidth and
    // devicePixelRatio both already have it folded in without saying so.
    expect(data.zoom).toBe(1.5)
    expect(data.scale).toBe(2)
    expect(data.region, 'a plain capture has no region').toBeNull()
  })

  it('falls back to the layout metrics when the page cannot answer', async () => {
    // Off by the scrollbar, and far better than nothing: a null viewport
    // throws away the coordinates entirely.
    installCdpMock({ noEvaluate: true })
    vi.useFakeTimers()
    try {
      const pending = execScreenshot({ tab_id: TAB })
      await vi.advanceTimersByTimeAsync(10_000)
      const data = (await pending).data as {
        viewport: { width: number; height: number }
        scroll: { x: number; y: number }
        scale: number | null
      }
      expect(data.viewport).toEqual({ width: 1265, height: 705 })
      expect(data.scroll).toEqual({ x: 7, y: 407 })
      expect(data.scale, 'devicePixelRatio has no CDP source').toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('falls back to the in-page numbers when the layout read fails', async () => {
    // Page.getLayoutMetrics is the only source of zoom, so its absence must
    // cost the zoom fact and nothing else: a viewport of null would throw away
    // coordinates the page can still report perfectly well.
    installCdpMock({ noLayoutMetrics: true })

    const result = await execScreenshot({ tab_id: TAB })

    const data = result.data as {
      viewport: { width: number }
      scale: number
      zoom: number | null
      scroll: { y: number }
    }
    expect(data.viewport.width).toBe(1280)
    expect(data.scroll.y).toBe(400)
    expect(data.scale).toBe(2)
    expect(data.zoom).toBeNull()
  })

  it('stitches beyond the viewport only when full_page is asked for', async () => {
    const mock = installCdpMock()

    await execScreenshot({ tab_id: TAB, full_page: true })
    await execScreenshot({ tab_id: TAB })

    const captures = mock.mock.calls.filter((c) => c[1] === 'Page.captureScreenshot')
    expect(paramsOf(captures[0]).captureBeyondViewport).toBe(true)
    expect(paramsOf(captures[1]).captureBeyondViewport).toBe(false)
  })

  it('does not claim a reflow on a full page that already fits the viewport', async () => {
    // Live QA 2026-08-17: a full_page capture of a page whose document was no
    // taller than its viewport still printed the reflow warning, and the
    // operator said, correctly, that a notice which fires when it does not
    // apply is one it starts skimming, which is exactly when the real one
    // arrives. Asking to reach past the viewport is not reaching: with nothing
    // off screen there is no scrollbar to drop and no layout to shift.
    installCdpMock({ contentSize: { width: 1280, height: 700 } })
    const fits = await execScreenshot({ tab_id: TAB, full_page: true })

    installCdpMock() // the default document is 5000 tall
    const tall = await execScreenshot({ tab_id: TAB, full_page: true })

    // Not knowing is not the same as knowing it was fine.
    installCdpMock({ noLayoutMetrics: true })
    const unknown = await execScreenshot({ tab_id: TAB, full_page: true })

    const beyond = (r: typeof fits) => (r.data as { beyond_viewport: boolean }).beyond_viewport
    expect(beyond(fits), 'a document that fits reflows nothing').toBe(false)
    expect(beyond(tall), 'a document past the fold does').toBe(true)
    expect(beyond(unknown), 'an unreadable content size stays disclosed').toBe(true)
  })

  it('still returns the image when the page is too suspended to answer for metrics', async () => {
    // The picture is the thing the agent most wants from a page frozen by a
    // dialog or a long script. Only the metrics are renderer-bound, and an
    // undeadlined read there would hold the whole command to its transport
    // timeout and throw the picture away. Losing the coordinates costs the
    // vision fallback its aim; losing the picture costs the agent the page.
    vi.useFakeTimers()
    try {
      ;(chrome.debugger.sendCommand as unknown) = vi.fn(async (...call: unknown[]) => {
        const method = call[1] as string
        if (method === 'Page.captureScreenshot') return { data: 'PNGDATA' }
        return new Promise<never>(() => {})
      })

      let settled = false
      const pending = execScreenshot({ tab_id: TAB }).then((r) => {
        settled = true
        return r
      })
      await vi.advanceTimersByTimeAsync(10_000)

      expect(settled, 'must not wait on the suspended renderer').toBe(true)
      const result = await pending
      expect(result.ok).toBe(true)
      const data = result.data as {
        base64: string
        viewport: unknown
        scale: unknown
        zoom: unknown
      }
      expect(data.base64).toBe('PNGDATA')
      expect(data.viewport).toBeNull()
      expect(data.scale).toBeNull()
      expect(data.zoom).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('execScreenshot regions', () => {
  it('puts the asked-for rectangle where clip actually reads it, in the document', async () => {
    // The agent's rect is VIEWPORT space (it read it off a screenshot) and
    // `clip` is DOCUMENT space. Measured live 2026-08-16: scrolled to 600, a
    // clip.y of 0 returned the document top. The mock is scrolled to y=400, so
    // a region at viewport y=400 is document y=800. Get this backwards and the
    // picture is of somewhere else, or of nothing at all.
    const mock = installCdpMock()

    const result = await execScreenshot({
      tab_id: TAB,
      region: [200, 400, 140, 60],
      region_scale: 3,
    })

    expect(paramsOf(captureOf(mock)).clip).toEqual({
      x: 200,
      y: 800,
      width: 140,
      height: 60,
      scale: 3,
    })
    expect((result.data as { region: unknown }).region).toEqual({
      x: 200,
      y: 800,
      width: 140,
      height: 60,
      scale: 3,
      clamped: false,
      beyond_viewport: false,
    })
  })

  it('reaches past the viewport only for a box that is not entirely on screen', async () => {
    // Two measured facts pull opposite ways. Without captureBeyondViewport, a
    // clip over anything off screen returns a SUCCESSFUL capture of pure
    // white, no error anywhere. With it, Chrome drops the page's scrollbar and
    // reflows the user's live page, permanently, until the tab navigates. So
    // it is spent only where it is the difference between real pixels and
    // none. Viewport in the mock is 1280x720 at scroll (0, 400).
    const mock = installCdpMock()

    await execScreenshot({ tab_id: TAB, region: [10, 10, 100, 50] })
    await execScreenshot({ tab_id: TAB, region: [10, 700, 100, 200] })
    await execScreenshot({ tab_id: TAB })

    const captures = mock.mock.calls.filter((c) => c[1] === 'Page.captureScreenshot')
    expect(paramsOf(captures[0]).captureBeyondViewport, 'an on-screen box must not').toBe(false)
    expect(paramsOf(captures[1]).captureBeyondViewport, 'a box past the fold must').toBe(true)
    expect(paramsOf(captures[2]).captureBeyondViewport, 'a plain capture must not').toBe(false)
  })

  it('tells the backend when a capture reflowed the page', async () => {
    installCdpMock()
    const onScreen = await execScreenshot({ tab_id: TAB, region: [10, 10, 100, 50] })
    const offScreen = await execScreenshot({ tab_id: TAB, region: [10, 700, 100, 200] })

    expect((onScreen.data as { beyond_viewport: boolean }).beyond_viewport).toBe(false)
    expect((offScreen.data as { beyond_viewport: boolean }).beyond_viewport).toBe(true)
  })

  it('picks a magnification from the box when none was asked for', async () => {
    // A region exists because something is too small to read, so a small box
    // goes to the ceiling; live QA needed scale 4 for 5px text and a flat
    // default of 2 sent it round again. A large box does not, because pixels
    // are tokens.
    const mock = installCdpMock()

    await execScreenshot({ tab_id: TAB, region: [0, 0, 66, 15] })
    await execScreenshot({ tab_id: TAB, region: [0, 0, 900, 300] })
    await execScreenshot({ tab_id: TAB, region: [0, 0, 66, 15], region_scale: 1 })

    const scales = mock.mock.calls
      .filter((c) => c[1] === 'Page.captureScreenshot')
      .map((c) => (paramsOf(c).clip as { scale: number }).scale)
    expect(scales[0], 'a tiny box magnifies to the ceiling').toBe(4)
    expect(scales[1], 'a big box is left alone').toBe(2)
    expect(scales[2], 'an explicit ask still wins').toBe(1)
  })

  it('holds an explicit region scale inside its bounds', async () => {
    const mock = installCdpMock()

    await execScreenshot({ tab_id: TAB, region: [0, 0, 100, 100], region_scale: 40 })
    await execScreenshot({ tab_id: TAB, region: [0, 0, 100, 100], region_scale: 0 })

    const scales = mock.mock.calls
      .filter((c) => c[1] === 'Page.captureScreenshot')
      .map((c) => (paramsOf(c).clip as { scale: number }).scale)
    expect(scales).toEqual([4, 1])
  })

  it('trims a region that runs past the page and says it did', async () => {
    // Past the document edge Chrome renders nothing and reports nothing: the
    // capture succeeds and comes back pure white. Trimming to what exists, and
    // echoing the applied box, is how the model reads a smaller image knowing
    // why instead of measuring a mystery.
    const mock = installCdpMock()

    const result = await execScreenshot({ tab_id: TAB, region: [1200, 700, 400, 400] })

    expect(paramsOf(captureOf(mock)).clip).toEqual({
      x: 1200,
      y: 1100,
      width: 80,
      height: 400,
      scale: 4,
    })
    expect((result.data as { region: { clamped: boolean } }).region.clamped).toBe(true)
  })

  it('refuses a region that falls entirely outside the page', async () => {
    // The document is 1280x5000 in the mock, and the page is scrolled to 400.
    const mock = installCdpMock()

    const result = await execScreenshot({ tab_id: TAB, region: [2000, 6000, 100, 100] })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('entirely outside the page')
    expect(captureOf(mock), 'nothing should be captured').toBeUndefined()
  })

  it('refuses a malformed region rather than capturing something else', async () => {
    const mock = installCdpMock()

    const bad = await execScreenshot({ tab_id: TAB, region: [10, 20, 30] })
    const zero = await execScreenshot({ tab_id: TAB, region: [10, 20, 0, 30] })

    expect(bad.ok).toBe(false)
    expect(bad.error).toContain('[x, y, width, height]')
    expect(zero.ok).toBe(false)
    expect(zero.error).toContain('greater than zero')
    expect(captureOf(mock)).toBeUndefined()
  })

  it('refuses region and full_page together instead of silently dropping one', async () => {
    const mock = installCdpMock()

    const result = await execScreenshot({ tab_id: TAB, region: [0, 0, 10, 10], full_page: true })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('Pick one')
    expect(captureOf(mock)).toBeUndefined()
  })

  it('refuses region and region_ref together', async () => {
    installCdpMock()
    seedRef('e1')

    const result = await execScreenshot({
      tab_id: TAB,
      region: [0, 0, 10, 10],
      region_ref: '@e1',
    })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('not both')
  })

  it('zooms into a ref by measuring its box in the page', async () => {
    const mock = installCdpMock({ quad: [200, 400, 340, 400, 340, 460, 200, 460] })
    seedRef('e1')

    const result = await execScreenshot({ tab_id: TAB, region_ref: '@e1' })

    expect(result.ok).toBe(true)
    // Quads are viewport-relative, clip is document-relative, page scrolled 400.
    expect(paramsOf(captureOf(mock)).clip).toEqual({
      x: 200,
      y: 800,
      width: 140,
      height: 60,
      scale: 4,
    })
  })

  it('zooms into a ref inside a same-process frame, whose box is already page-space', async () => {
    // DOM.getContentQuads answers in the viewport coordinates of the session it
    // is asked on, local frames composed however deeply nested. A same-process
    // frame shares the root session, so its quads need no conversion.
    const mock = installCdpMock({
      quad: [10, 20, 110, 20, 110, 60, 10, 60],
      localFrames: [{ id: LOCAL_FRAME, url: `${TAB_URL}/child` }],
    })
    seedRef('e1', { frameTargetId: LOCAL_FRAME, frameUrl: `${TAB_URL}/child` })

    const result = await execScreenshot({ tab_id: TAB, region_ref: '@e1' })

    expect(result.ok).toBe(true)
    expect(paramsOf(captureOf(mock)).clip).toEqual({
      x: 10,
      y: 420,
      width: 100,
      height: 40,
      scale: 4,
    })
  })

  it('refuses a ref inside a cross-origin frame, naming the rect route', async () => {
    // An OOPIF's node ids only mean anything on its own session, whose quads
    // are frame-LOCAL. Clipping those numbers in page space would capture a
    // confident picture of the wrong part of the page.
    const mock = installCdpMock()
    await attachOopif()
    seedRef('e1', { frameTargetId: OOPIF_TARGET, frameUrl: 'https://pay.example/card' })

    const result = await execScreenshot({ tab_id: TAB, region_ref: '@e1' })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('cross-origin frame')
    expect(result.error).toContain('region=')
    expect(captureOf(mock), 'nothing should be captured').toBeUndefined()
  })

  it('refuses a stale ref with the story that tells the agent to re-read', async () => {
    const mock = installCdpMock()
    seedRef('e1')

    const result = await execScreenshot({ tab_id: TAB, region_ref: '@e9' })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/re-read the page/i)
    expect(captureOf(mock)).toBeUndefined()
  })

  it('zooms into a css= selector, the only route to text that mints no ref', async () => {
    // Found in live QA: @eN refs are minted for what the tree exposes as
    // actable, so the paragraph an agent most wants magnified has no ref at
    // all. Without selectors "capture this element" is unreachable for most
    // of a page.
    const mock = installCdpMock({ selectorBox: { x: 40, y: 60, width: 220, height: 18 } })

    const result = await execScreenshot({ tab_id: TAB, region_ref: 'css=#tiny-a' })

    expect(result.ok).toBe(true)
    // Viewport box plus the scroll offset (400), as any other region.
    expect(paramsOf(captureOf(mock)).clip).toEqual({
      x: 40,
      y: 460,
      width: 220,
      height: 18,
      scale: 4,
    })
    const lookup = mock.mock.calls.find(
      (c) => c[1] === 'Runtime.evaluate' && (c[2] as { contextId?: number })?.contextId !== undefined,
    )
    expect(lookup, 'the selector must resolve in the probe world, not the page').toBeTruthy()
    expect(String((lookup?.[2] as { expression: string }).expression)).toContain('querySelector')
  })

  it('resolves an xpath= selector the same way', async () => {
    const mock = installCdpMock({ selectorBox: { x: 5, y: 5, width: 50, height: 10 } })

    const result = await execScreenshot({ tab_id: TAB, region_ref: 'xpath=//p[1]' })

    expect(result.ok).toBe(true)
    const lookup = mock.mock.calls.find(
      (c) => c[1] === 'Runtime.evaluate' && (c[2] as { contextId?: number })?.contextId !== undefined,
    )
    expect(String((lookup?.[2] as { expression: string }).expression)).toContain('document.evaluate')
  })

  it('refuses a selector that matches nothing, naming the frame limit', async () => {
    const mock = installCdpMock({ selectorMisses: true })

    const result = await execScreenshot({ tab_id: TAB, region_ref: 'css=#nope' })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('nothing in the page matches css=#nope')
    expect(result.error, 'the frame limit is the likeliest cause').toContain('ROOT document only')
    expect(captureOf(mock)).toBeUndefined()
  })

  it('unions an element\'s client rects, so a wrapped line is not the whole box', () => {
    // Executed, not asserted as a string: a wrapped inline element reports one
    // rect per line, and framing it by rects[0] would capture the first line
    // while claiming to have framed the element.
    const box = new Function(`return (${BOX_FN})`)() as () => unknown
    const wrapped = {
      getClientRects: () => [
        { left: 400, top: 100, right: 600, bottom: 120 },
        { left: 100, top: 120, right: 300, bottom: 140 },
      ],
    }
    expect(box.call(wrapped)).toEqual({ x: 100, y: 100, width: 500, height: 40 })

    const gone = { getClientRects: () => [] }
    expect(box.call(gone), 'an element with no rects has no box').toBeNull()
  })

  it('refuses a selector whose element has no box', async () => {
    const mock = installCdpMock({ selectorBox: null })

    const result = await execScreenshot({ tab_id: TAB, region_ref: 'css=#hidden' })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('no layout box')
    expect(captureOf(mock)).toBeUndefined()
  })

  it('refuses a ref with no layout box rather than clipping nothing', async () => {
    const mock = installCdpMock({ quad: null })
    seedRef('e1')

    const result = await execScreenshot({ tab_id: TAB, region_ref: '@e1' })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('no layout box')
    expect(captureOf(mock)).toBeUndefined()
  })

  it('frames every quad of a ref, not just its first line box', async () => {
    // An inline element wrapped across lines reports one quad per line. Taking
    // quads[0] would zoom into the first line while claiming to have framed
    // the element, which is the confident-wrong-picture class.
    const mock = installCdpMock({
      quads: [
        [400, 100, 600, 100, 600, 120, 400, 120],
        [100, 120, 300, 120, 300, 140, 100, 140],
      ],
    })
    seedRef('e1')

    await execScreenshot({ tab_id: TAB, region_ref: '@e1' })

    expect(paramsOf(captureOf(mock)).clip).toEqual({
      x: 100,
      y: 500,
      width: 500,
      height: 40,
      scale: 3,
    })
  })

  it('gives up on a ref the page will not measure, instead of eating the budget', async () => {
    // Everything region resolution does happens BEFORE the shutter, on the
    // same clock the backend's transport budget is counting. Unbounded, a slow
    // page turns an honest extension error into a bare backend timeout that
    // names nothing.
    vi.useFakeTimers()
    try {
      installCdpMock({ quadsHang: true })
      seedRef('e1')

      let settled = false
      const pending = execScreenshot({ tab_id: TAB, region_ref: '@e1' }).then((r) => {
        settled = true
        return r
      })
      await vi.advanceTimersByTimeAsync(20_000)

      expect(settled, 'must not ride the per-call CDP deadline').toBe(true)
      const result = await pending
      expect(result.ok).toBe(false)
      expect(result.error).toContain('did not answer in time')
    } finally {
      vi.useRealTimers()
    }
  })
})
