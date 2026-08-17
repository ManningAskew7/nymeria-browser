import type { CommandResult } from '../../shared/types'
import { locateFrame, sendCommand, sessionOf, type Cdp } from '../debuggerSession'
import { callOn } from '../input'
import { resolve as resolveRef } from '../snapshotRefs'
import { withDeadline } from '../settle'
import { sameDocumentUrl } from '../urlMatch'
import { withProbeWorld } from '../worlds'

/**
 * The viewport metrics are a nice-to-have on a page that may be wedged, so
 * they get a short leash rather than the renderer's full patience.
 */
const METRICS_DEADLINE_MS = 2_000

/**
 * How far a region capture may out-resolve the screen.
 *
 * `clip.scale` asks Chrome to RE-RENDER the region, so unlike a crop it can
 * genuinely resolve text the full capture could not. The ceiling is about the
 * agent's context, not about Chrome: pixels are tokens, and a scale-8 crop of
 * a paragraph buys nothing a scale-4 one did not already make legible.
 */
const REGION_SCALE_MIN = 1
const REGION_SCALE_MAX = 4

/**
 * The longest side an UNASKED-FOR magnification will produce.
 *
 * A region exists because something is too small to read, so the default has
 * to magnify hard enough to actually resolve it: live QA needed scale 4 for
 * 5px text and a fixed default of 2 sent the operator round again. But scale
 * is not free, pixels are tokens, and 4x a large box is a context dump. So
 * the default is the biggest scale that keeps the result inside this budget,
 * which magnifies a tiny box to the ceiling and leaves a big one alone. An
 * explicit `region_scale` overrides it and is only clamped.
 */
const REGION_AUTO_BUDGET_PX = 1600
const REGION_SCALE_FLOOR = 2

function autoScale(rect: Rect): number {
  const longest = Math.max(rect.width, rect.height)
  if (!(longest > 0)) return REGION_SCALE_FLOOR
  const fits = Math.floor(REGION_AUTO_BUDGET_PX / longest)
  return Math.min(REGION_SCALE_MAX, Math.max(REGION_SCALE_FLOOR, fits))
}

/**
 * How long resolving a `region_ref` to a box may take before the command
 * gives up and says so.
 *
 * Sized against the BACKEND's screenshot transport budget, not against
 * comfort: everything here runs before the shutter, so this plus the metrics
 * read plus the capture itself has to fit, or the agent gets a bare backend
 * timeout instead of an extension error that names what happened (#162).
 */
const REGION_RESOLVE_DEADLINE_MS = 6_000

interface ScreenshotArgs {
  tab_id: number
  full_page?: boolean
  region?: unknown
  region_ref?: string
  region_scale?: number
}

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** What the in-page evaluate answers: renderer-side, and the only source of
 *  `devicePixelRatio` (no CDP method reports it). */
interface EvalMetrics {
  width: number
  height: number
  scale: number
  scrollX: number
  scrollY: number
}

/** The slice of `Page.getLayoutMetrics` this command reads. The `css*` boxes
 *  are documented as CSS pixels; the legacy un-prefixed ones are not, so they
 *  are deliberately unread. */
interface LayoutMetrics {
  cssVisualViewport?: {
    clientWidth?: number
    clientHeight?: number
    pageX?: number
    pageY?: number
    zoom?: number
  }
  cssContentSize?: { width?: number; height?: number }
}

interface Metrics {
  viewport: { width: number; height: number } | null
  scale: number | null
  zoom: number | null
  scroll: { x: number; y: number } | null
  /** The whole scrollable document, for bounding a clip. */
  content: { width: number; height: number } | null
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Two numbers taken WHOLE from one source. Mixing a width from one
 *  measurement with a height from another describes a viewport that never
 *  existed, which is worse than reporting neither. */
function pair(a: unknown, b: unknown): [number, number] | null {
  const first = finite(a)
  const second = finite(b)
  return first !== null && second !== null ? [first, second] : null
}

/**
 * Everything the model needs to turn a pixel it can see into a coordinate it
 * can act on, from two sources that answer different questions.
 *
 * `window.innerWidth/innerHeight` is the VIEWPORT, deliberately, and not
 * `cssVisualViewport.clientWidth/clientHeight`. Measured live 2026-08-16:
 * a capture came back 1368 px wide while `cssVisualViewport.clientWidth`
 * read 1353, the 15 px being the classic scrollbar, which the captured
 * surface INCLUDES and the CSS viewport box EXCLUDES. Since the whole point
 * of these numbers is the image-to-coordinate ratio, the one that matches
 * the image is the honest one: the other makes every conversion about 1%
 * wrong, roughly 23 px of aim error at x=1200. Do not "fix" this back.
 *
 * `Page.getLayoutMetrics` is here for PAGE ZOOM (`cssVisualViewport.zoom`),
 * which nothing in the page reports honestly: `innerWidth` and
 * `devicePixelRatio` both already have zoom folded into them without saying
 * so. Its viewport and scroll serve as the fallback when the renderer cannot
 * answer at all, off by the scrollbar but far better than nothing.
 *
 * Both are deadlined, not just caught: on a suspended page a renderer-bound
 * call does not reject, it never returns. Losing the metrics costs the vision
 * fallback its coordinates and nothing else, which is far better than losing
 * a picture that is already in hand.
 */
async function readMetrics(tabId: number): Promise<Metrics> {
  const [layout, evald] = await Promise.all([
    withDeadline(sendCommand<LayoutMetrics>(tabId, 'Page.getLayoutMetrics', {}), METRICS_DEADLINE_MS),
    withDeadline(
      sendCommand<{ result?: { value?: EvalMetrics } }>(tabId, 'Runtime.evaluate', {
        expression:
          '({width: window.innerWidth, height: window.innerHeight, scale: window.devicePixelRatio,' +
          ' scrollX: Math.round(window.scrollX), scrollY: Math.round(window.scrollY)})',
        returnByValue: true,
      }),
      METRICS_DEADLINE_MS,
    ),
  ])
  const vv = layout?.cssVisualViewport
  const ev = evald?.result?.value
  const viewport = pair(ev?.width, ev?.height) ?? pair(vv?.clientWidth, vv?.clientHeight)
  const scroll = pair(ev?.scrollX, ev?.scrollY) ?? pair(vv?.pageX, vv?.pageY)
  const content = pair(layout?.cssContentSize?.width, layout?.cssContentSize?.height)
  return {
    viewport: viewport ? { width: viewport[0], height: viewport[1] } : null,
    scale: finite(ev?.scale),
    zoom: finite(vv?.zoom),
    scroll: scroll ? { x: Math.round(scroll[0]), y: Math.round(scroll[1]) } : null,
    content: content ? { width: content[0], height: content[1] } : null,
  }
}

/** `[x, y, width, height]` in viewport CSS pixels, or the refusal text. */
function parseRegion(raw: unknown): Rect | string {
  if (!Array.isArray(raw) || raw.length !== 4 || raw.some((n) => finite(n) === null)) {
    return 'region must be [x, y, width, height] in viewport CSS pixels'
  }
  const [x, y, width, height] = raw as number[]
  if (width <= 0 || height <= 0) return 'region width and height must be greater than zero'
  return { x, y, width, height }
}

/** In-page body of the selector box read, exported so its union logic is
 *  tested as EXECUTED code rather than an unexercised string (the same reason
 *  `HIT_TEST_FN` is exported). Union of the client rects, so a wrapped inline
 *  element is framed whole rather than by its first line, which is the rule
 *  the quad path follows too. */
export const BOX_FN = `function(){
  const rects = Array.from(this.getClientRects());
  if (rects.length === 0) return null;
  const left = Math.min(...rects.map(r => r.left));
  const top = Math.min(...rects.map(r => r.top));
  const right = Math.max(...rects.map(r => r.right));
  const bottom = Math.max(...rects.map(r => r.bottom));
  return { x: left, y: top, width: right - left, height: bottom - top };
}`

/**
 * The box of a `css=` / `xpath=` target, in ROOT viewport CSS pixels.
 *
 * Selectors exist here because the ref route cannot reach most of a page:
 * `@eN` refs are minted for what the accessibility tree exposes as actable,
 * and the thing an agent most often wants to magnify is static text, which
 * mints none (found in live QA, 2026-08-16: the operator could not zoom into
 * a paragraph at all). Root document only, exactly as the same spelling means
 * everywhere else on this surface, and resolved in the PROBE world so the
 * page cannot substitute a different element for the one asked for.
 */
async function rectForSelector(
  tabId: number,
  target: string,
): Promise<{ ok: true; rect: Rect } | { ok: false; error: string }> {
  const isCss = target.startsWith('css=')
  const query = isCss ? target.slice(4) : target.slice(6)
  const expression = isCss
    ? `document.querySelector(${JSON.stringify(query)})`
    : `document.evaluate(${JSON.stringify(query)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue`
  const objectId = await withProbeWorld(tabId, async (contextId) => {
    const evald = await sendCommand<{ result: { objectId?: string } }>(tabId, 'Runtime.evaluate', {
      expression,
      contextId,
    })
    return evald.result.objectId
  }).catch(() => undefined)
  if (!objectId) {
    return {
      ok: false,
      error:
        `nothing in the page matches ${target}, or it could not be resolved. Note that ` +
        'css= and xpath= reach the ROOT document only; inside a frame, use that ' +
        "frame section's @refs.",
    }
  }
  const rect = await callOn<Rect | null>(tabId, objectId, BOX_FN).catch(() => null)
  if (!rect || !(rect.width > 0) || !(rect.height > 0)) {
    return {
      ok: false,
      error: `${target} has no layout box to zoom into (it is not rendered, or has zero size).`,
    }
  }
  return { ok: true, rect }
}

/**
 * The element's box in ROOT viewport CSS pixels, the space `clip` speaks.
 *
 * `DOM.getContentQuads` answers in the viewport CSS pixels of the SESSION it
 * is asked on, local frames composed however deeply nested, which is exactly
 * why a same-process frame's ref works here unchanged: it shares the root
 * session, so its quads already arrive in root space. An OOPIF is the one
 * case that cannot work: its node ids only mean anything on its own session,
 * whose quads are frame-LOCAL, and composing them into root space is a
 * conversion this command does not have. It refuses rather than clipping a
 * plausible-looking wrong rectangle.
 */
async function rectForRef(
  tabId: number,
  ref: string,
): Promise<{ ok: true; rect: Rect } | { ok: false; error: string }> {
  if (ref.startsWith('css=') || ref.startsWith('xpath=')) return rectForSelector(tabId, ref)
  const url = await chrome.tabs
    .get(tabId)
    .then((t) => t?.url ?? null)
    .catch(() => null)
  const resolution = resolveRef(tabId, ref, url)
  if (!resolution.ok) return { ok: false, error: resolution.detail }

  let session: Cdp = tabId
  if (resolution.frameTargetId) {
    const located = await locateFrame(tabId, resolution.frameTargetId)
    if (!located) {
      return {
        ok: false,
        error:
          `the frame that ${ref} lives in is no longer part of the page (it navigated ` +
          'away or was removed). Re-read the page for current refs.',
      }
    }
    if (resolution.frameUrl && located.url && !sameDocumentUrl(resolution.frameUrl, located.url)) {
      return {
        ok: false,
        error:
          `the frame that ${ref} lives in navigated from ${resolution.frameUrl} to ` +
          `${located.url} since the page was read. Re-read the page for current refs.`,
      }
    }
    if (sessionOf(located.session) !== undefined) {
      return {
        ok: false,
        error:
          `${ref} lives in a cross-origin frame, whose element boxes are measured in ` +
          'that frame\'s own coordinates, not the page\'s: this command cannot place ' +
          'them. Take a plain screenshot and zoom with region=[x, y, width, height] ' +
          'read off it instead.',
      }
    }
    session = located.session
  }

  const quads = await sendCommand<{ quads?: number[][] }>(session, 'DOM.getContentQuads', {
    backendNodeId: resolution.backendNodeId,
  }).catch(() => null)
  // EVERY quad, not just the first. An inline element that wraps across lines
  // reports one quad per line box, and taking `quads[0]` would silently zoom
  // into the first line of a link while claiming to have framed the element.
  const xs: number[] = []
  const ys: number[] = []
  for (const quad of quads?.quads ?? []) {
    if (quad.length < 8) continue
    xs.push(quad[0], quad[2], quad[4], quad[6])
    ys.push(quad[1], quad[3], quad[5], quad[7])
  }
  if (xs.length === 0) {
    return {
      ok: false,
      error:
        `${ref} has no layout box to zoom into (it is not rendered, has zero size, or ` +
        'left the page). Re-read the page.',
    }
  }
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  const width = Math.max(...xs) - x
  const height = Math.max(...ys) - y
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    return { ok: false, error: `${ref} has no measurable box to zoom into. Re-read the page.` }
  }
  return { ok: true, rect: { x, y, width, height } }
}

/**
 * Trim a clip to the DOCUMENT, because past its edges Chrome renders nothing
 * and says nothing.
 *
 * Measured 2026-08-16: a clip covering a region Chrome will not render comes
 * back as a perfectly successful capture of PURE WHITE, one distinct colour
 * across every pixel. That is the dangerous shape, an empty answer wearing a
 * success, so the rect is bounded to what exists and the applied box is
 * echoed; a rect with nothing inside the document refuses outright.
 */
function clampToContent(rect: Rect, content: { width: number; height: number }): Rect | null {
  const x = Math.max(rect.x, 0)
  const y = Math.max(rect.y, 0)
  const width = Math.min(rect.x + rect.width, content.width) - x
  const height = Math.min(rect.y + rect.height, content.height) - y
  if (width <= 0 || height <= 0) return null
  return { x, y, width, height }
}

/**
 * Both paths go through CDP, deliberately.
 *
 * `chrome.tabs.captureVisibleTab(windowId)` captures whatever tab is ACTIVE in
 * that window, which is not the same thing as the tab we were asked about.
 * Since the whole point of this extension is that the agent works while the
 * user watches (and often works in a background tab), that is both the wrong
 * image and a disclosure: a screenshot of `tab_id` would silently return the
 * user's foreground tab, whatever it happened to be. `Page.captureScreenshot`
 * is bound to the debugger session, so it can only ever capture the tab the
 * agent actually attached to.
 *
 * `fromSurface: false` is NOT an option here, and the reason is worth keeping.
 * It reads as the fix for capture on a backgrounded tab (the default waits for
 * a composited surface frame, which a tab nobody is looking at may be slow to
 * produce). Measured 2026-08-16, twice: Chrome refuses the parameter outright
 * for an extension's debugger session, with
 * `{"code":-32000,"message":"Only screenshots from surface are allowed."}`;
 * only one extension in Chromium is trusted for it, and none of ours ever
 * will be. It also points the wrong way: from a client that IS trusted it is
 * the OS window-grab path, so it is the one that needs the window on screen,
 * and it silently ignores `clip` and `captureBeyondViewport` (a 120x120 clip
 * came back as the whole viewport, no error). Do not reach for it again.
 */
export async function execScreenshot(args: unknown): Promise<CommandResult> {
  const a = args as ScreenshotArgs
  if (typeof a.tab_id !== 'number') return { ok: false, status: 'error', error: 'tab_id required' }
  const fullPage = a.full_page === true
  const wantsRegion = a.region !== undefined || typeof a.region_ref === 'string'
  if (wantsRegion && fullPage) {
    return {
      ok: false,
      status: 'error',
      error:
        'a region and full_page ask for different pictures: a region is one box magnified, ' +
        'full_page is the whole scrollable document at ordinary size. Pick one.',
    }
  }
  if (a.region !== undefined && typeof a.region_ref === 'string') {
    return { ok: false, status: 'error', error: 'pass either region or region_ref, not both' }
  }

  // The ordinary path captures FIRST and reads metrics after, so a page that
  // wedges just after the shutter still yields its picture. A region cannot be
  // placed without the scroll offset, so that path pays the read up front and
  // says so when the page cannot answer.
  let metrics: Metrics | null = null
  let clip: (Rect & { scale: number }) | null = null
  let clamped = false
  let beyondViewport = false
  if (wantsRegion) {
    metrics = await readMetrics(a.tab_id)
    if (!metrics.scroll) {
      return {
        ok: false,
        status: 'error',
        error:
          'the page did not report its scroll position, so a region cannot be placed in ' +
          'the document. Take a plain screenshot instead.',
      }
    }
    let rect: Rect
    if (typeof a.region_ref === 'string') {
      // Bounded, because everything this does (a frame lookup, a tree read, a
      // quad read) happens BEFORE the shutter and spends the same wall clock
      // the backend's transport budget is counting. Left to the per-call CDP
      // deadline it could eat the whole budget and hand back a bare backend
      // timeout, which carries no payload and names nothing.
      const resolved = await withDeadline(
        rectForRef(a.tab_id, a.region_ref),
        REGION_RESOLVE_DEADLINE_MS,
      )
      if (!resolved) {
        return {
          ok: false,
          status: 'error',
          error:
            `the page did not answer in time with a box for ${a.region_ref}, so nothing ` +
            'was captured. Take a plain screenshot, or retry when the page is settled.',
        }
      }
      if (!resolved.ok) return { ok: false, status: 'error', error: resolved.error }
      rect = resolved.rect
    } else {
      const parsed = parseRegion(a.region)
      if (typeof parsed === 'string') return { ok: false, status: 'error', error: parsed }
      rect = parsed
    }
    // Both rect sources speak VIEWPORT coordinates (the agent reads them off
    // a screenshot; `DOM.getContentQuads` answers viewport-relative), and
    // `clip` speaks DOCUMENT coordinates. Measured 2026-08-16: with the page
    // scrolled to 600 a `clip.y` of 0 returned the document top, not the
    // viewport top. So the scroll offset goes on here, once, at the seam.
    const inDocument = {
      x: rect.x + metrics.scroll.x,
      y: rect.y + metrics.scroll.y,
      width: rect.width,
      height: rect.height,
    }
    const bounded = metrics.content ? clampToContent(inDocument, metrics.content) : inDocument
    if (!bounded) {
      return {
        ok: false,
        status: 'error',
        error:
          'that region falls entirely outside the page, so there is nothing to capture. ' +
          'Re-read the page and take the box from a current screenshot.',
      }
    }
    clamped =
      bounded.x !== inDocument.x ||
      bounded.y !== inDocument.y ||
      bounded.width !== inDocument.width ||
      bounded.height !== inDocument.height
    const asked = finite(a.region_scale)
    const scale =
      asked === null
        ? autoScale(bounded)
        : Math.min(Math.max(asked, REGION_SCALE_MIN), REGION_SCALE_MAX)
    // Only a box that is not entirely on screen needs the beyond-viewport
    // path, and that path is not free (see below), so it is asked for only
    // when it is the difference between real pixels and none.
    beyondViewport = metrics.viewport
      ? bounded.x < metrics.scroll.x ||
        bounded.y < metrics.scroll.y ||
        bounded.x + bounded.width > metrics.scroll.x + metrics.viewport.width ||
        bounded.y + bounded.height > metrics.scroll.y + metrics.viewport.height
      : true
    clip = { ...bounded, scale }
  }

  const resp = await sendCommand<{ data: string }>(a.tab_id, 'Page.captureScreenshot', {
    format: 'png',
    // `captureBeyondViewport` REFLOWS THE USER'S LIVE PAGE and Chrome does not
    // put it back. Measured 2026-08-16, held at one scroll position: the
    // layout viewport went 1353 -> 1368 across a single region capture, the
    // page's scrollbar disappeared, the content shifted 15px wider, and it
    // stayed that way until the tab navigated. So it is asked for only where
    // it earns that: a full-page capture (which cannot be taken any other
    // way, and has always paid this cost) and a region that is not entirely
    // on screen, where the alternative is Chrome returning a perfectly
    // successful capture of PURE WHITE with no error anywhere. Everything
    // else clips off the visible surface and leaves the page alone.
    captureBeyondViewport: fullPage || beyondViewport,
    ...(clip ? { clip } : {}),
  })

  if (!metrics) metrics = await readMetrics(a.tab_id)

  return {
    ok: true,
    status: 'success',
    data: {
      mime: 'image/png',
      base64: resp.data,
      full_page: fullPage,
      viewport: metrics.viewport,
      scale: metrics.scale,
      zoom: metrics.zoom,
      scroll: metrics.scroll,
      region: clip ? { ...clip, clamped, beyond_viewport: beyondViewport } : null,
      beyond_viewport: fullPage || beyondViewport,
    },
  }
}
