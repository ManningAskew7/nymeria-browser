import type { CommandResult } from '../../shared/types'
import {
  frameIdOf,
  frameSessions,
  localFrameTree,
  locateFrame,
  sendCommand,
  type Cdp,
  type LocalFrame,
  type LocalFrameTree,
} from '../debuggerSession'
import { DOC_STATUS_EXPRESSION, httpStatusField } from '../docStatus'
import { commitSeq } from '../navWatch'
import { SELECTOR_IDENTITY_SNIPPET } from '../selectorIdentity'
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

/** The AX roles that are a DOCUMENT rather than a control (#208). They mint
 *  refs only because Chrome marks documents focusable, and a document ref
 *  does exactly one useful thing: `scroll` wheels inside it. Kept minting
 *  (it is the only handle a static in-frame pane has), but counted apart so
 *  a read can say "scrollable, nothing clickable" instead of leaving the
 *  reader to infer it from a ref count that looks healthy. */
const DOCUMENT_ROLES = new Set(['RootWebArea', 'WebArea'])

function countControlRefs(refs: Map<string, RefTarget>): number {
  let n = 0
  for (const t of refs.values()) if (!DOCUMENT_ROLES.has(t.role)) n += 1
  return n
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

/** One attached cross-origin frame, with its own session's frame tree. */
interface DiscoveredOopif {
  targetId: string
  tree: LocalFrameTree
}

/**
 * Where every frame section belongs in the tree, before anything renders.
 *
 * The problem this solves: an OOPIF is absent from the root session's frame
 * tree, so the sweep that renders it has no idea whether it sits directly in
 * the page or three frames deep inside a same-origin wrapper. It rendered at
 * the margin either way, as a sibling of the page itself, and its own
 * same-process children then rendered one level in, as if their parent were
 * the document. `Page.Frame.parentId` on the OOPIF's OWN root node answers
 * it, and that call is already being made for the children.
 *
 * Depth is "number of frame ancestors", so a frame embedded directly in the
 * page is 0 and the main frame is -1, which makes both rules one addition.
 * Resolution is a fixpoint rather than a single pass because an OOPIF's
 * depth can depend on another OOPIF's (a cross-origin frame inside a
 * cross-origin frame). A parent that never resolves (a frame id from
 * neither tree, a cycle) renders at 0 exactly as before: an unknown nesting
 * is reported as no nesting, never guessed.
 *
 * `childrenOf` is what makes the ORDER honest, and it is keyed by the parent
 * FRAME rather than by the parent OOPIF: sections indent, so an OOPIF
 * emitted after an unrelated frame at a shallower depth reads as that
 * frame's child. The renderer walks it, emitting each cross-origin section
 * immediately after the section of the frame that embeds it. `unanchored`
 * holds the ones with no usable parent, which render flat at the end
 * exactly as every OOPIF did before this.
 */
function planFrameSections<T extends DiscoveredOopif>(
  rootTree: LocalFrameTree,
  oopifs: T[],
): { depth: Map<string, number>; childrenOf: Map<string, T[]>; unanchored: T[] } {
  const depth = new Map<string, number>()
  if (rootTree.root.frameId) depth.set(rootTree.root.frameId, -1)
  for (const f of rootTree.frames) depth.set(f.frameId, f.path.length - 1)
  const childrenOf = new Map<string, T[]>()
  const unanchored: T[] = []
  const place = (o: T, at: number, parentId: string | null): void => {
    depth.set(o.targetId, at)
    // The OOPIF's OWN root frame id, so a cross-origin frame nested directly
    // inside another one anchors to it (Chrome makes the two ids equal, but
    // the plan does not depend on that).
    if (o.tree.root.frameId) depth.set(o.tree.root.frameId, at)
    for (const f of o.tree.frames) depth.set(f.frameId, at + f.path.length)
    if (parentId === null) {
      unanchored.push(o)
      return
    }
    const list = childrenOf.get(parentId)
    if (list) list.push(o)
    else childrenOf.set(parentId, [o])
  }
  let pending = oopifs.slice()
  for (;;) {
    const stuck: T[] = []
    for (const o of pending) {
      const parentId = o.tree.root.parentId
      // `undefined`, not falsy: the main frame's depth is -1 and a top-level
      // frame's is 0, both of which a truthiness test would throw away.
      const anchor = parentId === undefined ? undefined : depth.get(parentId)
      if (parentId !== undefined && anchor === undefined) {
        stuck.push(o)
        continue
      }
      if (anchor === undefined) place(o, 0, null)
      else place(o, anchor + 1, parentId as string)
    }
    if (!stuck.length) break
    if (stuck.length === pending.length) {
      // No progress: every remaining parent is unknowable. Render flat.
      for (const o of stuck) place(o, 0, null)
      break
    }
    pending = stuck
  }
  return { depth, childrenOf, unanchored }
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
  matchCount?: number
  matched?: string
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
  //
  // COUNTED first, and by value. A selector names a RULE, not an element, so
  // `.comment` on a 40-comment thread resolves to one comment that the model
  // then reasons over AS the region: the act path already reports its match
  // count for exactly this reason, and a read is worse, because its answer
  // looks like the whole of what was asked for. The count also validates the
  // selector, so a miss costs one round trip instead of two (review round).
  const counted = await withProbeWorld(tabId, (contextId) =>
    sendCommand<{
      result?: { value?: { count?: unknown; matched?: unknown } }
      exceptionDetails?: unknown
    }>(
      tabId,
      'Runtime.evaluate',
      {
        // Count AND identity in one evaluation, so both describe the same
        // document at the same instant, and the text read's rule cannot drift
        // from this one (#193 review round: the identity landed on the text
        // read alone, leaving the reader an agent ACTS from unable to say
        // which of several candidates it answered with).
        expression: `(function(){
          ${SELECTOR_IDENTITY_SNIPPET}
          var sel = ${JSON.stringify(scopeSelector)};
          var all = document.querySelectorAll(sel);
          return { count: all.length, matched: all.length ? nymSelectorIdentity(all[0], sel) : null };
        })()`,
        returnByValue: true,
        contextId,
      },
    ),
  )
  if (counted === null) {
    return {
      backendNodeId: null,
      error:
        'the scope selector could not run in this tab\'s isolated inspection context ' +
        '(the tab is likely mid-navigation); retry, or read without a scope',
    }
  }
  // A malformed selector THROWS, and a thrown expression still returns a
  // `result`: the Error object, whose objectId passed every check the old
  // node-first version made. Named as the syntax error it is rather than
  // reported three lines later as "could not resolve the scope element".
  if (counted.exceptionDetails) {
    return { backendNodeId: null, error: `not a valid CSS selector: ${scopeSelector}` }
  }
  const value = counted.result?.value
  const matchCount = typeof value?.count === 'number' ? value.count : 0
  const matched = typeof value?.matched === 'string' ? value.matched : undefined
  if (matchCount < 1) {
    // The two limits of a SCOPE ride the miss, the way extract_text's own
    // selector miss carries its asymmetry: this resolves in the top
    // document's world and does not walk shadow roots, while the unscoped
    // tree includes both frames and shadow content. Told here rather than
    // appended by the backend, which cannot tell this miss from a typo or a
    // mid-navigation failure and so lectured about shadow roots on all three
    // (review round).
    return {
      backendNodeId: null,
      matchCount: 0,
      error:
        `scope selector matched no element: ${scopeSelector} (a scope resolves in ` +
        'the TOP document and does not walk shadow roots, so an element inside an ' +
        'iframe or a web component is not reachable here, though the unscoped tree ' +
        'renders both; scope to the frame with its @e ref, or read unscoped)',
    }
  }
  const evald = await withProbeWorld(tabId, (contextId) =>
    sendCommand<{ result?: { objectId?: string; subtype?: string }; exceptionDetails?: unknown }>(
      tabId,
      'Runtime.evaluate',
      {
        expression: `document.querySelector(${JSON.stringify(scopeSelector)})`,
        returnByValue: false,
        contextId,
      },
    ),
  )
  if (evald === null || evald.exceptionDetails) {
    return {
      backendNodeId: null,
      error:
        'the scope selector could not run in this tab\'s isolated inspection context ' +
        '(the tab is likely mid-navigation); retry, or read without a scope',
    }
  }
  if (!evald.result?.objectId || evald.result.subtype === 'null') {
    // Counted at least one and then resolved none: the page changed under the
    // read. Says that rather than repeating the no-match copy.
    return {
      backendNodeId: null,
      error: `the scope element went away mid-read: ${scopeSelector} (re-read the page)`,
    }
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
  return { backendNodeId, matchCount, matched }
}

export async function execSnapshot(args: unknown): Promise<CommandResult> {
  const a = args as SnapshotArgs
  if (typeof a.tab_id !== 'number') {
    return { ok: false, status: 'error', error: 'tab_id required' }
  }
  const detail = a.detail ?? 'interactive'
  // Sampled BEFORE anything is read, so the status probe at the end of this
  // command can prove it describes the document the tree came from. Unlike
  // extract_text, which answers everything in ONE evaluation, this read is
  // necessarily several round trips (#187 review round).
  const commitSeqBefore = commitSeq(a.tab_id)

  // Scope, when asked for, is resolved to a real backend node and used as the
  // tree root. The previous implementation only probed that a selector
  // matched something and then returned the whole page anyway, which quietly
  // made every scoped read a full read.
  let scopeNodeId: number | null = null
  let scopeFrameTargetId: string | undefined
  let scopeFrameUrl: string | undefined
  let scopeMatchCount: number | undefined
  let scopeMatched: string | undefined
  if (a.scope_ref || a.scope_selector) {
    const scoped = await resolveScopeNode(a.tab_id, a.scope_ref, a.scope_selector)
    if (scoped.error) return { ok: false, status: 'error', error: scoped.error }
    scopeNodeId = scoped.backendNodeId
    scopeFrameTargetId = scoped.frameTargetId
    scopeFrameUrl = scoped.frameUrl
    scopeMatchCount = scoped.matchCount
    scopeMatched = scoped.matched
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

  // Two soft probes, together: independent questions, neither blocks the read,
  // and one round trip beats two on every page read.
  //
  // The collapse-honesty probe (see VIEW_STATE_EXPRESSION), and the document's
  // own HTTP status (#187, docStatus.ts). The status gets its own expression
  // rather than riding the view-state one: that expression's contract is
  // BOOLEANS ONLY, and one probe answering two unrelated questions is how a
  // shared snippet drifts. Unlike the frame and control counts, the status
  // rides a SCOPED read too, because the claim it supports is about the tab's
  // main document and no scope can falsify that.
  const [viewState, docStatus] = await Promise.all([
    evaluateInProbeWorld<ViewState>(a.tab_id, VIEW_STATE_EXPRESSION),
    evaluateInProbeWorld<{ http_status: number | null }>(a.tab_id, DOC_STATUS_EXPRESSION),
  ])
  const viewConstrained =
    viewState != null && (viewState.modal_dialog || viewState.aria_modal || viewState.fullscreen)

  // The status describes the document that answered the PROBE, and the tree
  // came from an earlier round trip. A commit in between means they are two
  // different documents, and `withProbeWorld` makes that silent rather than
  // loud: it rebuilds the world in the NEW document and re-evaluates there.
  // Both directions are real: a soft 404 that redirects would answer 200 and
  // lose the note, and a 404 committing under a good page would render one
  // over it. So a read that straddles a commit says nothing (review round).
  const sameDocument = commitSeq(a.tab_id) === commitSeqBefore

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
      label = '',
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
        sections.push(`${pad}- iframe "${frameUrl}"${label}\n${indented}`)
        return true
      } catch {
        // One unreadable frame must not cost the whole page read. Visible in
        // the tree, but NOT counted as read.
        sections.push(`${pad}- iframe "${frameUrl}"${label} [unreadable]`)
        return false
      }
    }

    let framesOopifRendered = 0
    let framesLocalRendered = 0
    let framesNested = 0
    let framesSkipped = 0
    /** Same-process child frames of one session's document, in document
     *  order (deterministic ref numbering), capped with an honest tail. Each
     *  section's depth comes from the ONE plan every section is placed by
     *  (`planFrameSections`); `noteDepth` is the base indent of the document
     *  being listed, which is where the frame-cap tail belongs. `onFrame`
     *  runs right after each section, which is how a cross-origin child gets
     *  emitted under the frame that embeds it rather than after some
     *  unrelated frame. */
    const renderLocalFrames = async (
      sessionTarget: Cdp,
      local: LocalFrame[],
      depths: Map<string, number>,
      noteDepth = 0,
      onFrame?: (frameId: string) => Promise<void>,
    ): Promise<void> => {
      const toRead = local.slice(0, MAX_LOCAL_FRAMES)
      for (const f of toRead) {
        const tabId = a.tab_id
        const sessionId = typeof sessionTarget === 'number' ? undefined : sessionTarget.sessionId
        const depth = depths.get(f.frameId) ?? noteDepth
        if (
          await renderFrameSection({ tabId, sessionId, frameId: f.frameId }, f.frameId, f.url, depth)
        ) {
          framesLocalRendered += 1
          if (depth > 0) framesNested += 1
        }
        // Unconditional: an unreadable frame still HAS its cross-origin
        // children, and dropping them would lose whole documents.
        if (onFrame) await onFrame(f.frameId)
      }
      if (local.length > toRead.length) {
        const skipped = local.length - toRead.length
        framesSkipped += skipped
        // Padded with the section's own base indent: unpadded under an OOPIF
        // this rendered at the margin as a page-level claim (review round).
        sections.push(
          `${'  '.repeat(noteDepth)}- [${skipped} more frame(s) not read: frame cap reached]`,
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
    //
    // DISCOVER, then render (see `planFrameSections`): every tree is read
    // first, because an OOPIF's indentation depends on a parent that may be
    // another OOPIF, and a section cannot indent under one that has not
    // rendered yet. No extra CDP calls: these are the same `getFrameTree`
    // reads the local sweep always made.
    if (scopeNodeId == null) {
      const rootTree = await localFrameTree(a.tab_id)
      const sessions = frameSessions(a.tab_id)
      const discovered: (DiscoveredOopif & { sessionId: string; url: string })[] = []
      for (const frame of sessions) {
        discovered.push({
          targetId: frame.targetId,
          sessionId: frame.sessionId,
          url: frame.url,
          tree: await localFrameTree({ tabId: a.tab_id, sessionId: frame.sessionId }),
        })
      }
      const plan = planFrameSections(rootTree, discovered)
      type Discovered = (typeof discovered)[number]
      const done = new Set<string>()

      /** One cross-origin section, then everything nested inside it. The
       *  `done` set is both the no-duplicates guard and the cycle guard: a
       *  frame tree that claims its own ancestor as a child stops here. */
      async function renderOopif(o: Discovered, orphan = false): Promise<void> {
        if (done.has(o.targetId)) return
        done.add(o.targetId)
        const target: Cdp = { tabId: a.tab_id, sessionId: o.sessionId }
        // An ORPHAN is a frame whose embedding section was never rendered
        // (its parent frame sat past the frame cap). Indentation is the only
        // containment signal this tree has, so indenting it here would put it
        // under whatever line precedes it, which is the cap note. It goes at
        // the margin with the containment stated in words instead.
        const depth = orphan ? 0 : (plan.depth.get(o.targetId) ?? 0)
        const label = orphan ? ' [inside a frame that was not read]' : ''
        if (await renderFrameSection(target, o.targetId, o.url, depth, label)) {
          framesOopifRendered += 1
          if (depth > 0) framesNested += 1
        }
        await renderLocalFrames(target, o.tree.frames, plan.depth, depth + 1, renderOopifsUnder)
        await renderOopifsUnder(o.tree.root.frameId)
        await renderOopifsUnder(o.targetId)
      }

      /** The cross-origin frames embedded directly in one document. */
      async function renderOopifsUnder(frameId?: string): Promise<void> {
        if (!frameId) return
        for (const child of plan.childrenOf.get(frameId) ?? []) await renderOopif(child)
      }

      await renderLocalFrames(a.tab_id, rootTree.frames, plan.depth, 0, renderOopifsUnder)
      await renderOopifsUnder(rootTree.root.frameId)
      // Whatever the walk could not reach. An UNANCHORED frame's parent was
      // never resolvable, which the plan already reports as depth 0 (an
      // unknown nesting is reported as no nesting, never guessed); anything
      // still left is anchored to a frame that was not rendered, and says so
      // rather than indenting under a line it has nothing to do with.
      for (const o of plan.unanchored) await renderOopif(o)
      for (const o of discovered) await renderOopif(o, true)
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
        ...(sameDocument ? httpStatusField(docStatus?.http_status) : {}),
        // #208: how many refs are CONTROLS. Chrome marks every document
        // `focusable`, so each document root mints a ref through the property
        // path: a page of pure static text answers `ref_count: 2` (root plus a
        // frame) while nothing on it can be clicked or typed into, which read
        // live as a minting bug twice (#205, closed invalid). It must come off
        // THIS map, never off the tree text, which is page content and could
        // forge a ref-shaped line into the note the backend renders outside
        // the fence.
        //
        // A SCOPED read reports it too, over its own subtree. It was withheld
        // when the backend's only copy made a page-level claim ("this page has
        // none"), which a subtree cannot support, but scoping to a static
        // region is the flagship reason to scope at all: withholding it there
        // left the newly recommended route answering "0 actionable elements"
        // with no explanation, which is precisely the #205 loop the sentence
        // exists to stop. The backend picks region-shaped copy when it scoped
        // (#212 review round).
        control_ref_count: countControlRefs(allRefs),
        // How many the SCOPE SELECTOR matched, so the backend can say the read
        // is rooted at the first of them. Absent on a ref scope, which names
        // one element by construction.
        ...(scopeMatchCount != null ? { scope_match_count: scopeMatchCount } : {}),
        ...(scopeMatched ? { selector_matched: scopeMatched } : {}),
        // Frame counts stay withheld when scoped: they are claims about THIS
        // tree's sections, and a scoped read deliberately renders none, so
        // emitting the page's frame inventory there put a false "included"
        // note outside the fence (review round).
        ...(scopeNodeId == null
          ? {
              frames_oopif: framesOopifRendered,
              frames_same_process: framesLocalRendered,
              // Sections rendered INSIDE another frame rather than in the
              // page, both classes counted: without it the note read flat
              // while the tree it describes was indented.
              ...(framesNested ? { frames_nested: framesNested } : {}),
              ...(framesSkipped ? { frames_skipped: framesSkipped } : {}),
            }
          : {}),
        ...(viewConstrained ? { view_state: viewState } : {}),
        ...(Object.keys(hidden).length ? { hidden_dropped: hidden } : {}),
      },
    }
  })
}

export const __test = { formatTree, isInteractive, strVal, rootsOf, planFrameSections }
