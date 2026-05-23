import { beforeEach, describe, expect, it } from 'vitest'
import { __test, execSnapshot } from './snapshot'
import * as snapshotRefs from '../snapshotRefs'

const { formatTree } = __test

beforeEach(() => {
  snapshotRefs.clearAll()
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
    expect(refs.get('e1')).toBe(100)
    expect(refs.get('e2')).toBe(200)
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
    expect(snapshotRefs.resolve(1, '@e1')).toBe(42)
  })

  it('returns ok:false with a clear error when tab_id is missing', async () => {
    const result = await execSnapshot({})
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/tab_id/)
  })
})
