import type { CommandResult } from '../../shared/types'
import { frameSessions, sendCommand, type Cdp } from '../debuggerSession'
import { resolve as resolveRef, set as setRefs, type RefTarget } from '../snapshotRefs'

interface SnapshotArgs {
  tab_id: number
  detail?: 'interactive' | 'full' | 'minimal'
  /** Re-root the tree at a previously minted ref, e.g. "@e12". */
  scope_ref?: string
  scope_selector?: string
}

interface AXValue {
  type?: string
  value?: unknown
}

interface AXProperty {
  name?: string
  value?: AXValue
}

interface AXNode {
  nodeId: string
  role?: AXValue
  name?: AXValue
  value?: AXValue
  description?: AXValue
  properties?: AXProperty[]
  childIds?: string[]
  backendDOMNodeId?: number
  parentId?: string
  ignored?: boolean
  ignoredReasons?: { name?: string }[]
}

const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'checkbox',
  'radio',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'tab',
  'switch',
  'slider',
  'spinbutton',
])

const STRUCTURAL_ROLES = new Set([
  'WebArea',
  'RootWebArea',
  'main',
  'navigation',
  'banner',
  'contentinfo',
  'region',
  'heading',
  'list',
  'listitem',
  'article',
  'section',
  'form',
  'paragraph',
  'image',
  'figure',
  'StaticText',
  'text',
])

function strVal(av?: AXValue): string {
  if (!av) return ''
  if (typeof av.value === 'string') return av.value
  if (av.value == null) return ''
  return String(av.value)
}

function propBool(props: AXProperty[] | undefined, name: string): boolean | undefined {
  if (!props) return undefined
  for (const p of props) {
    if (p.name === name) {
      const v = p.value?.value
      if (typeof v === 'boolean') return v
    }
  }
  return undefined
}

function isInteractive(node: AXNode): boolean {
  const role = strVal(node.role)
  if (INTERACTIVE_ROLES.has(role)) return true
  if (propBool(node.properties, 'focusable')) return true
  if (propBool(node.properties, 'editable')) return true
  return false
}

function shouldKeep(node: AXNode, detail: 'interactive' | 'full' | 'minimal'): boolean {
  if (node.ignored) return false
  const role = strVal(node.role)
  if (!role) return false
  if (detail === 'full') return true
  if (detail === 'minimal') {
    return isInteractive(node) || role === 'heading' || role === 'RootWebArea'
  }
  // 'interactive' default
  return isInteractive(node) || STRUCTURAL_ROLES.has(role)
}

function escapeQuoted(s: string): string {
  return s.replace(/"/g, '\\"')
}

function renderName(node: AXNode): string {
  const name = strVal(node.name).trim()
  return name ? ` "${escapeQuoted(name.slice(0, 200))}"` : ''
}

function renderValue(node: AXNode): string {
  const value = strVal(node.value).trim()
  return value ? ` value="${escapeQuoted(value.slice(0, 200))}"` : ''
}

interface FormattedSnapshot {
  text: string
  refs: Map<string, RefTarget>
  nextCounter: number
}

function formatTree(
  nodes: AXNode[],
  rootIds: string[],
  detail: 'interactive' | 'full' | 'minimal',
  opts: { sessionId?: string; startCounter?: number } = {},
): FormattedSnapshot {
  const byId = new Map<string, AXNode>(nodes.map((n) => [n.nodeId, n]))
  const refs = new Map<string, RefTarget>()
  let refCounter = opts.startCounter ?? 0
  const lines: string[] = []

  function walk(id: string, depth: number): void {
    const node = byId.get(id)
    if (!node) return
    const keep = shouldKeep(node, detail)
    let line: string | null = null
    if (keep) {
      const role = strVal(node.role)
      const name = renderName(node)
      const value = renderValue(node)
      let refMarker = ''
      if (isInteractive(node) && typeof node.backendDOMNodeId === 'number') {
        refCounter += 1
        const refId = `e${refCounter}`
        // The session is stored with the id: backendNodeId is process-global,
        // so the same number means different elements in different frames.
        refs.set(refId, { backendNodeId: node.backendDOMNodeId, sessionId: opts.sessionId })
        refMarker = ` [ref=@${refId}]`
      }
      line = `${'  '.repeat(depth)}- ${role}${name}${value}${refMarker}`
      lines.push(line)
    }
    const childIds = node.childIds ?? []
    for (const c of childIds) walk(c, keep ? depth + 1 : depth)
  }

  for (const id of rootIds) walk(id, 0)
  return { text: lines.join('\n'), refs, nextCounter: refCounter }
}

/** Roots of an AX node list: the nodes whose parent is not in the list. */
function rootsOf(nodes: AXNode[]): string[] {
  const ids = new Set(nodes.map((n) => n.nodeId))
  return nodes.filter((n) => !n.parentId || !ids.has(n.parentId)).map((n) => n.nodeId)
}

async function treeFor(target: Cdp): Promise<AXNode[]> {
  const resp = await sendCommand<{ nodes: AXNode[] }>(
    target,
    'Accessibility.getFullAXTree',
    {},
  )
  return resp.nodes ?? []
}

/** Resolve a scope ref or selector to a backendNodeId to re-root the tree at. */
async function resolveScopeNode(
  tabId: number,
  scopeRef?: string,
  scopeSelector?: string,
): Promise<{ backendNodeId: number | null; error?: string }> {
  if (scopeRef) {
    const tab = await chrome.tabs.get(tabId).catch(() => null)
    const resolution = resolveRef(tabId, scopeRef, tab?.url ?? null)
    if (!resolution.ok) return { backendNodeId: null, error: resolution.detail }
    return { backendNodeId: resolution.backendNodeId }
  }
  const evald = await sendCommand<{ result?: { objectId?: string; subtype?: string } }>(
    tabId,
    'Runtime.evaluate',
    {
      expression: `document.querySelector(${JSON.stringify(scopeSelector)})`,
      returnByValue: false,
    },
  )
  if (!evald.result?.objectId || evald.result.subtype === 'null') {
    return { backendNodeId: null, error: `scope selector matched no element: ${scopeSelector}` }
  }
  const described = await sendCommand<{ node?: { backendNodeId?: number } }>(
    tabId,
    'DOM.describeNode',
    { objectId: evald.result.objectId },
  )
  const backendNodeId = described.node?.backendNodeId
  if (backendNodeId == null) {
    return { backendNodeId: null, error: 'could not resolve the scope element' }
  }
  return { backendNodeId }
}

export async function execSnapshot(args: unknown): Promise<CommandResult> {
  const a = args as SnapshotArgs
  if (typeof a.tab_id !== 'number') {
    return { ok: false, status: 'error', error: 'tab_id required' }
  }
  const detail = a.detail ?? 'interactive'

  // Scope, when asked for, is resolved to a real backend node and used as the
  // tree root. The previous implementation only probed that a selector
  // matched something and then returned the whole page anyway, which quietly
  // made every scoped read a full read.
  let scopeNodeId: number | null = null
  if (a.scope_ref || a.scope_selector) {
    const scoped = await resolveScopeNode(a.tab_id, a.scope_ref, a.scope_selector)
    if (scoped.error) return { ok: false, status: 'error', error: scoped.error }
    scopeNodeId = scoped.backendNodeId
  }

  const nodes = await treeFor(a.tab_id)
  let rootIds = rootsOf(nodes)

  if (scopeNodeId != null) {
    const scopeNode = nodes.find((n) => n.backendDOMNodeId === scopeNodeId)
    if (!scopeNode) {
      return {
        ok: false,
        status: 'error',
        error: 'that element is not in the accessibility tree (it may be hidden from assistive tech)',
      }
    }
    rootIds = [scopeNode.nodeId]
  }

  const main = formatTree(nodes, rootIds, detail)
  const allRefs = new Map<string, RefTarget>(main.refs)
  const sections = [main.text]
  let counter = main.nextCounter

  // Cross-origin iframes run in their own process and are absent from the
  // page's own tree: the <iframe> node appears with an empty subtree and no
  // error. Reading each attached frame session is what makes a payment field
  // or a consent dialog reachable at all. A scoped read stays in its scope.
  if (scopeNodeId == null) {
    for (const frame of frameSessions(a.tab_id)) {
      try {
        const frameNodes = await treeFor({ tabId: a.tab_id, sessionId: frame.sessionId })
        if (!frameNodes.length) continue
        const formatted = formatTree(frameNodes, rootsOf(frameNodes), detail, {
          sessionId: frame.sessionId,
          startCounter: counter,
        })
        if (!formatted.text.trim()) continue
        counter = formatted.nextCounter
        for (const [refId, target] of formatted.refs) allRefs.set(refId, target)
        const indented = formatted.text
          .split('\n')
          .map((line) => `  ${line}`)
          .join('\n')
        sections.push(`- iframe "${frame.url}"\n${indented}`)
      } catch {
        // One unreadable frame must not cost the whole page read.
        sections.push(`- iframe "${frame.url}" [unreadable]`)
      }
    }
  }

  const tab = await chrome.tabs.get(a.tab_id).catch(() => null)
  const url = tab?.url ?? null
  setRefs(a.tab_id, allRefs, url)

  return {
    ok: true,
    status: 'success',
    data: {
      tree: sections.join('\n'),
      ref_count: allRefs.size,
      detail,
      url,
      frames: frameSessions(a.tab_id).length,
    },
  }
}

export const __test = { formatTree, isInteractive, strVal, rootsOf }
