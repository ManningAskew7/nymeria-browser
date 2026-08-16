import type { CommandResult } from '../../shared/types'
import { frameSessionByTargetId, frameSessions, sendCommand, type Cdp } from '../debuggerSession'
import { sameDocumentUrl } from '../urlMatch'
import { withProbeWorld } from '../worlds'
import {
  nextCounter,
  normalizeAxName,
  resolve as resolveRef,
  set as setRefs,
  withMintLock,
  type RefTarget,
} from '../snapshotRefs'

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
  opts: { frameTargetId?: string; frameUrl?: string; startCounter?: number } = {},
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
        // The owning FRAME rides along as its stable target id (never the
        // ephemeral session id, which dies on every idle detach):
        // backendNodeId is process-global, so the same number means
        // different elements in different frames. Role and name ride along
        // as the mint-time FINGERPRINT: act re-reads the same
        // browser-computed pair before dispatching input, so a live node
        // whose meaning changed since this read refuses instead of firing.
        // The shared normalizer keeps mint and check from drifting apart,
        // which would refuse every fingerprinted verb.
        refs.set(refId, {
          backendNodeId: node.backendDOMNodeId,
          frameTargetId: opts.frameTargetId,
          frameUrl: opts.frameUrl,
          role,
          name: normalizeAxName(strVal(node.name)),
        })
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
): Promise<{
  backendNodeId: number | null
  frameTargetId?: string
  frameUrl?: string
  error?: string
}> {
  if (scopeRef) {
    const tab = await chrome.tabs.get(tabId).catch(() => null)
    const resolution = resolveRef(tabId, scopeRef, tab?.url ?? null)
    if (!resolution.ok) return { backendNodeId: null, error: resolution.detail }
    // The frame rides along: a frame ref's backendNodeId only means anything
    // in ITS frame's tree. Resolving it against the root tree silently
    // matched an unrelated main-document node (backend node ids are
    // process-global), so a scoped read of a payment frame returned the top
    // document as if that were the answer (measured live 2026-08-16).
    return {
      backendNodeId: resolution.backendNodeId,
      frameTargetId: resolution.frameTargetId,
      frameUrl: resolution.frameUrl,
    }
  }
  // Probe world (#160): the selector picks the read ROOT, so a main-world
  // `querySelector` override could steer what the model believes the page
  // says. Fail-closed: no world, no main-world fallback.
  const evald = await withProbeWorld(tabId, (contextId) =>
    sendCommand<{ result?: { objectId?: string; subtype?: string } }>(tabId, 'Runtime.evaluate', {
      expression: `document.querySelector(${JSON.stringify(scopeSelector)})`,
      returnByValue: false,
      contextId,
    }),
  )
  if (evald === null) {
    return {
      backendNodeId: null,
      error:
        'the scope selector could not run in this tab\'s isolated inspection context ' +
        '(the tab is likely mid-navigation); retry, or read without a scope',
    }
  }
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
  let scopeFrameTargetId: string | undefined
  let scopeFrameUrl: string | undefined
  if (a.scope_ref || a.scope_selector) {
    const scoped = await resolveScopeNode(a.tab_id, a.scope_ref, a.scope_selector)
    if (scoped.error) return { ok: false, status: 'error', error: scoped.error }
    scopeNodeId = scoped.backendNodeId
    scopeFrameTargetId = scoped.frameTargetId
    scopeFrameUrl = scoped.frameUrl
  }

  // A scope ref inside a cross-origin frame re-roots INSIDE that frame: the
  // tree is read from the frame's own live session and the minted refs stay
  // frame-owned. The registry is warm here because the command dispatcher
  // attached to the tab before any exec ran; the bounded wait only covers
  // the re-announce race after that attach.
  let treeTarget: Cdp = a.tab_id
  if (scopeFrameTargetId) {
    const live = await frameSessionByTargetId(a.tab_id, scopeFrameTargetId)
    if (!live) {
      return {
        ok: false,
        status: 'error',
        error:
          'the frame that scope ref lives in is no longer part of the page (it ' +
          'navigated away or was removed). Re-read the page for current refs.',
      }
    }
    // Same target id, different document: the frame NAVIGATED since the ref
    // was minted, so its backendNodeId now belongs to a dead document (and
    // could collide inside the new one). Refuse rather than resolve.
    if (scopeFrameUrl && live.url && !sameDocumentUrl(scopeFrameUrl, live.url)) {
      return {
        ok: false,
        status: 'error',
        error:
          `the frame that scope ref lives in navigated from ${scopeFrameUrl} to ` +
          `${live.url} since the read. Re-read the page for current refs.`,
      }
    }
    scopeFrameUrl = live.url || scopeFrameUrl
    treeTarget = { tabId: a.tab_id, sessionId: live.sessionId }
  }

  const nodes = await treeFor(treeTarget)
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

  // Minting is serialized per tab and numbers continue from the tab's
  // monotonic counter: two reads never mint the same number, so a ref held
  // from an earlier read either still resolves (same document, merged map)
  // or refuses honestly, never re-points. A scoped read MERGES its refs into
  // the map for the same reason: it must not invalidate the full-page refs
  // the caller is still holding.
  return withMintLock(a.tab_id, async () => {
    const start = await nextCounter(a.tab_id)
    const main = formatTree(nodes, rootIds, detail, {
      startCounter: start,
      frameTargetId: scopeFrameTargetId,
      frameUrl: scopeFrameTargetId ? scopeFrameUrl : undefined,
    })
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
            frameTargetId: frame.targetId,
            frameUrl: frame.url,
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
    const rendered = sections.join('\n')
    setRefs(a.tab_id, allRefs, url, counter)

    return {
      ok: true,
      status: 'success',
      data: {
        tree: rendered,
        ref_count: allRefs.size,
        detail,
        url,
        frames: frameSessions(a.tab_id).length,
      },
    }
  })
}

export const __test = { formatTree, isInteractive, strVal, rootsOf }
