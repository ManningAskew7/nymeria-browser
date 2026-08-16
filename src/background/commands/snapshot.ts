import type { CommandResult } from '../../shared/types'
import { frameIdOf, frameSessions, localFrames, locateFrame, sendCommand, type Cdp } from '../debuggerSession'
import { sameDocumentUrl } from '../urlMatch'
import { evaluateInProbeWorld, withProbeWorld } from '../worlds'
import {
  nextCounter,
  normalizeAxName,
  resolve as resolveRef,
  set as setRefs,
  withMintLock,
  type RefTarget,
} from '../snapshotRefs'

/**
 * Same-process frames read per session-tree, in document order. A frame-farm
 * page (ad stacks routinely carry dozens) would otherwise add an unbounded
 * run of serial CDP reads to a command with a 20s transport budget; past the
 * cap the payload says exactly how many frames went unread, never silence.
 */
const MAX_LOCAL_FRAMES = 8

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

/**
 * The ignored reasons that mean CONTENT the page genuinely renders was
 * dropped from this read (R-02's completeness half). The everyday
 * `uninteresting` (wrapper divs) and presentational reasons are deliberately
 * absent: their CHILDREN still render (the walk descends through dropped
 * nodes), so nothing is lost and counting them would make the honesty note
 * an always-on fixture the reader learns to skip.
 */
const HIDING_REASONS = new Set([
  'ariaHiddenElement',
  'ariaHiddenSubtree',
  'notVisible',
  'notRendered',
  'activeModalDialog',
  'activeAriaModalDialog',
  'activeFullscreenElement',
  'inertElement',
  'inertSubtree',
])

interface FormattedSnapshot {
  text: string
  refs: Map<string, RefTarget>
  nextCounter: number
  /** Dropped ignored-node counts by content-hiding reason; each counted node
   *  may root a subtree Blink excluded from the response entirely, so these
   *  are floor counts, surfaced so "the tree is small" is distinguishable
   *  from "the page is small". */
  hiddenDropped: Record<string, number>
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
  const hiddenDropped: Record<string, number> = {}

  function walk(id: string, depth: number): void {
    const node = byId.get(id)
    if (!node) return
    if (node.ignored) {
      const reason = (node.ignoredReasons ?? [])
        .map((r) => r.name ?? '')
        .find((name) => HIDING_REASONS.has(name))
      if (reason) hiddenDropped[reason] = (hiddenDropped[reason] ?? 0) + 1
    }
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
  return { text: lines.join('\n'), refs, nextCounter: refCounter, hiddenDropped }
}

/** Roots of an AX node list: the nodes whose parent is not in the list. */
function rootsOf(nodes: AXNode[]): string[] {
  const ids = new Set(nodes.map((n) => n.nodeId))
  return nodes.filter((n) => !n.parentId || !ids.has(n.parentId)).map((n) => n.nodeId)
}

async function treeFor(target: Cdp): Promise<AXNode[]> {
  // A frameId-carrying target reads a SAME-PROCESS frame's document through
  // the session it shares (`getFullAXTree` resolves local frame ids only;
  // OOPIFs have their own sessions and never a frameId here).
  const frameId = frameIdOf(target)
  const resp = await sendCommand<{ nodes: AXNode[] }>(
    target,
    'Accessibility.getFullAXTree',
    frameId ? { frameId } : {},
  )
  return resp.nodes ?? []
}

/** What the collapse probe found constraining the view; all false = no note. */
interface ViewState {
  modal_dialog: boolean
  aria_modal: boolean
  fullscreen: boolean
}

/**
 * The collapse-honesty probe (R-08). A modal `<dialog>`, an `aria-modal`
 * widget, or a fullscreen element makes Blink prune the AX tree to (mostly)
 * that subtree, measured 49 nodes -> 13 with everything else GONE and
 * unflagged, so a read taken behind a cookie wall reports an almost-empty
 * page as if that were the page. Runs in the PROBE world: the answer shapes
 * what the model believes about the page, and `document.fullscreenElement`
 * or `querySelector` overridden in the main world could hide the constraint
 * (or fake one). Booleans ONLY, deliberately: the note the backend renders
 * from this sits OUTSIDE the untrusted-content fence, so nothing
 * page-controlled (ids, labels) may ride along. `dialog:modal` rather than
 * `dialog[open]` because a non-modal `show()` dialog does not prune the
 * tree, and a false "constrained" note is its own honesty bug; per-selector
 * try keeps one unsupported pseudo-class from muting the other answers.
 */
const VIEW_STATE_EXPRESSION = `(function(){
  function q(sel){ try { return document.querySelector(sel) !== null; } catch (e) { return false; } }
  var fs = false;
  try { fs = document.fullscreenElement !== null; } catch (e) {}
  // aria-modal is page-DECLARED markup, so it gets two forgery gates the
  // other causes do not need (review round): the element must carry a
  // dialog role (only those prune the AX tree) and must actually be
  // VISIBLE (a display:none decoy must not trip a "blocked" note; a page
  // cannot fake checkVisibility in this world).
  var am = false;
  try {
    var cands = document.querySelectorAll(
      'dialog[aria-modal="true"], [role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]'
    );
    for (var i = 0; i < cands.length; i++) {
      var el = cands[i];
      var vis = true;
      try { if (typeof el.checkVisibility === 'function') vis = el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }); } catch (e) {}
      if (vis) { am = true; break; }
    }
  } catch (e) {}
  return { modal_dialog: q('dialog:modal'), aria_modal: am, fullscreen: fs };
})()`

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

  // A scope ref inside a frame re-roots INSIDE that frame: an OOPIF's tree
  // is read from its own live session, a same-process frame's through the
  // shared session with its `frameId`, and the minted refs stay frame-owned
  // either way. The registry is warm here because the command dispatcher
  // attached to the tab before any exec ran; `locateFrame`'s bounded wait
  // only covers the OOPIF re-announce race after that attach.
  let treeTarget: Cdp = a.tab_id
  if (scopeFrameTargetId) {
    const located = await locateFrame(a.tab_id, scopeFrameTargetId)
    if (!located) {
      return {
        ok: false,
        status: 'error',
        error:
          'the frame that scope ref lives in is no longer part of the page (it ' +
          'navigated away or was removed). Re-read the page for current refs.',
      }
    }
    // Same frame token, different document: the frame NAVIGATED since the ref
    // was minted, so its backendNodeId now belongs to a dead document (and
    // could collide inside the new one). Refuse rather than resolve.
    if (scopeFrameUrl && located.url && !sameDocumentUrl(scopeFrameUrl, located.url)) {
      return {
        ok: false,
        status: 'error',
        error:
          `the frame that scope ref lives in navigated from ${scopeFrameUrl} to ` +
          `${located.url} since the read. Re-read the page for current refs.`,
      }
    }
    scopeFrameUrl = located.url || scopeFrameUrl
    treeTarget = located.session
  }

  const nodes = await treeFor(treeTarget)
  let rootIds = rootsOf(nodes)

  let scopeIsFrameOwner = false
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
    // A frame OWNER's subtree is empty in its parent's tree (the content
    // lives in the frame's own document), and a scoped read stays in its
    // scope, so without a marker this read returns near-nothing as if that
    // were the answer.
    scopeIsFrameOwner = strVal(scopeNode.role) === 'Iframe'
  }

  // The collapse-honesty probe (see VIEW_STATE_EXPRESSION). Soft: no world,
  // no note; the read itself is never blocked on it.
  const viewState = await evaluateInProbeWorld<ViewState>(a.tab_id, VIEW_STATE_EXPRESSION)
  const viewConstrained =
    viewState != null && (viewState.modal_dialog || viewState.aria_modal || viewState.fullscreen)

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
    if (scopeIsFrameOwner) {
      sections[0] +=
        `${sections[0] ? '\n' : ''}` +
        '  - [frame content not included: this element is a frame owner, and a scoped ' +
        "read stays in its scope. Read the full page to see the frame's own labelled section]"
    }
    let counter = main.nextCounter
    const hidden: Record<string, number> = { ...main.hiddenDropped }
    const mergeHidden = (more: Record<string, number>): void => {
      for (const [reason, count] of Object.entries(more)) {
        hidden[reason] = (hidden[reason] ?? 0) + count
      }
    }

    /** Render one frame document as a labelled section, threading the ref
     *  counter so numbers stay globally monotonic across sections. Returns
     *  whether a REAL section was rendered: the payload's frame counts are
     *  claims about what the tree contains, so an empty or unreadable frame
     *  must not inflate them (an over-count here is its own honesty bug,
     *  review round). `depth` indents the whole section by nesting level, so
     *  a frame-inside-a-frame reads as contained rather than as a sibling
     *  (a flat render hid the containment, QA round 1). */
    const renderFrameSection = async (
      target: Cdp,
      frameToken: string,
      frameUrl: string,
      depth = 0,
    ): Promise<boolean> => {
      const pad = '  '.repeat(depth)
      try {
        const frameNodes = await treeFor(target)
        if (!frameNodes.length) return false
        const formatted = formatTree(frameNodes, rootsOf(frameNodes), detail, {
          frameTargetId: frameToken,
          frameUrl,
          startCounter: counter,
        })
        mergeHidden(formatted.hiddenDropped)
        if (!formatted.text.trim()) return false
        counter = formatted.nextCounter
        for (const [refId, target_] of formatted.refs) allRefs.set(refId, target_)
        const indented = formatted.text
          .split('\n')
          .map((line) => `${pad}  ${line}`)
          .join('\n')
        sections.push(`${pad}- iframe "${frameUrl}"\n${indented}`)
        return true
      } catch {
        // One unreadable frame must not cost the whole page read. Visible in
        // the tree, but NOT counted as read.
        sections.push(`${pad}- iframe "${frameUrl}" [unreadable]`)
        return false
      }
    }

    let framesOopifRendered = 0
    let framesLocalRendered = 0
    let framesSkipped = 0
    /** Same-process child frames of one session's document, in document
     *  order (deterministic ref numbering), capped with an honest tail.
     *  `baseDepth` nests a session's local frames under the section that
     *  introduced the session (1 for an OOPIF's children). */
    const renderLocalFrames = async (sessionTarget: Cdp, baseDepth = 0): Promise<void> => {
      const local = await localFrames(sessionTarget)
      const toRead = local.slice(0, MAX_LOCAL_FRAMES)
      for (const f of toRead) {
        const tabId = a.tab_id
        const sessionId = typeof sessionTarget === 'number' ? undefined : sessionTarget.sessionId
        const depth = baseDepth + (f.path.length - 1)
        if (
          await renderFrameSection({ tabId, sessionId, frameId: f.frameId }, f.frameId, f.url, depth)
        ) {
          framesLocalRendered += 1
        }
      }
      if (local.length > toRead.length) {
        const skipped = local.length - toRead.length
        framesSkipped += skipped
        // Padded with the section's own base indent: unpadded under an OOPIF
        // this rendered at the margin as a page-level claim (review round).
        sections.push(
          `${'  '.repeat(baseDepth)}- [${skipped} more frame(s) in this document not read: frame cap reached]`,
        )
      }
    }

    // Frames, in two complementary sweeps that together cover every document
    // on the page. SAME-PROCESS frames (same-origin widgets, srcdoc embeds)
    // are absent from the root tree except as a childless Iframe node and
    // are read per-frameId through the session they share; CROSS-ORIGIN
    // (OOPIF) frames are invisible to that walk and are read through their
    // own flattened sessions, each followed by ITS same-process children (a
    // same-origin frame nested inside a payment iframe). A scoped read
    // stays in its scope.
    if (scopeNodeId == null) {
      await renderLocalFrames(a.tab_id)
      for (const frame of frameSessions(a.tab_id)) {
        if (
          await renderFrameSection(
            { tabId: a.tab_id, sessionId: frame.sessionId },
            frame.targetId,
            frame.url,
          )
        ) {
          framesOopifRendered += 1
        }
        await renderLocalFrames({ tabId: a.tab_id, sessionId: frame.sessionId }, 1)
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
        // Frame counts are claims about THIS tree's sections, so a scoped
        // read (which deliberately renders none) reports none: emitting the
        // page's frame inventory there put a false "included" note outside
        // the fence (review round).
        ...(scopeNodeId == null
          ? {
              frames_oopif: framesOopifRendered,
              frames_same_process: framesLocalRendered,
              ...(framesSkipped ? { frames_skipped: framesSkipped } : {}),
            }
          : {}),
        ...(viewConstrained ? { view_state: viewState } : {}),
        ...(Object.keys(hidden).length ? { hidden_dropped: hidden } : {}),
      },
    }
  })
}

export const __test = { formatTree, isInteractive, strVal, rootsOf }
