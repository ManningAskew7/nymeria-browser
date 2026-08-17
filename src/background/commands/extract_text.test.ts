import { beforeEach, describe, expect, it, vi } from 'vitest'
import { execExtractText } from './extract_text'
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
})
