import type { CommandResult } from '../../shared/types'
import { sendCommand } from '../debuggerSession'
import { set as setRefs } from '../snapshotRefs'

interface SnapshotArgs {
  tab_id: number
  detail?: 'interactive' | 'full' | 'minimal'
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
  refs: Map<string, number>
}

function formatTree(
  nodes: AXNode[],
  rootIds: string[],
  detail: 'interactive' | 'full' | 'minimal',
): FormattedSnapshot {
  const byId = new Map<string, AXNode>(nodes.map((n) => [n.nodeId, n]))
  const refs = new Map<string, number>()
  let refCounter = 0
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
        refs.set(refId, node.backendDOMNodeId)
        refMarker = ` [ref=@${refId}]`
      }
      line = `${'  '.repeat(depth)}- ${role}${name}${value}${refMarker}`
      lines.push(line)
    }
    const childIds = node.childIds ?? []
    for (const c of childIds) walk(c, keep ? depth + 1 : depth)
  }

  for (const id of rootIds) walk(id, 0)
  return { text: lines.join('\n'), refs }
}

export async function execSnapshot(args: unknown): Promise<CommandResult> {
  const a = args as SnapshotArgs
  if (typeof a.tab_id !== 'number') {
    return { ok: false, status: 'error', error: 'tab_id required' }
  }
  const detail = a.detail ?? 'interactive'

  // Resolve scope to a sanity check if a scope_selector was provided.
  // Full AX scoping would need a CDP DOM.querySelector +
  // Accessibility.getPartialAXTree round-trip; for now we just confirm
  // the element exists and fetch the full tree.
  if (a.scope_selector) {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: a.tab_id },
        func: (sel: string) => Boolean(document.querySelector(sel)),
        args: [a.scope_selector],
      })
      if (!result) {
        return {
          ok: true,
          status: 'success',
          data: { tree: '', note: 'scope_selector matched no element' },
        }
      }
    } catch (e) {
      return { ok: false, status: 'error', error: `scope_selector failed: ${String(e)}` }
    }
  }

  const resp = await sendCommand<{ nodes: AXNode[] }>(a.tab_id, 'Accessibility.getFullAXTree', {})
  const nodes = resp.nodes ?? []
  // Find the root(s): nodes whose parentId is missing from the map.
  const ids = new Set(nodes.map((n) => n.nodeId))
  const rootIds = nodes.filter((n) => !n.parentId || !ids.has(n.parentId)).map((n) => n.nodeId)

  const { text, refs } = formatTree(nodes, rootIds, detail)
  setRefs(a.tab_id, refs)

  return {
    ok: true,
    status: 'success',
    data: {
      tree: text,
      ref_count: refs.size,
      detail,
    },
  }
}

export const __test = { formatTree, isInteractive, strVal }
