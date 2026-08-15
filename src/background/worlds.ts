import { backgroundLogger as logger } from '../utils/logger'
import { sendCommand, sessionOf, tabOf, type Cdp, type SendCommandOpts } from './debuggerSession'

/**
 * Isolated execution worlds, the mechanism that stops a page lying to us.
 *
 * Every question this extension asks a page before trusting an action (where
 * an element is, what covers a point, whether focus landed, whether a
 * confirmation text appeared) used to run in the page's MAIN world, where the
 * page can override the primitives that answer it: a hostile
 * `getBoundingClientRect` steers a genuinely trusted click anywhere it likes,
 * and the overlay-interception refusal becomes a rubber stamp (backlog #160,
 * "the one with real teeth"). An isolated world shares the DOM but not the
 * globals: the page cannot see, patch, or delete anything in it, so its
 * pristine built-ins answer from real layout and real state.
 *
 * TWO worlds, deliberately. The delivery probe keeps its own
 * (`nymeria_delivery_probe`): it carries exclusive page-side state
 * (`__nymDelivery`) with a tested created-once-per-document lifecycle, and
 * sharing it would couple every probe's world churn to that invariant. All
 * TRUST PROBES share `nymeria_probe`, one per SESSION (the root page session
 * and each flattened OOPIF session get their own; a same-process subframe
 * has no session of its own and shares the root's, which is moot today
 * because refs are never minted inside one, see backlog #160).
 *
 * FAIL-CLOSED rule for callers: a trust probe that cannot get a world must
 * surface its existing degraded/failure shape, NEVER re-run in the main
 * world. A silent fallback would quietly reinstate the vulnerability this
 * module removes, which is worse than a visible failure. World-creation
 * failures are logged distinctly from probe failures so a regression is
 * diagnosable; a page cannot cause them (Page.createIsolatedWorld is
 * browser-side), so real ones are races (navigation, recycle, tab close).
 *
 * PROBE-BODY DISCIPLINE (review checklist item): script that runs in a world
 * must use only prototype-backed access, methods and IDL accessors
 * (`tagName`, `getAttribute(...)`, `closest(...)`, `isConnected`). Named
 * DOM properties are real DOM and follow you across worlds (`<input
 * name="...">` on a form, id-named globals), so a bare named lookup is the
 * one lie a pristine world does not stop.
 *
 * Worlds die with their document. Staleness is handled by ERROR, not by
 * event (the four context-gone message shapes below, retry-once), plus
 * explicit cache clears on top-frame commit, tab close, and frame-session
 * detach. Execution context ids are cached per (tab, session, world name);
 * frame sessions get their own world because a cross-origin frame's DOM is
 * only reachable from its own session.
 */

/** World for trust probes: geometry, hit tests, selectors, state reads. */
export const PROBE_WORLD = 'nymeria_probe'
/** World owned by delivery.ts; named here so the cache can host both. */
export const DELIVERY_WORLD = 'nymeria_delivery_probe'

/** `${tabId}:${sessionId|root}:${worldName}` -> executionContextId. */
const worlds = new Map<string, number>()

function keyFor(target: Cdp, worldName: string): string {
  return `${tabOf(target)}:${sessionOf(target) ?? 'root'}:${worldName}`
}

export function isContextGone(message: string): boolean {
  const m = message.toLowerCase()
  return (
    m.includes('cannot find context') ||
    m.includes('execution context was destroyed') ||
    m.includes('inspected target navigated') ||
    m.includes('target closed')
  )
}

/** Drop one cached world (its document, and so the context, went away). */
export function clearWorldEntry(target: Cdp, worldName: string): void {
  worlds.delete(keyFor(target, worldName))
}

/**
 * Drop every cached world for a tab: top-frame commits destroy the subframe
 * documents along with the top one, and a closed tab takes everything.
 */
export function clearTabWorlds(tabId: number): void {
  const prefix = `${tabId}:`
  for (const key of Array.from(worlds.keys())) {
    if (key.startsWith(prefix)) worlds.delete(key)
  }
}

/** Drop the worlds of one frame session (its target detached or navigated). */
export function clearSessionWorlds(tabId: number, sessionId: string): void {
  const prefix = `${tabId}:${sessionId}:`
  for (const key of Array.from(worlds.keys())) {
    if (key.startsWith(prefix)) worlds.delete(key)
  }
}

/**
 * Create the named world in the target's own root frame and cache its
 * context id. Returns null on failure (logged with its own line, distinct
 * from probe failures, so a regression is diagnosable; callers surface
 * their own honest shape and never fall back to the main world).
 *
 * FRAME sessions get one `Page.enable` + retry when the first attempt
 * fails, whichever way it fails (throw or empty answer). This retry was
 * dropped once as unevidenced and re-added the same day on a LIVE
 * measurement (2026-08-15 QA): on the user's Chrome, world creation on a
 * flattened OOPIF session failed until Page was enabled, so every click
 * inside a cross-origin iframe refused, while a review rig on Chrome 148
 * had measured the enable unnecessary. Chrome-version-dependent; the retry
 * covers both. Safe: enabling Page on a frame session does NOT re-route
 * tab-modal dialog ownership (measured, stays with the root session), and
 * root sessions already have Page enabled per attach (#169) so they skip
 * the retry. `grantUniveralAccess` is the protocol's own spelling.
 * Creating the same name+frame twice returns the SAME context id, so a
 * concurrent create is benign.
 */
export async function createWorld(target: Cdp, worldName: string): Promise<number | null> {
  const attempt = async (): Promise<number | null> => {
    const tree = await sendCommand<{ frameTree?: { frame?: { id?: string } } }>(
      target,
      'Page.getFrameTree',
      {},
    )
    const frameId = tree.frameTree?.frame?.id
    if (!frameId) return null
    const created = await sendCommand<{ executionContextId?: number }>(
      target,
      'Page.createIsolatedWorld',
      { frameId, worldName, grantUniveralAccess: false },
    )
    const contextId = created.executionContextId
    if (typeof contextId !== 'number') return null
    worlds.set(keyFor(target, worldName), contextId)
    return contextId
  }
  let firstError: unknown = null
  let contextId: number | null = null
  try {
    contextId = await attempt()
  } catch (e) {
    firstError = e
  }
  if (contextId !== null) return contextId
  if (!sessionOf(target)) {
    logger.warn(
      `world creation failed (${keyFor(target, worldName)}):`,
      firstError ?? 'no context returned',
    )
    return null
  }
  try {
    await sendCommand(target, 'Page.enable', {})
    const second = await attempt()
    if (second === null) {
      logger.warn(`frame world creation returned nothing after Page.enable (${keyFor(target, worldName)})`)
    }
    return second
  } catch (retryErr) {
    logger.warn(`frame world creation failed even after Page.enable (${keyFor(target, worldName)}):`, retryErr)
    return null
  }
}

/**
 * The fail-closed refusal for a trust step that could not get its world.
 * Lives here, beside the rule it implements. Transient by nature: a page
 * cannot cause it (world creation is browser-side), so real ones are races
 * (navigation, worker recycle, tab close).
 */
export function probeWorldUnavailableError(what: string): string {
  return (
    `${what} could not run in this tab's isolated inspection context (the tab is ` +
    'likely mid-navigation or was just closed). Retry, and if it persists ' +
    're-read the page or use a fresh tab.'
  )
}

/** Cache-or-create. */
export async function worldFor(target: Cdp, worldName: string): Promise<number | null> {
  const cached = worlds.get(keyFor(target, worldName))
  if (cached !== undefined) return cached
  return createWorld(target, worldName)
}

/** Cache-only read, for callers that must not pay a creation (delivery's
 *  frameless check runs only when a world already answered an arm). */
export function cachedWorld(target: Cdp, worldName: string): number | undefined {
  return worlds.get(keyFor(target, worldName))
}

/**
 * Run `fn` against the probe world's context id, rebuilding the world ONCE
 * when the cached context died with its document. Returns null when no world
 * can be had (the caller's fail-closed shape applies); every non-context
 * error PROPAGATES, so session-layer failures (`CdpCallTimeout`,
 * `TabUnusable`) keep the honest copy their classes already carry.
 */
export async function withProbeWorld<T>(
  target: Cdp,
  fn: (contextId: number) => Promise<T>,
): Promise<T | null> {
  let contextId = await worldFor(target, PROBE_WORLD)
  if (contextId === null) return null
  try {
    return await fn(contextId)
  } catch (e) {
    if (!(e instanceof Error) || !isContextGone(e.message)) throw e
    clearWorldEntry(target, PROBE_WORLD)
    contextId = await createWorld(target, PROBE_WORLD)
    if (contextId === null) return null
    return fn(contextId)
  }
}

export type NodeInProbeWorld =
  | { ok: true; objectId: string }
  /** The node no longer resolves: the element is genuinely gone or detached
   *  (the caller's STALE story applies). */
  | { ok: false; reason: 'no-node' }
  /** No world could be created: nothing about the ELEMENT is known (the
   *  caller must not tell a stale story; `probeWorldUnavailableError` is the
   *  honest copy). */
  | { ok: false; reason: 'no-world' }

/**
 * Mint an object handle for a DOM node IN the probe world. Everything later
 * called on that handle (`Runtime.callFunctionOn`) executes in the world,
 * which is what makes the one-handle design safe: probes and the mutating
 * helpers alike inherit pristine primitives from the handle itself.
 *
 * The two failures are DISTINCT on purpose: `no-node` means the element is
 * gone (stale ref, tell the agent to re-read), `no-world` means the probe
 * infrastructure itself was unavailable and nothing about the element was
 * learned. Conflating them made a world-creation hiccup read as "your ref
 * went stale", sending the agent on a pointless re-read loop (review round).
 * Non-context CDP errors propagate (same contract as `withProbeWorld`).
 */
export async function resolveNodeInProbeWorld(
  target: Cdp,
  backendNodeId: number,
): Promise<NodeInProbeWorld> {
  const result = await withProbeWorld(target, async (contextId) => {
    const resp = await sendCommand<{ object?: { objectId?: string } }>(target, 'DOM.resolveNode', {
      backendNodeId,
      executionContextId: contextId,
    })
    const objectId = resp.object?.objectId
    return objectId ? ({ ok: true, objectId } as NodeInProbeWorld) : ({ ok: false, reason: 'no-node' } as NodeInProbeWorld)
  })
  return result ?? { ok: false, reason: 'no-world' }
}

/**
 * Evaluate an expression in the probe world, SOFT variant: any failure
 * (world unavailable, evaluate threw, exception in page) reports undefined,
 * for probes whose callers keep their own degraded answer (describePoint's
 * null, viewportCentre's fallback centre, performWait's keep-polling).
 * Never falls back to the main world.
 */
export async function evaluateInProbeWorld<T>(
  target: Cdp,
  expression: string,
  opts: SendCommandOpts = {},
): Promise<T | undefined> {
  try {
    const result = await withProbeWorld(target, async (contextId) => {
      const resp = await sendCommand<{ result?: { value?: T }; exceptionDetails?: unknown }>(
        target,
        'Runtime.evaluate',
        { expression, contextId, returnByValue: true },
        opts,
      )
      if (resp.exceptionDetails) return undefined
      return resp.result?.value
    })
    return result === null ? undefined : result
  } catch {
    return undefined
  }
}

export function resetForTests(): void {
  worlds.clear()
}
