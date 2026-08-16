import { beforeEach, describe, expect, it, vi } from 'vitest'
import { __test, execSnapshot } from './snapshot'
import * as snapshotRefs from '../snapshotRefs'
import { resetForTests as resetDebugger } from '../debuggerSession'
import { resetForTests as resetWorlds } from '../worlds'

const { formatTree } = __test

beforeEach(() => {
  // Full reset: counters are per-tab module state that would otherwise leak
  // monotonic numbering across tests, and the debugger/worlds caches would
  // leak sessions and execution-context ids the same way.
  snapshotRefs.resetForTests()
  resetDebugger()
  resetWorlds()
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

  it('renders nested same-process frames, in document order', async () => {
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
    expect((result.data as { frames_same_process: number }).frames_same_process).toBe(2)
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
    expect(tree).toMatch(/2 more frame\(s\) on this page not read/)
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
