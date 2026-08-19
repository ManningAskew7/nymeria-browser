import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execExtractText, __test } from './extract_text'
import { resetForTests as resetDebugger } from '../debuggerSession'
import { resetForTests as resetWorlds } from '../worlds'

const TAB = 1
const WORLD_CONTEXT = 77

beforeEach(() => {
  resetDebugger()
  resetWorlds()
})

interface PageFixture {
  text?: string
  url?: string
  title?: string
  /** The read root does not exist (no body, or a selector that matched nothing). */
  missing?: boolean
  /** The evaluate came back as a page-side exception. */
  throws?: boolean
  /** Isolated-world creation answers nothing. */
  noWorld?: boolean
  /** What the document's own navigation timing entry says (#187). */
  status?: number | null
  /** What the loss scan counted (#190). */
  dropped?: { generated: number; capped: boolean } | null
  /** Which candidates of a selector LIST the read root satisfies (#193). */
  matched?: string | null
  /** How many elements the whole selector matched (#193). */
  matchCount?: number | null
}

function installCdpMock(page: PageFixture = {}) {
  const sendCommand = vi.fn(async (...call: unknown[]) => {
    const method = call[1] as string
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'ROOT-FRAME' } } }
    if (method === 'Page.createIsolatedWorld') {
      return page.noWorld ? {} : { executionContextId: WORLD_CONTEXT }
    }
    if (method === 'Runtime.evaluate') {
      if (page.throws) return { exceptionDetails: { text: 'Uncaught TypeError: nope' } }
      return {
        result: {
          value: {
            found: !page.missing,
            text: page.missing ? '' : (page.text ?? 'hello page'),
            url: page.url ?? 'https://example.com/',
            title: page.title ?? 'Example',
            // Defaults match a healthy ordinary page: a known-good status and
            // nothing lost, so a test that cares about either says so.
            status: page.status === undefined ? 200 : page.status,
            dropped: page.dropped === undefined ? { generated: 0, capped: false } : page.dropped,
            matched: page.matched === undefined ? null : page.matched,
            matchCount: page.matchCount === undefined ? null : page.matchCount,
          },
        },
      }
    }
    return {}
  })
  ;(chrome.debugger.sendCommand as unknown) = sendCommand
  return sendCommand
}

function evaluates(mock: ReturnType<typeof installCdpMock>) {
  return mock.mock.calls.filter((c) => c[1] === 'Runtime.evaluate')
}

describe('execExtractText', () => {
  it('refuses without a tab_id before touching the browser', async () => {
    const mock = installCdpMock()

    const result = await execExtractText({})

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/tab_id/)
    expect(mock).not.toHaveBeenCalled()
  })

  it('reads in the isolated probe world, never in the page world', async () => {
    // A main-world read is steerable: the page overrides querySelector or
    // innerText and picks what the model believes it says, and the url and
    // title it hands back render OUTSIDE the untrusted fence. This was the
    // last main-world read left after the hostile-page pass (#160).
    const mock = installCdpMock({ text: 'real text', url: 'https://shop.test/cart', title: 'Cart' })

    const result = await execExtractText({ tab_id: TAB })

    expect(result.ok).toBe(true)
    const data = result.data as { text: string; url: string; title: string }
    expect(data.text).toBe('real text')
    expect(data.url).toBe('https://shop.test/cart')
    expect(data.title).toBe('Cart')
    const calls = evaluates(mock)
    expect(calls).toHaveLength(1)
    expect(
      (calls[0][2] as { contextId?: number }).contextId,
      'the read must run in the created isolated world',
    ).toBe(WORLD_CONTEXT)
    expect(mock.mock.calls.some((c) => c[1] === 'Page.createIsolatedWorld')).toBe(true)
  })

  it('fails closed when no isolated world can be had, with no page-world retry', async () => {
    const mock = installCdpMock({ noWorld: true })

    const result = await execExtractText({ tab_id: TAB })

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/isolated inspection context/)
    expect(evaluates(mock), 'a fallback read would reinstate the vulnerability').toHaveLength(0)
  })

  it('reports a read that threw as a failed read, not as an empty page', async () => {
    // An exception means we learned NOTHING about the page. Reporting it as
    // "no readable body" told the agent the page was empty, which is a
    // different fact and sends it off to reload or give up.
    const mock = installCdpMock({ throws: true })

    const result = await execExtractText({ tab_id: TAB })

    expect(result.ok).toBe(false)
    expect(result.error).not.toMatch(/no readable body/)
    expect(result.error).toMatch(/read failed/)
    expect(evaluates(mock)).toHaveLength(1)
  })

  it('still tells an empty page from a selector that matched nothing', async () => {
    installCdpMock({ missing: true })

    const empty = await execExtractText({ tab_id: TAB })
    const miss = await execExtractText({ tab_id: TAB, selector: '#nope' })

    expect(empty.error).toBe('page has no readable body')
    expect(miss.error).toContain('selector matched no element: #nope')
  })

  it('names the read/act selector asymmetry on a miss instead of just "no element"', async () => {
    // The act path's css= resolution walks open shadow roots and this read
    // does not, so the same selector can act and then fail to read. Unnamed,
    // that reads as "the element is not there" and starts an investigation
    // into the page. The stopgap goes when the alignment pass extends the
    // walk to the read path.
    installCdpMock({ missing: true })

    const miss = await execExtractText({ tab_id: TAB, selector: 'my-widget >>> #total' })

    expect(miss.error).toMatch(/shadow root/i)
    // And it routes to what does work today rather than only diagnosing.
    expect(miss.error).toMatch(/chrome_read_page|css=/)
    // The empty-page answer is untouched: this is about selectors only.
    const empty = await execExtractText({ tab_id: TAB })
    expect(empty.error).not.toMatch(/shadow root/i)
  })

  it('carries the selector as a literal, so a quoted selector cannot break the read', async () => {
    const mock = installCdpMock({ text: 'quoted' })
    const selector = 'a[title="it\'s here"]'

    const result = await execExtractText({ tab_id: TAB, selector })

    expect(result.ok).toBe(true)
    const expression = String((evaluates(mock)[0][2] as { expression: string }).expression)
    expect(expression).toContain(JSON.stringify(selector))
    // Parse-only: a naively interpolated selector makes this a SyntaxError.
    expect(() => new Function(`return (${expression})`)).not.toThrow()
  })

  it('never looks a built-in up on the object it is reading', async () => {
    // Named DOM properties are real DOM and follow the read into the isolated
    // world: `<img name="body">` shadows document.body, and an
    // `<input name="innerText">` inside a form shadows that element's own
    // accessor. Prototype descriptors are the one lookup a page cannot reach
    // (worlds.ts's probe-body rule).
    const mock = installCdpMock({ text: 'x' })

    await execExtractText({ tab_id: TAB, selector: '#main' })

    const expression = String((evaluates(mock)[0][2] as { expression: string }).expression)
    expect(expression).toContain('Object.getOwnPropertyDescriptor')
    expect(expression).toContain('Document.prototype.querySelector.call')
    expect(expression).not.toMatch(/document\.body/)
    expect(expression).not.toMatch(/document\.title/)
    expect(expression).not.toMatch(/root\.innerText/)
  })

  it('truncates at max_chars, and defaults to 50k when it is absent', async () => {
    installCdpMock({ text: 'x'.repeat(50_001) })

    const capped = await execExtractText({ tab_id: TAB, max_chars: 50 })
    const defaulted = await execExtractText({ tab_id: TAB })

    const cappedData = capped.data as { text: string; truncated: boolean }
    expect(cappedData.text).toHaveLength(50)
    expect(cappedData.truncated).toBe(true)
    const defaultedData = defaulted.data as { text: string; truncated: boolean }
    expect(defaultedData.text).toHaveLength(50_000)
    expect(defaultedData.truncated).toBe(true)
  })

  it('leaves a page under the cap whole and unflagged', async () => {
    installCdpMock({ text: 'short enough' })

    const result = await execExtractText({ tab_id: TAB })

    const data = result.data as { text: string; truncated: boolean }
    expect(data.text).toBe('short enough')
    expect(data.truncated).toBe(false)
  })

  it('carries the status the document itself reports, in ONE evaluation with the text', async () => {
    // One evaluation so the status and the text describe the same document at
    // the same instant: a second round trip could straddle a navigation and
    // attribute one document's status to another's text (#187).
    const mock = installCdpMock({ text: 'Order 8812 delivered', status: 404 })

    const result = await execExtractText({ tab_id: TAB })

    expect((result.data as { http_status?: number }).http_status).toBe(404)
    expect(evaluates(mock)).toHaveLength(1)
  })

  it('omits the status entirely when the document could not answer one', async () => {
    // Absent means UNKNOWN. A page with no navigation entry, an old Chrome
    // without responseStatus, and the spec's own 0 must all read the same:
    // nothing, never a claim that the load was fine.
    for (const status of [null, 0]) {
      installCdpMock({ text: 'page', status })

      const result = await execExtractText({ tab_id: TAB })

      expect(Object.keys(result.data as object)).not.toContain('http_status')
    }
  })

  it('reports how much meaning the text could not carry', async () => {
    installCdpMock({ text: '1.\nf6\n2.\ne4', dropped: { generated: 3, capped: false } })

    const result = await execExtractText({ tab_id: TAB })

    const data = result.data as Record<string, unknown>
    expect(data.text_dropped_generated).toBe(3)
    expect(data.text_dropped_capped).toBeUndefined()
  })

  it('flags a capped scan, so the count reads as a floor', async () => {
    installCdpMock({ text: 'huge page', dropped: { generated: 12, capped: true } })

    const data = (await execExtractText({ tab_id: TAB })).data as Record<string, unknown>

    expect(data.text_dropped_generated).toBe(12)
    expect(data.text_dropped_capped).toBe(true)
  })

  it('ships no loss keys at all when nothing was lost', async () => {
    // An ordinary prose page must pay neither the payload nor the sentence:
    // measured 0 on example.com, Hacker News and BBC News, so silence here is
    // the common case and the note stays worth reading.
    installCdpMock({ text: 'just prose', dropped: { generated: 0, capped: true } })

    const keys = Object.keys((await execExtractText({ tab_id: TAB })).data as object)

    expect(keys).not.toContain('text_dropped_generated')
    expect(keys, 'a cap flag alone would render a hedge about nothing').not.toContain(
      'text_dropped_capped',
    )
  })

  it('says nothing about loss when the scan itself could not run', async () => {
    installCdpMock({ text: 'page', dropped: null })

    const keys = Object.keys((await execExtractText({ tab_id: TAB })).data as object)

    expect(keys).not.toContain('text_dropped_generated')
  })

  it('never looks the style engine up bare either', async () => {
    // Same rule as the DOM accessors above, and the same reason: a named
    // element can shadow a global through the WindowProperties object, so the
    // scan reads getComputedStyle through the own-descriptor helper.
    const mock = installCdpMock({ text: 'x' })

    await execExtractText({ tab_id: TAB })

    const expression = String((evaluates(mock)[0][2] as { expression: string }).expression)
    expect(expression).toContain("nymGlobal('getComputedStyle')")
    expect(expression, 'a bare call is the shadowable one').not.toMatch(/[^'"]getComputedStyle\(/)
  })
})

describe('the selector count and identity on the payload', () => {
  it('carries how many the selector matched, under the tree read\'s own key', async () => {
    installCdpMock({ matchCount: 30 })

    const result = await execExtractText({ tab_id: TAB, selector: '.athing' })

    expect((result.data as { scope_match_count?: number }).scope_match_count).toBe(30)
  })

  it('ships no count for a whole-page read', async () => {
    installCdpMock({ matchCount: null })

    const result = await execExtractText({ tab_id: TAB })

    expect('scope_match_count' in (result.data as Record<string, unknown>)).toBe(false)
  })

  it('ships no identity when the read root satisfied no candidate', async () => {
    installCdpMock({ matched: null })

    const result = await execExtractText({ tab_id: TAB, selector: '.a' })

    expect('selector_matched' in (result.data as Record<string, unknown>)).toBe(false)
  })

  it('carries the identity when there was one', async () => {
    installCdpMock({ matched: '.move-list' })

    const result = await execExtractText({ tab_id: TAB, selector: '.a, .move-list' })

    expect((result.data as { selector_matched?: string }).selector_matched).toBe('.move-list')
  })
})

describe('the text-loss scan (executed in-page)', () => {
  /**
   * happy-dom has no pseudo-element style engine, so the scan's INPUT is
   * staged and its FILTER is what these tests exercise. The value shapes come
   * from a real headless Chrome (2026-08-19): a literal string comes back
   * QUOTED, `attr()` is resolved into the quoted string, `counter()` is left
   * unresolved, `url()` stays a url, and an absent pseudo answers `none`.
   */
  let savedGcs: PropertyDescriptor | undefined

  beforeEach(() => {
    document.body.innerHTML = ''
    savedGcs = Object.getOwnPropertyDescriptor(globalThis, 'getComputedStyle')
    Object.defineProperty(globalThis, 'getComputedStyle', {
      value: (el: Element, pseudo?: string) => ({
        content: el.getAttribute(pseudo === '::after' ? 'data-after' : 'data-before') ?? 'none',
        // The pseudo-element's OWN box, which the real API also returns here.
        display: el.getAttribute('data-pseudo-display') ?? 'inline',
        visibility: el.getAttribute('data-pseudo-visibility') ?? 'visible',
      }),
      configurable: true,
      writable: true,
    })
  })

  afterEach(() => {
    if (savedGcs) Object.defineProperty(globalThis, 'getComputedStyle', savedGcs)
  })

  const scan = (root: Element): { generated: number; capped: boolean } =>
    (
      new Function(`${__test.TEXT_DROPPED_SNIPPET} return nymTextDropped(arguments[0])`) as (
        r: Element,
      ) => { generated: number; capped: boolean }
    )(root)

  const rootWith = (html: string): Element => {
    document.body.innerHTML = `<div id="root">${html}</div>`
    return document.querySelector('#root') as Element
  }

  it('counts only what is INSIDE the read root, so a scope localises the loss', () => {
    // The tools promise this: the count describes THIS read, so re-reading one
    // region tells you whether the loss was in the part you care about. It is
    // the route that replaced #215's nearest-id'd-ancestor idea, which
    // measured useless on app-shaped pages, so the promise needs a test.
    document.body.innerHTML =
      '<div id="wanted"><span data-before=\'"\u2658"\'>f6</span></div>' +
      '<div id="furniture">' +
      '<span data-before=\'"\u2659"\'>a</span><span data-before=\'"\u2659"\'>b</span>' +
      '</div>'

    const wanted = scan(document.querySelector('#wanted') as Element)
    const furniture = scan(document.querySelector('#furniture') as Element)
    const whole = scan(document.body)

    expect(wanted.generated).toBe(1)
    expect(furniture.generated).toBe(2)
    expect(whole.generated, 'and the parts compose into the page total').toBe(3)
  })

  it('counts a glyph the text read cannot see', () => {
    // The measured case: chess.com draws the piece letter as generated
    // content, so `innerText` keeps "f6" and loses the knight entirely.
    const root = rootWith('<span data-before=\'"♘"\'>f6</span>')

    expect(scan(root).generated).toBe(1)
  })

  it('counts ::after as well as ::before', () => {
    const root = rootWith('<span data-after=\'"END"\'>body</span>')

    expect(scan(root).generated).toBe(1)
  })

  it('counts a counter, which is real text the read still loses', () => {
    const root = rootWith('<li data-before="counter(step)">first</li>')

    expect(scan(root).generated).toBe(1)
  })

  it('ignores the decoration that is not content', () => {
    // Empty and whitespace-only content are layout hacks (clearfix), and a
    // url() is an image rather than lost TEXT. The loose version of this
    // filter counted 1,102 on one Wikipedia article; the strict one counted 1.
    const root = rootWith(
      '<span data-before=\'""\'>a</span>' +
        '<span data-before=\'" "\'>b</span>' +
        '<span data-before=\'url("data:image/gif;base64,R0lGODlh")\'>c</span>' +
        '<span data-before="none">d</span>' +
        '<span data-before="normal">e</span>' +
        '<span>f</span>',
    )

    expect(scan(root).generated).toBe(0)
  })

  it('ignores an <image> value, whose quoted string is a FILENAME', () => {
    // `content` takes any <image>, and `image-set()` is the standard retina
    // icon idiom. Matching quotes anywhere would count the filename as lost
    // text and reintroduce exactly the images-are-not-text noise the count
    // was measured to avoid (review round).
    const root = rootWith(
      '<span data-before=\'image-set(url("a.png") 1x, url("a@2x.png") 2x)\'>a</span>' +
        '<span data-before="linear-gradient(red, blue)">b</span>' +
        '<span data-before="no-open-quote">c</span>' +
        '<span data-before=\'url("x.png") " "\'>d</span>',
    )

    expect(scan(root).generated).toBe(0)
  })

  it('still counts real text beside an image, and a literal with parentheses', () => {
    const root = rootWith(
      '<span data-before=\'url("x.png") "END"\'>a</span>' + '<span data-before=\'"(1)"\'>b</span>',
    )

    expect(scan(root).generated).toBe(2)
  })

  it('does not count a pseudo-element that renders nothing', () => {
    // `.tip::after { content: attr(data-tip); display: none }` is the ordinary
    // tooltip idiom: the content string is real and nothing is drawn, so
    // nothing was lost. The pseudo's own computed style is already in hand.
    const root = rootWith(
      '<span data-before=\'"HIDDEN"\' data-pseudo-display="none">a</span>' +
        '<span data-before=\'"ALSO"\' data-pseudo-visibility="hidden">b</span>' +
        '<span data-before=\'"SHOWN"\'>c</span>',
    )

    expect(scan(root).generated).toBe(1)
  })

  it('counts decoration on a faded element, because innerText keeps its text', () => {
    // Measured: innerText returns the text of an `opacity: 0` element (only
    // display:none and visibility:hidden are dropped), so a glyph there is
    // lost exactly like any other. Gating on checkOpacity would skip it.
    const root = rootWith('<span style="opacity:0" data-before=\'"FADED"\'>a</span>')

    expect(scan(root).generated).toBe(1)
  })

  it('does not count decoration on hidden elements', () => {
    // Measured: `display:none` and `visibility:hidden` elements STILL report
    // their generated content. innerText already excludes them, so counting
    // them would inflate the loss with content the read never owed.
    const root = rootWith(
      '<span style="display:none" data-before=\'"HIDDEN"\'>a</span>' +
        '<span data-before=\'"SHOWN"\'>b</span>',
    )

    expect(scan(root).generated).toBe(1)
  })

  it('counts only inside the read root', () => {
    document.body.innerHTML =
      '<div id="root"><span data-before=\'"IN"\'>a</span></div>' +
      '<div id="outside"><span data-before=\'"OUT"\'>b</span></div>'

    expect(scan(document.querySelector('#root') as Element).generated).toBe(1)
  })

  it('counts the read root itself, not only its descendants', () => {
    // `querySelectorAll` returns DESCENDANTS only, so a scoped read of
    // `#price` whose own ::before draws the currency symbol saw nothing at
    // all: the narrowest read shape, and the one an agent trusts most.
    document.body.innerHTML = '<div id="root" data-before=\'"$"\'>42.00</div>'

    expect(scan(document.querySelector('#root') as Element).generated).toBe(1)
  })

  it('stops at the element cap and says so, rather than undercounting in silence', () => {
    const cap = __test.TEXT_SCAN_CAP
    const root = rootWith('<span data-before=\'"g"\'>x</span>'.repeat(cap))

    const result = scan(root)

    // cap + 1 elements in scope (the root plus its `cap` children), so the
    // walk stops one short of the children: the root occupies the first slot
    // and carries no generated content of its own.
    expect(result.generated, 'the walk stops exactly at the cap').toBe(cap - 1)
    expect(result.capped).toBe(true)
  })

  it('does not flag a cap it never hit', () => {
    const root = rootWith('<span data-before=\'"g"\'>x</span>')

    expect(scan(root).capped).toBe(false)
  })
})
