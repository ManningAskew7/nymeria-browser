import { beforeEach, describe, expect, it } from 'vitest'
import { __test, execSnapshot } from './snapshot'
import * as snapshotRefs from '../snapshotRefs'

const { formatTree } = __test

beforeEach(() => {
  // Full reset: counters are per-tab module state that would otherwise leak
  // monotonic numbering across tests.
  snapshotRefs.resetForTests()
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
    expect(refs.get('e1')).toEqual({
      backendNodeId: 100,
      sessionId: undefined,
      role: 'button',
      name: 'Submit',
    })
    expect(refs.get('e2')).toEqual({
      backendNodeId: 200,
      sessionId: undefined,
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
