import { beforeEach, describe, expect, it, vi } from 'vitest'
import { __test, execSnapshot } from './snapshot'
import * as snapshotRefs from '../snapshotRefs'
import { resetForTests as resetDebugger } from '../debuggerSession'
import { installNavWatch, resetForTests as resetNavWatch } from '../navWatch'
import { resetForTests as resetWorlds } from '../worlds'

const { formatTree } = __test

beforeEach(() => {
  // Full reset: counters are per-tab module state that would otherwise leak
  // monotonic numbering across tests, and the debugger/worlds caches would
  // leak sessions and execution-context ids the same way.
  snapshotRefs.resetForTests()
  resetDebugger()
  resetWorlds()
  resetNavWatch()
})

function av(value: unknown): { value: unknown } {
  return { value }
}

describe('formatTree', () => {
  it('renders a tree of interactive elements with @e refs', () => {
    const nodes = [
      { nodeId: '1', role: av('RootWebArea'), name: av('Test page'), childIds: ['2', '3'] },
      {
        nodeId: '2',
        role: av('button'),
        name: av('Submit'),
        backendDOMNodeId: 100,
        parentId: '1',
      },
      {
        nodeId: '3',
        role: av('textbox'),
        name: av('Email'),
        backendDOMNodeId: 200,
        parentId: '1',
      },
    ]
    const { text, refs } = formatTree(nodes, ['1'], 'interactive')
    expect(text).toMatch(/RootWebArea "Test page"/)
    expect(text).toMatch(/button "Submit" \[ref=@e1\]/)
    expect(text).toMatch(/textbox "Email" \[ref=@e2\]/)
    // The mint-time fingerprint (role + normalized name) rides along, so the
    // act layer can refuse a live node whose meaning changed since this read.
    // STRICT equality on the full RefTarget shape: the previous loose compare
    // asserted a `sessionId` field that had not existed since the target-id
    // rework and could not have caught a wrong frame provenance either.
    expect(refs.get('e1')).toStrictEqual({
      backendNodeId: 100,
      frameTargetId: undefined,
      frameUrl: undefined,
      role: 'button',
      name: 'Submit',
    })
    expect(refs.get('e2')).toStrictEqual({
      backendNodeId: 200,
      frameTargetId: undefined,
      frameUrl: undefined,
      role: 'textbox',
      name: 'Email',
    })
  })

  it('skips ignored nodes', () => {
    const nodes = [
      { nodeId: '1', role: av('RootWebArea'), name: av('root'), childIds: ['2'] },
      { nodeId: '2', role: av('button'), name: av('hidden'), backendDOMNodeId: 5, parentId: '1', ignored: true },
    ]
    const { text, refs } = formatTree(nodes, ['1'], 'interactive')
    expect(text).not.toMatch(/hidden/)
    expect(refs.size).toBe(0)
  })

  it('detail=minimal drops structural nodes that are not interactive or headings', () => {
    const nodes = [
      { nodeId: '1', role: av('RootWebArea'), name: av('root'), childIds: ['2', '3'] },
      { nodeId: '2', role: av('paragraph'), name: av('blah'), parentId: '1' },
      { nodeId: '3', role: av('button'), name: av('Go'), backendDOMNodeId: 9, parentId: '1' },
    ]
    const { text, refs } = formatTree(nodes, ['1'], 'minimal')
    expect(text).not.toMatch(/paragraph/)
    expect(text).toMatch(/button "Go"/)
    expect(refs.size).toBe(1)
  })

  it('detail=full keeps every non-ignored node', () => {
    const nodes = [
      { nodeId: '1', role: av('RootWebArea'), name: av('root'), childIds: ['2'] },
      { nodeId: '2', role: av('paragraph'), name: av('lorem'), parentId: '1' },
    ]
    const { text } = formatTree(nodes, ['1'], 'full')
    expect(text).toMatch(/paragraph "lorem"/)
  })
})

describe('execSnapshot', () => {
  it('stores refs in the per-tab cache for later chrome_act lookups', async () => {
    const nodes = [
      { nodeId: '1', role: av('RootWebArea'), name: av('root'), childIds: ['2'] },
      { nodeId: '2', role: av('link'), name: av('Click me'), backendDOMNodeId: 42, parentId: '1' },
    ]
    chrome.debugger.sendCommand = (async () => ({ nodes })) as unknown as typeof chrome.debugger.sendCommand
    const result = await execSnapshot({ tab_id: 1, detail: 'interactive' })
    expect(result.ok).toBe(true)
    expect(snapshotRefs.size(1)).toBe(1)
    const resolution = snapshotRefs.resolve(1, '@e1')
    expect(resolution.ok).toBe(true)
    if (resolution.ok) expect(resolution.backendNodeId).toBe(42)
    // The URL the refs were minted on is recorded, so a later navigation can
    // be detected rather than silently resolving into a different document.
    expect(snapshotRefs.snapshotUrl(1)).toBe('https://example.com')
  })

  it('returns ok:false with a clear error when tab_id is missing', async () => {
    const result = await execSnapshot({})
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/tab_id/)
  })

  // #208. Chrome marks every document focusable, so a document root mints a
  // ref through the property path even on a page with nothing to click. A
  // ref count alone therefore looks healthy on an all-static page, which is
  // exactly how a live round twice read the mint rule as a minting bug.
  const focusable = [{ name: 'focusable', value: { value: true } }]

  it('counts document-root refs apart from control refs on an all-static page', async () => {
    const nodes = [
      {
        nodeId: '1',
        role: av('RootWebArea'),
        name: av('Static page'),
        backendDOMNodeId: 1,
        properties: focusable,
        childIds: ['2'],
      },
      { nodeId: '2', role: av('listitem'), name: av(''), backendDOMNodeId: 7, parentId: '1' },
    ]
    chrome.debugger.sendCommand = (async () => ({ nodes })) as unknown as typeof chrome.debugger.sendCommand

    const result = await execSnapshot({ tab_id: 1, detail: 'interactive' })

    const data = (result as { data: Record<string, unknown> }).data
    expect(data.ref_count).toBe(1)
    // The honest number: nothing on this page can be clicked or typed into.
    expect(data.control_ref_count).toBe(0)
  })

  it('counts a real control, so an ordinary page carries no zero', async () => {
    const nodes = [
      {
        nodeId: '1',
        role: av('RootWebArea'),
        name: av('Ordinary page'),
        backendDOMNodeId: 1,
        properties: focusable,
        childIds: ['2'],
      },
      { nodeId: '2', role: av('link'), name: av('Learn more'), backendDOMNodeId: 42, parentId: '1' },
    ]
    chrome.debugger.sendCommand = (async () => ({ nodes })) as unknown as typeof chrome.debugger.sendCommand

    const result = await execSnapshot({ tab_id: 1, detail: 'interactive' })

    const data = (result as { data: Record<string, unknown> }).data
    expect(data.ref_count).toBe(2)
    expect(data.control_ref_count).toBe(1)
  })
})

describe('monotonic minting at the exec level (#160)', () => {
  const interactiveNodes = [
    { nodeId: '1', role: av('RootWebArea'), name: av('root'), childIds: ['2', '3'] },
    { nodeId: '2', role: av('link'), name: av('Click me'), backendDOMNodeId: 42, parentId: '1' },
    { nodeId: '3', role: av('button'), name: av('Go'), backendDOMNodeId: 43, parentId: '1' },
  ]

  function installTreeMock(): void {
    chrome.debugger.sendCommand = (async () => ({
      nodes: interactiveNodes,
    })) as unknown as typeof chrome.debugger.sendCommand
  }

  it('a second read continues numbering, and refs from the first read stay valid', async () => {
    installTreeMock()

    const first = await execSnapshot({ tab_id: 1, detail: 'interactive' })
    const second = await execSnapshot({ tab_id: 1, detail: 'interactive' })

    expect((first.data as { tree: string }).tree).toMatch(/\[ref=@e1\]/)
    // The re-read mints FRESH numbers rather than renumbering from e1: a held
    // @e1 can therefore never silently mean a different element.
    expect((second.data as { tree: string }).tree).toMatch(/\[ref=@e3\]/)
    expect((second.data as { tree: string }).tree).not.toMatch(/\[ref=@e1\]/)
    // Merge: the FIRST read's refs still resolve after the second.
    expect(snapshotRefs.resolve(1, '@e1', 'https://example.com')).toMatchObject({
      ok: true,
      backendNodeId: 42,
    })
    expect(snapshotRefs.resolve(1, '@e3', 'https://example.com')).toMatchObject({
      ok: true,
      backendNodeId: 42,
    })
  })

  it('numbering resumes from storage.session after a worker recycle', async () => {
    installTreeMock()
    await chrome.storage.session.set({ 'nymRefCounter:1': 40 })
    // The recycle: module memory gone, storage.session intact.
    snapshotRefs.resetForTests()

    const result = await execSnapshot({ tab_id: 1, detail: 'interactive' })

    expect((result.data as { tree: string }).tree).toMatch(/\[ref=@e41\]/)
  })

  it('the reuse arg is dead: a stray reuse:true still performs a fresh read', async () => {
    installTreeMock()
    await execSnapshot({ tab_id: 1, detail: 'interactive' })

    const result = await execSnapshot({ tab_id: 1, detail: 'interactive', reuse: true })

    expect(result.ok).toBe(true)
    expect((result.data as { reused?: boolean }).reused).toBeUndefined()
    expect((result.data as { tree: string }).tree).toMatch(/\[ref=@e3\]/)
  })

  /**
   * Stage a selector scope end to end: the COUNT evaluate, then the node
   * evaluate, then describeNode, then the tree. `count` is what
   * `querySelectorAll(...).length` answers; `resolves` is whether the
   * follow-up `querySelector` still finds it.
   */
  function installScopeMock(count: number, opts: { resolves?: boolean } = {}): string[] {
    const seen: string[] = []
    chrome.debugger.sendCommand = (async (_t: unknown, method: string, params?: unknown) => {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame-root' } } }
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 5 }
      if (method === 'Runtime.evaluate') {
        const expression = (params as { expression: string }).expression
        seen.push(expression)
        if (expression.includes('querySelectorAll')) return { result: { value: count } }
        return opts.resolves === false
          ? { result: { subtype: 'null' } }
          : { result: { objectId: 'node-obj' } }
      }
      if (method === 'DOM.describeNode') return { node: { backendNodeId: 42 } }
      return { nodes: interactiveNodes }
    }) as unknown as typeof chrome.debugger.sendCommand
    return seen
  }

  it('a scope selector reports how many elements it matched', async () => {
    // A selector names a RULE, not an element. `.comment` on a 40-comment
    // thread resolves to ONE comment, and a read's answer looks like the
    // whole of what was asked for, so the model reasons over that subtree AS
    // the region. The act path already reports its match count for this
    // reason (review round).
    installScopeMock(40)

    const result = await execSnapshot({ tab_id: 1, scope_selector: '.comment' })

    expect(result.ok).toBe(true)
    expect((result.data as { scope_match_count?: number }).scope_match_count).toBe(40)
  })

  it('a ref scope reports no match count, because it names one element', async () => {
    installTreeMock()
    await execSnapshot({ tab_id: 1, detail: 'interactive' })

    const scoped = await execSnapshot({ tab_id: 1, scope_ref: '@e1' })

    expect((scoped.data as { scope_match_count?: number }).scope_match_count).toBeUndefined()
  })

  it('a scoped read counts the CONTROLS in its own subtree', async () => {
    // Withheld before: the backend's only copy made a page-level claim a
    // subtree cannot support. But scoping to a static region is the flagship
    // reason to scope, and withholding it there left that read answering
    // "0 actionable elements" with no explanation, which is the #205 loop the
    // count exists to close (review round).
    installScopeMock(1)

    const result = await execSnapshot({ tab_id: 1, scope_selector: '#region' })

    expect((result.data as { control_ref_count?: number }).control_ref_count).toBeDefined()
  })

  it('a scoped read still withholds the page frame inventory', async () => {
    // Unchanged by the control-count decision: frame counts describe sections
    // this tree deliberately does not render.
    installScopeMock(1)

    const result = await execSnapshot({ tab_id: 1, scope_selector: '#region' })

    expect((result.data as { frames_oopif?: number }).frames_oopif).toBeUndefined()
  })

  it('a scope that matches nothing names both limits of a scope, and stops early', async () => {
    // The backend used to append this, keyed only on "we sent a selector", so
    // it lectured about shadow roots at a typo and at a mid-navigation miss
    // too. It belongs at the one error it explains, the way extract_text's
    // own selector miss already carries its asymmetry (review round).
    const seen = installScopeMock(0)

    const result = await execSnapshot({ tab_id: 1, scope_selector: '#summary' })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('matched no element: #summary')
    expect(result.error).toContain('TOP document')
    expect(result.error).toContain('shadow roots')
    expect(result.error).toContain('unscoped')
    expect(seen.some((e) => e.includes('querySelectorAll'))).toBe(true)
    expect(seen.some((e) => !e.includes('querySelectorAll'))).toBe(false)
  })

  it('an element that vanishes between the count and the resolve says so', async () => {
    installScopeMock(1, { resolves: false })

    const result = await execSnapshot({ tab_id: 1, scope_selector: '#gone' })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('went away mid-read')
    expect(result.error, 'not the no-match copy: it DID match').not.toContain('matched no element')
  })

  it('names a malformed scope selector instead of resolving the Error it threw', async () => {
    // A thrown expression still returns a `result`: the Error OBJECT, with a
    // perfectly usable objectId. It reached `DOM.describeNode`, produced no
    // backendNodeId, and surfaced three lines later as "could not resolve
    // the scope element", which reads as a page problem rather than as the
    // syntax error it is.
    chrome.debugger.sendCommand = (async (_t: unknown, method: string) => {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame-root' } } }
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 5 }
      if (method === 'Runtime.evaluate') {
        return {
          result: { objectId: 'error-obj', subtype: 'error', className: 'SyntaxError' },
          exceptionDetails: { text: 'Uncaught', exceptionId: 1 },
        }
      }
      return { nodes: interactiveNodes }
    }) as unknown as typeof chrome.debugger.sendCommand

    const result = await execSnapshot({ tab_id: 1, scope_selector: 'div:::broken' })

    expect(result.ok).toBe(false)
    expect(result.error).toBe('not a valid CSS selector: div:::broken')
  })

  it('a scoped read merges its refs instead of discarding the full-page map', async () => {
    installTreeMock()
    await execSnapshot({ tab_id: 1, detail: 'interactive' })

    const scoped = await execSnapshot({ tab_id: 1, detail: 'interactive', scope_ref: '@e1' })

    expect(scoped.ok).toBe(true)
    // The full read's OTHER ref survives the scoped read.
    expect(snapshotRefs.resolve(1, '@e2', 'https://example.com')).toMatchObject({
      ok: true,
      backendNodeId: 43,
    })
    // And the scoped read's fresh ref resolves too.
    expect((scoped.data as { tree: string }).tree).toMatch(/\[ref=@e3\]/)
    expect(snapshotRefs.resolve(1, '@e3', 'https://example.com')).toMatchObject({ ok: true })
  })

  it('a scoped read counts the controls in its OWN subtree, not the page\'s', async () => {
    // #208 withheld this on a scoped read, because the backend's only copy
    // ("this page has no controls") is a page claim a subtree cannot support.
    // #212 made scoping to a STATIC region the flagship route, where the
    // count is always zero and its absence left the read saying "0 actionable
    // elements" with nothing to explain it: the #205 loop, reachable again
    // through the newly recommended parameter. So the count ships and the
    // backend picks region-shaped copy when it was the one that scoped.
    installTreeMock()

    const full = await execSnapshot({ tab_id: 1, detail: 'interactive' })
    const scoped = await execSnapshot({ tab_id: 1, detail: 'interactive', scope_ref: '@e1' })

    expect((full.data as Record<string, unknown>).control_ref_count).toBe(2)
    // Its own subtree's answer, which here is the one control it was rooted at.
    expect((scoped.data as Record<string, unknown>).control_ref_count).toBe(1)
    // The FRAME counts stay withheld: those describe sections a scoped tree
    // deliberately does not render, so a subtree really cannot speak for them.
    expect('frames_oopif' in (scoped.data as Record<string, unknown>)).toBe(false)
  })
})

describe('formatTree hidden-drop provenance (R-02 completeness)', () => {
  it('counts content-hiding ignored reasons and excludes wrapper noise', () => {
    const nodes = [
      { nodeId: '1', role: av('RootWebArea'), name: av('root'), childIds: ['2', '3', '4'] },
      {
        nodeId: '2',
        role: av('generic'),
        name: av(''),
        parentId: '1',
        ignored: true,
        ignoredReasons: [{ name: 'uninteresting' }],
      },
      {
        nodeId: '3',
        role: av('region'),
        name: av('sidebar'),
        parentId: '1',
        ignored: true,
        ignoredReasons: [{ name: 'ariaHiddenSubtree' }],
      },
      {
        nodeId: '4',
        role: av('button'),
        name: av('Go'),
        backendDOMNodeId: 9,
        parentId: '1',
        ignored: true,
        ignoredReasons: [{ name: 'notVisible' }],
      },
    ]
    const { hiddenDropped } = formatTree(nodes, ['1'], 'interactive')
    // Wrapper divs are dropped-but-lossless (children still render); the
    // content-hiding reasons are the ones the payload must own up to.
    expect(hiddenDropped).toStrictEqual({ ariaHiddenSubtree: 1, notVisible: 1 })
  })
})

/**
 * Method-aware CDP mock for the same-process frame reads: `getFullAXTree`
 * answers per `frameId`, `Page.getFrameTree` serves a configurable local
 * tree, and the view-state probe's world machinery gets real-enough answers.
 */
interface FrameTreeFixture {
  frame: { id: string; url?: string }
  childFrames?: FrameTreeFixture[]
}

function installLocalFramesMock(cfg: {
  rootNodes: unknown[]
  frames?: Record<string, unknown[]>
  frameTree?: FrameTreeFixture
  viewState?: unknown
  viewStateThrows?: boolean
  /** What the document's own navigation timing entry answers (#187). */
  httpStatus?: number | null
  /** Fires when the status probe runs, for staging a mid-read navigation. */
  onDocStatusProbe?: () => void
}) {
  const mock = vi.fn(async (_target: unknown, method: string, params: Record<string, unknown> = {}) => {
    if (method === 'Accessibility.getFullAXTree') {
      const frameId = params.frameId as string | undefined
      return { nodes: frameId ? (cfg.frames?.[frameId] ?? []) : cfg.rootNodes }
    }
    if (method === 'Page.getFrameTree') {
      return { frameTree: cfg.frameTree ?? { frame: { id: 'ROOT-FRAME' } } }
    }
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 77 }
    if (method === 'Runtime.evaluate') {
      const expression = String(params.expression ?? '')
      if (expression.includes('fullscreenElement')) {
        if (cfg.viewStateThrows) return { exceptionDetails: { text: 'boom' } }
        return {
          result: {
            value: cfg.viewState ?? { modal_dialog: false, aria_modal: false, fullscreen: false },
          },
        }
      }
      if (expression.includes('nymDocStatus')) {
        cfg.onDocStatusProbe?.()
        return { result: { value: { http_status: cfg.httpStatus ?? null } } }
      }
      return { result: { value: undefined } }
    }
    return {}
  })
  ;(chrome.debugger.sendCommand as unknown) = mock
  return mock
}

const widgetFrameNodes = [
  { nodeId: 'f1', role: av('RootWebArea'), name: av('widget'), childIds: ['f2'] },
  { nodeId: 'f2', role: av('button'), name: av('Pay now'), backendDOMNodeId: 300, parentId: 'f1' },
]

describe('same-process frame reads (reads-honesty pass)', () => {
  const rootNodes = [
    { nodeId: '1', role: av('RootWebArea'), name: av('root'), childIds: ['2'] },
    { nodeId: '2', role: av('link'), name: av('Home'), backendDOMNodeId: 42, parentId: '1' },
  ]

  it("renders a same-origin iframe's content as a labelled section with actable refs", async () => {
    const mock = installLocalFramesMock({
      rootNodes,
      frameTree: {
        frame: { id: 'ROOT-FRAME' },
        childFrames: [{ frame: { id: 'LOCAL-1', url: 'https://example.com/widget' } }],
      },
      frames: { 'LOCAL-1': widgetFrameNodes },
    })

    const result = await execSnapshot({ tab_id: 1, detail: 'interactive' })

    expect(result.ok).toBe(true)
    const data = result.data as Record<string, unknown>
    const tree = data.tree as string
    expect(tree).toMatch(/- iframe "https:\/\/example\.com\/widget"/)
    expect(tree).toMatch(/button "Pay now" \[ref=@e2\]/)
    // The frame's tree was read BY frameId through the shared session.
    expect(
      mock.mock.calls.some(
        (c) =>
          c[1] === 'Accessibility.getFullAXTree' &&
          (c[2] as { frameId?: string })?.frameId === 'LOCAL-1',
      ),
    ).toBe(true)
    // The ref carries the frame token + mint URL, the act layer's provenance.
    const resolution = snapshotRefs.resolve(1, '@e2', 'https://example.com')
    expect(resolution).toMatchObject({
      ok: true,
      backendNodeId: 300,
      frameTargetId: 'LOCAL-1',
      frameUrl: 'https://example.com/widget',
    })
    // The honest frame split: the old single `frames` count is gone.
    expect(data.frames_same_process).toBe(1)
    expect(data.frames_oopif).toBe(0)
    expect(data.frames).toBeUndefined()
  })

  it('renders nested same-process frames in document order, indented under their parent', async () => {
    installLocalFramesMock({
      rootNodes,
      frameTree: {
        frame: { id: 'ROOT-FRAME' },
        childFrames: [
          {
            frame: { id: 'LOCAL-A', url: 'https://example.com/outer' },
            childFrames: [{ frame: { id: 'LOCAL-B', url: 'https://example.com/inner' } }],
          },
        ],
      },
      frames: {
        'LOCAL-A': widgetFrameNodes,
        'LOCAL-B': [
          { nodeId: 'g1', role: av('RootWebArea'), name: av('inner'), childIds: ['g2'] },
          { nodeId: 'g2', role: av('textbox'), name: av('Name'), backendDOMNodeId: 400, parentId: 'g1' },
        ],
      },
    })

    const result = await execSnapshot({ tab_id: 1, detail: 'interactive' })

    const tree = (result.data as { tree: string }).tree
    const outerAt = tree.indexOf('iframe "https://example.com/outer"')
    const innerAt = tree.indexOf('iframe "https://example.com/inner"')
    expect(outerAt).toBeGreaterThan(-1)
    expect(innerAt).toBeGreaterThan(outerAt)
    // Containment is visible (QA round 1): the outer section sits at the
    // margin, the nested one indents a level, and its BODY indents with it.
    expect(tree).toMatch(/\n- iframe "https:\/\/example\.com\/outer"/)
    expect(tree).toMatch(/\n {2}- iframe "https:\/\/example\.com\/inner"/)
    expect(tree).toMatch(/\n {6}- textbox "Name"/)
    const data = result.data as { frames_same_process: number; frames_nested?: number }
    expect(data.frames_same_process).toBe(2)
    // The note counts nesting the same way the tree renders it: one of the
    // two sections lives inside the other, and a flat count beside an
    // indented tree is the disagreement this closes.
    expect(data.frames_nested).toBe(1)
  })

  it('caps the frames read and says how many were skipped, never silence', async () => {
    const childFrames = Array.from({ length: 10 }, (_, i) => ({
      frame: { id: `LOCAL-${i}`, url: `https://example.com/f${i}` },
    }))
    const frames = Object.fromEntries(
      childFrames.map((_c, i) => [
        `LOCAL-${i}`,
        [
          { nodeId: 'x1', role: av('RootWebArea'), name: av(`f${i}`), childIds: ['x2'] },
          { nodeId: 'x2', role: av('button'), name: av(`B${i}`), backendDOMNodeId: 500 + i, parentId: 'x1' },
        ],
      ]),
    )
    installLocalFramesMock({
      rootNodes,
      frameTree: { frame: { id: 'ROOT-FRAME' }, childFrames },
      frames,
    })

    const result = await execSnapshot({ tab_id: 1, detail: 'interactive' })

    const data = result.data as Record<string, unknown>
    const tree = data.tree as string
    expect(tree).toMatch(/iframe "https:\/\/example\.com\/f7"/)
    expect(tree).not.toMatch(/iframe "https:\/\/example\.com\/f8"/)
    // Not "in this document": the sweep is a flattened walk of every
    // same-process descendant, so the skipped frames need not be siblings.
    expect(tree).toMatch(/2 more frame\(s\) not read: frame cap reached/)
    // The count is frames RENDERED, never frames discovered: 8 read + 2
    // skipped, and the two must not double-count (review round: "10
    // included, 2 more not read" claimed twelve frames on a ten-frame page).
    expect(data.frames_same_process).toBe(8)
    expect(data.frames_skipped).toBe(2)
  })

  it('reports the view constraint when a modal context is up, and stays silent otherwise', async () => {
    installLocalFramesMock({
      rootNodes,
      viewState: { modal_dialog: true, aria_modal: false, fullscreen: false },
    })
    const constrained = await execSnapshot({ tab_id: 1, detail: 'interactive' })
    expect((constrained.data as { view_state: unknown }).view_state).toStrictEqual({
      modal_dialog: true,
      aria_modal: false,
      fullscreen: false,
    })

    installLocalFramesMock({ rootNodes })
    const normal = await execSnapshot({ tab_id: 1, detail: 'interactive' })
    expect((normal.data as { view_state?: unknown }).view_state).toBeUndefined()
  })

  it('a failing view probe degrades to no note, never to a failed read', async () => {
    installLocalFramesMock({ rootNodes, viewStateThrows: true })
    const result = await execSnapshot({ tab_id: 1, detail: 'interactive' })
    expect(result.ok).toBe(true)
    expect((result.data as { view_state?: unknown }).view_state).toBeUndefined()
  })

  it('carries the status the document itself reports, and omits it when unknown', async () => {
    // An error PAGE commits like any other, so without this a read of a 404
    // returns ordinary prose with nothing to say the load failed (#187).
    installLocalFramesMock({ rootNodes, httpStatus: 500 })
    const failed = await execSnapshot({ tab_id: 1, detail: 'interactive' })
    expect((failed.data as { http_status?: number }).http_status).toBe(500)

    installLocalFramesMock({ rootNodes, httpStatus: null })
    const unknown = await execSnapshot({ tab_id: 1, detail: 'interactive' })
    expect(
      Object.keys(unknown.data as object),
      'absent is unknown, never a claim the load was fine',
    ).not.toContain('http_status')
  })

  it('withholds the status when a commit landed between the tree and the probe', async () => {
    // The tree and the status come from DIFFERENT round trips, and
    // `withProbeWorld` rebuilds its world in the new document on a
    // context-gone error, so a navigation mid-read would silently answer with
    // the NEW document's status: a soft 404 that redirects would lose its
    // note, and a 404 committing under a good page would render one over it.
    installNavWatch()
    const commit = (
      chrome.webNavigation!.onCommitted.addListener as unknown as ReturnType<typeof vi.fn>
    ).mock.calls.at(-1)?.[0] as (d: { tabId: number; url: string; frameId: number }) => void
    installLocalFramesMock({
      rootNodes,
      httpStatus: 404,
      onDocStatusProbe: () => commit({ tabId: 1, url: 'https://elsewhere.test/', frameId: 0 }),
    })

    const result = await execSnapshot({ tab_id: 1, detail: 'interactive' })

    expect(result.ok, 'the read itself still succeeds').toBe(true)
    expect(
      Object.keys(result.data as object),
      'two documents, so the status describes neither with confidence',
    ).not.toContain('http_status')
  })

  it('keeps the status on a SCOPED read, unlike the frame counts a subtree cannot support', async () => {
    // The FRAME counts are withheld when scoped because a subtree cannot
    // speak for sections it does not render. This claim is about the tab's
    // MAIN DOCUMENT, and no scope can falsify it, so withholding it would
    // lose a fact the read genuinely knows.
    installLocalFramesMock({ rootNodes, httpStatus: 404 })
    snapshotRefs.set(
      1,
      new Map([['e1', { backendNodeId: 42, role: 'button', name: 'OK' }]]),
      'https://example.com',
      1,
    )

    const scoped = await execSnapshot({ tab_id: 1, detail: 'interactive', scope_ref: '@e1' })

    expect((scoped.data as { http_status?: number }).http_status).toBe(404)
    expect((scoped.data as { frames_oopif?: number }).frames_oopif).toBeUndefined()
  })

  it('surfaces hidden-dropped counts in the payload', async () => {
    installLocalFramesMock({
      rootNodes: [
        { nodeId: '1', role: av('RootWebArea'), name: av('root'), childIds: ['2', '3'] },
        {
          nodeId: '2',
          role: av('region'),
          name: av('behind the modal'),
          parentId: '1',
          ignored: true,
          ignoredReasons: [{ name: 'activeModalDialog' }],
        },
        { nodeId: '3', role: av('button'), name: av('OK'), backendDOMNodeId: 42, parentId: '1' },
      ],
    })
    const result = await execSnapshot({ tab_id: 1, detail: 'interactive' })
    expect((result.data as { hidden_dropped: unknown }).hidden_dropped).toStrictEqual({
      activeModalDialog: 1,
    })
  })

  it('a scoped read landing on a frame OWNER carries the honest marker', async () => {
    installLocalFramesMock({
      rootNodes: [
        { nodeId: '1', role: av('RootWebArea'), name: av('root'), childIds: ['2'] },
        {
          nodeId: '2',
          role: av('Iframe'),
          name: av(''),
          backendDOMNodeId: 42,
          parentId: '1',
          properties: [{ name: 'focusable', value: { value: true } }],
        },
      ],
    })
    snapshotRefs.set(
      1,
      new Map([['e1', { backendNodeId: 42, role: 'Iframe', name: '' }]]),
      'https://example.com',
      1,
    )

    const result = await execSnapshot({ tab_id: 1, detail: 'interactive', scope_ref: '@e1' })

    expect(result.ok).toBe(true)
    expect((result.data as { tree: string }).tree).toMatch(/frame content not included/)
  })
})

describe('scoped reads make no frame claims (review round)', () => {
  it('a scoped read omits the frame counts its tree deliberately has no sections for', async () => {
    installLocalFramesMock({
      rootNodes: [
        { nodeId: '1', role: av('RootWebArea'), name: av('root'), childIds: ['2'] },
        { nodeId: '2', role: av('button'), name: av('Go'), backendDOMNodeId: 42, parentId: '1' },
      ],
      frameTree: {
        frame: { id: 'ROOT-FRAME' },
        childFrames: [{ frame: { id: 'LOCAL-1', url: 'https://example.com/widget' } }],
      },
      frames: { 'LOCAL-1': widgetFrameNodes },
    })
    snapshotRefs.set(
      1,
      new Map([['e1', { backendNodeId: 42, role: 'button', name: 'Go' }]]),
      'https://example.com',
      1,
    )

    const result = await execSnapshot({ tab_id: 1, detail: 'interactive', scope_ref: '@e1' })

    expect(result.ok).toBe(true)
    const data = result.data as Record<string, unknown>
    expect(data.frames_oopif).toBeUndefined()
    expect(data.frames_same_process).toBeUndefined()
    expect(data.tree as string).not.toMatch(/iframe "https/)
  })
})

describe('frame section planning (OOPIF nesting depth)', () => {
  const { planFrameSections } = __test
  const ids = (frames?: { targetId: string }[]) => (frames ?? []).map((o) => o.targetId)
  const tree = (
    rootFrameId: string | undefined,
    frames: { frameId: string; path: string[] }[] = [],
    parentId?: string,
  ) => ({
    root: { frameId: rootFrameId, ...(parentId ? { parentId } : {}) },
    frames: frames.map((f) => ({ ...f, url: '' })),
  })

  it('places an OOPIF one level below the frame that embeds it', () => {
    const plan = planFrameSections(tree('ROOT', [{ frameId: 'WRAP', path: ['WRAP'] }]), [
      { targetId: 'PAY', tree: tree('PAY', [], 'WRAP') },
    ])

    expect(plan.depth.get('WRAP')).toBe(0)
    expect(plan.depth.get('PAY')).toBe(1)
    // Filed under the FRAME that embeds it, which is what lets the renderer
    // emit the section immediately after that frame's own.
    expect(ids(plan.childrenOf.get('WRAP'))).toEqual(['PAY'])
    expect(plan.unanchored).toEqual([])
  })

  it('resolves an OOPIF whose parent is another OOPIF, whatever order they arrive in', () => {
    // The fixpoint: the inner frame's depth is unknowable until the outer
    // one has been placed, and attach order is not document order.
    const plan = planFrameSections(tree('ROOT'), [
      {
        targetId: 'INNER',
        tree: tree('INNER', [{ frameId: 'INNER-CHILD', path: ['INNER-CHILD'] }], 'OUTER-CHILD'),
      },
      { targetId: 'OUTER', tree: tree('OUTER', [{ frameId: 'OUTER-CHILD', path: ['OUTER-CHILD'] }]) },
    ])

    expect(plan.depth.get('OUTER')).toBe(0)
    expect(plan.depth.get('OUTER-CHILD'), 'a local frame inside an OOPIF').toBe(1)
    expect(plan.depth.get('INNER')).toBe(2)
    // A local frame inside a NESTED OOPIF is the case a per-session depth
    // cannot reach: its section belongs three levels in, not one.
    expect(plan.depth.get('INNER-CHILD')).toBe(3)
    // Filed under the OOPIF-local frame that embeds it, not at the margin:
    // the parent's section must render before the child's, or the indent
    // reads as containment by whatever section happened to precede it.
    expect(ids(plan.childrenOf.get('OUTER-CHILD'))).toEqual(['INNER'])
    expect(ids(plan.unanchored)).toEqual(['OUTER'])
  })

  it('keeps sibling subtrees together so an indent cannot claim the wrong parent', () => {
    const plan = planFrameSections(tree('ROOT'), [
      { targetId: 'A', tree: tree('A', [], 'ROOT') },
      { targetId: 'B', tree: tree('B', [], 'ROOT') },
      { targetId: 'A-CHILD', tree: tree('A-CHILD', [], 'A') },
    ])

    expect(ids(plan.childrenOf.get('ROOT'))).toEqual(['A', 'B'])
    expect(ids(plan.childrenOf.get('A'))).toEqual(['A-CHILD'])
    expect(plan.depth.get('A-CHILD')).toBe(1)
  })

  it('renders an unresolvable parent flat rather than guessing a depth', () => {
    const plan = planFrameSections(tree('ROOT'), [
      { targetId: 'ORPHAN', tree: tree('ORPHAN', [], 'A-FRAME-NOBODY-SAW') },
    ])

    expect(plan.depth.get('ORPHAN')).toBe(0)
    expect(ids(plan.unanchored)).toEqual(['ORPHAN'])
    expect(plan.childrenOf.size).toBe(0)
  })

  it('survives a parent cycle instead of recursing forever', () => {
    const plan = planFrameSections(tree('ROOT'), [
      { targetId: 'X', tree: tree('X', [], 'Y') },
      { targetId: 'Y', tree: tree('Y', [], 'X') },
    ])

    expect(ids(plan.unanchored).sort()).toEqual(['X', 'Y'])
    expect(plan.depth.get('X')).toBe(0)
    expect(plan.depth.get('Y')).toBe(0)
  })
})
