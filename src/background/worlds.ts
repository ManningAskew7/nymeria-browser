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
 * TRUST PROBES share `nymeria_probe`, per frame session.
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
 * context id. Returns null on failure (logged; callers surface their own
 * degraded shape).
 *
 * On a FRAME session the eager domain enables never ran (`doAttach` enables
 * on the root only), and some Page commands require the agent enabled, so a
 * failure there earns one `Page.enable` + retry. Root sessions already have
 * Page enabled (#169) and skip that path. Frame targets do not own
 * tab-modal dialogs, so the enable does not re-route dialog events.
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
  try {
    const contextId = await attempt()
    if (contextId === null) logger.warn(`world creation returned nothing (${keyFor(target, worldName)})`)
    return contextId
  } catch (e) {
    if (sessionOf(target)) {
      try {
        await sendCommand(target, 'Page.enable', {})
        return await attempt()
      } catch (retryErr) {
        logger.warn(`world creation failed on frame session (${keyFor(target, worldName)}):`, retryErr)
        return null
      }
    }
    logger.warn(`world creation failed (${keyFor(target, worldName)}):`, e)
    return null
  }
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

/**
 * Mint an object handle for a DOM node IN the probe world. Everything later
 * called on that handle (`Runtime.callFunctionOn`) executes in the world,
 * which is what makes the one-handle design safe: probes and the mutating
 * helpers alike inherit pristine primitives from the handle itself.
 *
 * Returns null when the node no longer resolves OR no world can be had;
 * callers already treat a missing handle as their stale/degraded case.
 * Non-context CDP errors propagate (same contract as `withProbeWorld`).
 */
export async function resolveNodeInProbeWorld(
  target: Cdp,
  backendNodeId: number,
): Promise<string | null> {
  const objectId = await withProbeWorld(target, async (contextId) => {
    const resp = await sendCommand<{ object?: { objectId?: string } }>(target, 'DOM.resolveNode', {
      backendNodeId,
      executionContextId: contextId,
    })
    return resp.object?.objectId ?? null
  })
  return objectId
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
