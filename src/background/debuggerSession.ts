import { backgroundLogger as logger } from '../utils/logger'

/**
 * Ref-counted Chrome DevTools Protocol sessions per tab.
 *
 * Attach is expensive (shows the yellow "is being debugged" banner) and
 * pages glitch when re-attached. Multiple in-flight commands on the same
 * tab share one attach. We detach 10s after the last release so a rapid
 * back-to-back sequence of `chrome_*` commands doesn't flicker the banner.
 *
 * Two things ride on the attach beyond one-shot commands:
 *
 *  - Enabled CDP domains, tracked per session. `Runtime.enable` and friends
 *    are sent once per attach and forgotten when the attach ends, so a
 *    re-attach re-enables rather than assuming stale state.
 *  - CDP events. `chrome.debugger.onEvent` is a single global stream for
 *    every attached tab, so it is routed here once and fanned out to
 *    subscribers. This is how console and network capture work WITHOUT host
 *    permissions: `chrome.debugger` needs none, while `chrome.scripting`
 *    injection does.
 */

const DEBUGGER_VERSION = '1.3'
const DETACH_LINGER_MS = 10_000

/**
 * Domains enabled on every attach so their event streams are never late.
 *
 * `Page` is here DELIBERATELY (#169). Enabling it takes ownership of JS
 * dialogs: every `javascriptDialogOpening` must be answered with
 * `handleJavaScriptDialog` or the renderer stalls. That ownership is the
 * point, not the hazard: `dialogs.ts` listens and answers by policy (alert
 * acked immediately, confirm/prompt/beforeunload held for the agent with a
 * timed safe default), so a dialog can never wedge the tab on our watch,
 * and the file-chooser interception armed below rides the same enable.
 * Ownership spans exactly the attach and ends with it; a dialog raised
 * outside an attach is not ours and cannot be (a reactive enable does not
 * own a dialog already standing; measured).
 */
const CAPTURE_DOMAINS = ['Runtime', 'Network', 'Page'] as const

/**
 * A CDP addressee: a tab (the root page session) or one flattened frame
 * session inside it.
 *
 * Cross-origin iframes run in their own renderer process and are NOT in the
 * page's tree: `Page.getFrameTree` skips them and `getFullAXTree({frameId})`
 * cannot resolve them. The only route from an extension is auto-attach with
 * `flatten: true`, addressing each frame by `sessionId`. That matters because
 * payment fields and consent dialogs almost always live in one.
 */
export interface CdpTarget {
  tabId: number
  sessionId?: string
}

export type Cdp = number | CdpTarget

export function tabOf(target: Cdp): number {
  return typeof target === 'number' ? target : target.tabId
}

export function sessionOf(target: Cdp): string | undefined {
  return typeof target === 'number' ? undefined : target.sessionId
}

function debuggee(target: Cdp): chrome.debugger.Debuggee {
  const tabId = tabOf(target)
  const sessionId = sessionOf(target)
  return (sessionId ? { tabId, sessionId } : { tabId }) as chrome.debugger.Debuggee
}

export interface FrameSession {
  sessionId: string
  /** Also the frame's Page.FrameId: both are the devtools frame token. */
  targetId: string
  url: string
}

interface Session {
  refCount: number
  detachTimer: ReturnType<typeof setTimeout> | null
  attached: boolean
  /** The one in-flight attach, shared by every concurrent cold acquire. */
  attaching: Promise<void> | null
  /** The in-flight detach a concurrent acquire must wait out, never join. */
  detaching: Promise<void> | null
  /**
   * True while a `detachNow` is driving this session (gate included). The
   * linger can expire AGAIN mid-gate (a gate-time command bumps and releases
   * the refcount), and a second detachNow would double-detach and double-fire
   * session end; the first invocation re-checks the world after its gate and
   * owns the outcome alone.
   */
  detachPending: boolean
  domains: Set<string>
  /** Flattened out-of-process iframe sessions, keyed by sessionId. */
  frames: Map<string, FrameSession>
}

const sessions = new Map<number, Session>()

/**
 * Every CDP call gets a bounded lifetime.
 *
 * `chrome.debugger.sendCommand` has no timeout of its own, and a discarded or
 * frozen tab simply never answers an enable (measured externally: 14 of 20
 * tabs on one real profile), so an unbounded await here never settles. That is
 * worse than slow: a pending extension API call holds the MV3 service worker
 * alive to Chrome's 5-minute hard kill, which then drops the snapshot ref map
 * and this file's attach bookkeeping, and the agent experiences the loss as
 * unrelated intermittent failure a command later. Backlog #165 (C-02, L-01).
 *
 * The default is sized above the calls this extension makes in earnest
 * (`Accessibility.getFullAXTree` on a heavy page and a full-page capture run
 * seconds, not tens of seconds, though neither is pinned by measurement) and
 * below the transport budgets of the commands that lean on the renderer:
 * act 30s, snapshot and screenshot 20s, cdp 60s. It is NOT below every
 * budget: tabs, console and network get 5s from the backend but barely touch
 * CDP (an attach, a local buffer read), and `dialog`, whose 5s budget would
 * always expire first, passes its own smaller deadline so its failure stays
 * ours and named. Callers with a legitimately LONGER wait override upward:
 * `settle()` runs an in-page probe whose budget the agent controls, and
 * `cdp` forwards arbitrary methods.
 */
export const CDP_CALL_DEADLINE_MS = 15_000

/** How long a detach gets before we stop waiting and drop the bookkeeping. */
const DETACH_CALL_DEADLINE_MS = 5_000

/**
 * Both messages hedge on effect deliberately: a call that timed out or was
 * detached mid-flight may already have mutated the page (the same ambiguity
 * `InputDispatchStalled.landed` exists for), so neither may read as "nothing
 * happened". And the remedies must match `assertUsableTab`'s: reload recovers
 * a discarded or frozen tab; closing is for the rest.
 */
export class CdpCallTimeout extends Error {
  constructor(method: string, ms: number) {
    super(
      `Chrome did not answer ${method} for this tab within ${Math.round(ms / 1000)}s: ` +
        'it may be suspended by a page dialog raised before this session was ' +
        'driving the tab (an owned dialog would have been named to you when it ' +
        'opened), frozen or discarded mid-command, or its renderer may be gone. ' +
        'Whether the call took effect is unknown, so do not repeat an action ' +
        'that changes state without checking. Reload recovers a discarded or ' +
        'frozen tab; otherwise close it and redo the work in a fresh one.',
    )
    this.name = 'CdpCallTimeout'
  }
}

/** A tab refused before attach because its renderer provably is not running. */
export class TabUnusable extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TabUnusable'
  }
}

interface PendingCall {
  reject: (e: Error) => void
}

/** In-flight CDP calls per tab, so an external detach can fail them NOW. */
const pendingCalls = new Map<number, Set<PendingCall>>()

/**
 * The raw bounded call. No refcounting here: `doAttach`'s eager domain
 * enables use this directly because they ride the attach that `acquire` is
 * already paying for.
 *
 * The underlying promise keeps its handlers attached after the deadline
 * fires, so a call that Chrome answers late (the user dismissing a dialog
 * minutes on) settles silently instead of as an unhandled rejection.
 */
function boundedCdpCall<T>(
  target: Cdp,
  method: string,
  params: Record<string, unknown>,
  deadlineMs: number,
): Promise<T> {
  const tabId = tabOf(target)
  return new Promise<T>((resolve, reject) => {
    let done = false
    const finish = (settle: () => void) => {
      if (done) return
      done = true
      clearTimeout(timer)
      const tabSet = pendingCalls.get(tabId)
      if (tabSet) {
        tabSet.delete(entry)
        if (tabSet.size === 0) pendingCalls.delete(tabId)
      }
      settle()
    }
    const entry: PendingCall = { reject: (e) => finish(() => reject(e)) }
    const timer = setTimeout(() => entry.reject(new CdpCallTimeout(method, deadlineMs)), deadlineMs)
    let set = pendingCalls.get(tabId)
    if (!set) {
      set = new Set()
      pendingCalls.set(tabId, set)
    }
    set.add(entry)
    // The extension bindings THROW synchronously on a schema violation (a
    // non-object params, say, via chrome_cdp's forwarded args). Without the
    // catch that throw would reject the outer promise while leaving the timer
    // armed for the full deadline, pinning the worker for exactly the reason
    // this helper exists to remove.
    let raw: Promise<unknown>
    try {
      raw = Promise.resolve(chrome.debugger.sendCommand(debuggee(target), method, params))
    } catch (err) {
      finish(() => reject(err instanceof Error ? err : new Error(String(err))))
      return
    }
    raw.then(
      (result) => finish(() => resolve(result as T)),
      (err: unknown) => finish(() => reject(err instanceof Error ? err : new Error(String(err)))),
    )
  })
}

export type CdpEventHandler = (tabId: number, method: string, params: unknown) => void

const eventHandlers = new Set<CdpEventHandler>()

/**
 * A single gate a voluntary detach must clear first (#169: an owned dialog
 * must be resolved before the attach that owns it ends). One registrant, the
 * dialog-ownership module; a registry of many would imply an ordering nobody
 * has designed. The gate must itself be bounded: `detachNow` awaits it
 * unconditionally.
 */
type DetachGate = (tabId: number) => Promise<void>
let detachGate: DetachGate | null = null

export function registerDetachGate(gate: DetachGate): void {
  detachGate = gate
}

/**
 * Callbacks run whenever an attach ENDS, on every path: voluntary detach,
 * external detach, and a detach Chrome never answered. Ownership state keyed
 * to the attach (standing dialogs) must be reconciled here, not in the
 * command layer, which never learns about external detaches.
 */
type SessionEndHandler = (tabId: number) => void
const sessionEndHandlers = new Set<SessionEndHandler>()

export function onSessionEnd(handler: SessionEndHandler): () => void {
  sessionEndHandlers.add(handler)
  return () => sessionEndHandlers.delete(handler)
}

function fireSessionEnd(tabId: number): void {
  for (const handler of sessionEndHandlers) {
    try {
      handler(tabId)
    } catch (e) {
      logger.warn(`session-end handler failed tab=${tabId}:`, e)
    }
  }
}

/**
 * Subscribe to CDP events for every attached tab. Returns an unsubscribe fn.
 * Handlers must not throw; a throwing handler is logged and skipped so one
 * bad subscriber cannot starve the others.
 */
export function onCdpEvent(handler: CdpEventHandler): () => void {
  eventHandlers.add(handler)
  return () => eventHandlers.delete(handler)
}

function routeCdpEvent(source: { tabId?: number }, method: string, params: unknown): void {
  const tabId = source.tabId
  if (typeof tabId !== 'number') return
  for (const handler of eventHandlers) {
    try {
      handler(tabId, method, params)
    } catch (e) {
      logger.warn(`CDP event handler failed for ${method}:`, e)
    }
  }
}

/**
 * Registered at module load: MV3 wants listeners bound synchronously at the
 * service-worker top level. Exported so tests can re-bind after swapping in a
 * fresh `chrome` mock.
 */
export function installCdpEventRouter(): void {
  chrome.debugger.onEvent.addListener(routeCdpEvent)
}

installCdpEventRouter()

/** Chrome names why it detached us; hand the agent that name, not a guess. */
function detachReasonProse(reason: string | undefined): string {
  switch (reason) {
    case 'target_closed':
      return 'the tab or its page went away'
    case 'canceled_by_user':
      return 'the user cancelled the debug session via the banner'
    case 'replaced_with_devtools':
      return 'DevTools was opened on the tab'
    case 'rendering_process_gone':
      return 'the tab renderer process is gone (it crashed or was killed)'
    default:
      return 'DevTools was opened on it, the tab went away, or the user cancelled via the banner'
  }
}

// Chrome detaches us unilaterally when DevTools opens on the tab, when the
// tab navigates to a protected page, or when the target goes away. Without
// this the session would stay marked attached and every later sendCommand
// would fail with "Debugger is not attached". In-flight calls are failed NOW
// rather than left to their deadline: whether Chrome rejects a pending
// command on detach is undocumented, and a call that will never be answered
// should say so the moment that becomes known. Exported like
// `installCdpEventRouter` so tests can re-bind after swapping the chrome mock.
export function installDetachHandler(): void {
  chrome.debugger.onDetach?.addListener?.((source, reason) => {
    const tabId = source.tabId
    if (typeof tabId !== 'number') return
    const pending = pendingCalls.get(tabId)
    if (pending) {
      pendingCalls.delete(tabId)
      const err = new Error(
        `Chrome detached the debugger from this tab mid-call: ${detachReasonProse(reason)}. ` +
          'The command did not finish, and whether it took effect first is unknown, so ' +
          'do not repeat an action that changes state without checking.',
      )
      err.name = 'CdpDetached'
      for (const p of Array.from(pending)) p.reject(err)
    }
    // Chrome has already detached: nothing can be sent on this path, so the
    // gate is not consulted; ownership state is reconciled instead. Fired
    // whether or not a session entry survives to this point, because the
    // ownership state lives elsewhere and must not depend on this map's
    // bookkeeping races.
    fireSessionEnd(tabId)
    const s = sessions.get(tabId)
    if (!s) return
    if (s.detachTimer) clearTimeout(s.detachTimer)
    logger.log(`debugger detached externally tab=${tabId} reason=${reason ?? 'unknown'}`)
    sessions.delete(tabId)
  })
}

installDetachHandler()

function getOrCreate(tabId: number): Session {
  let s = sessions.get(tabId)
  if (!s) {
    s = {
      refCount: 0,
      detachTimer: null,
      attached: false,
      attaching: null,
      detaching: null,
      detachPending: false,
      domains: new Set(),
      frames: new Map(),
    }
    sessions.set(tabId, s)
  }
  return s
}

/**
 * Ask a session to auto-attach to its out-of-process child frames.
 *
 * Auto-attach is NOT recursive: each newly attached child must be armed in
 * turn or grandchild frames never appear. `waitForDebuggerOnStart` must stay
 * false; true is reported to hang iframes when driven from an extension.
 */
async function armAutoAttach(target: Cdp): Promise<void> {
  try {
    await boundedCdpCall(target, 'Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: [{ type: 'iframe', exclude: false }],
    }, CDP_CALL_DEADLINE_MS)
  } catch (e) {
    // Older Chrome, or a frame type that refuses: frame reach degrades to the
    // main document rather than the whole command failing.
    logger.warn('Target.setAutoAttach failed:', e)
  }
}

let frameTrackingInstalled = false

/**
 * Track flattened frame sessions as Chrome hands them to us. Idempotent, and
 * re-armed by `resetForTests`, since clearing the handler set would otherwise
 * silently drop frame discovery for the rest of the process.
 */
export function installFrameTracking(): void {
  if (frameTrackingInstalled) return
  frameTrackingInstalled = true
  onCdpEvent((tabId, method, params) => {
    if (method === 'Target.attachedToTarget') {
      const p = params as {
        sessionId?: string
        targetInfo?: { targetId?: string; type?: string; url?: string }
      }
      if (!p.sessionId || p.targetInfo?.type !== 'iframe') return
      const session = sessions.get(tabId)
      if (!session) return
      session.frames.set(p.sessionId, {
        sessionId: p.sessionId,
        targetId: p.targetInfo.targetId ?? '',
        url: p.targetInfo.url ?? '',
      })
      // Arm the child so ITS out-of-process children surface too.
      void armAutoAttach({ tabId, sessionId: p.sessionId })
      return
    }
    if (method === 'Target.detachedFromTarget') {
      const p = params as { sessionId?: string }
      if (p.sessionId) sessions.get(tabId)?.frames.delete(p.sessionId)
    }
  })
}

installFrameTracking()

/** Flattened cross-origin frame sessions currently known for a tab. */
export function frameSessions(tabId: number): FrameSession[] {
  return Array.from(sessions.get(tabId)?.frames.values() ?? [])
}

/**
 * The LIVE session for a frame's stable target id, waiting briefly for
 * auto-attach to announce it.
 *
 * Sessions are ephemeral: the tab detaches 10s after its last command
 * (DETACH_LINGER_MS), killing every frame session, and the next attach
 * re-announces the same frames under NEW session ids. Anything durable
 * (refs) therefore keys on the frame's target id, which Chrome keeps stable
 * for the frame element's lifetime, and maps to a session here at use time.
 * The wait covers the re-attach race: `Target.attachedToTarget` events for
 * existing frames arrive moments after the attach that the caller already
 * holds, so a miss on the first look usually resolves within milliseconds.
 * A frame that never appears within the bound is genuinely gone (removed
 * from the page, or the whole document replaced).
 */
export async function frameSessionByTargetId(
  tabId: number,
  targetId: string,
  waitMs = 1_500,
): Promise<FrameSession | null> {
  const deadline = Date.now() + waitMs
  for (;;) {
    const hit = frameSessions(tabId).find((f) => f.targetId === targetId)
    if (hit) return hit
    if (Date.now() >= deadline) return null
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/**
 * Refuse to attach to a tab whose renderer provably is not running.
 *
 * A discarded tab (Chrome unloaded it to save memory) has no renderer at all,
 * so it never answers the enables an attach fires, and every command against
 * it used to spend its whole deadline learning nothing. `chrome.tabs.get`
 * answers from the browser process in under a millisecond and names the state
 * outright, an extension-only advantage no external CDP client has; and
 * reload provably recovers it, costing nothing a discard had not already
 * destroyed. Only a POSITIVE signal refuses: a tab the browser cannot find
 * falls through so `chrome.debugger.attach` can produce its own honest error.
 *
 * A FROZEN tab is deliberately NOT refused. Chromium's freezing policy opts
 * out tabs "currently being inspected by DevTools", which makes it plausible
 * that attaching unfreezes the tab, and a refusal would then fail a path
 * that was about to work; the false refusal is the expensive direction, and
 * unlike a discard, reload on a frozen tab DESTROYS state (its page is still
 * in memory and unfreezes losslessly on activation). If the optimism is
 * wrong, `CdpCallTimeout` names frozen among its causes.
 */
async function assertUsableTab(tabId: number): Promise<void> {
  const tab = await chrome.tabs.get(tabId).catch(() => null)
  if (tab?.discarded) {
    throw new TabUnusable(
      `tab ${tabId} is discarded: Chrome unloaded it to save memory, so nothing can ` +
        `run in it. Reload it with chrome_tabs(action="reload", tab_id=${tabId}) to ` +
        'bring it back, then retry.',
    )
  }
}

/** The one cold attach for a session, whatever the number of waiters. */
async function doAttach(tabId: number, s: Session): Promise<void> {
  try {
    await assertUsableTab(tabId)
    // Bounded like everything else. Attach is a browser-process call that
    // should not hang, but "should not hang" was sendCommand's story too, and
    // `console`/`network` reach CDP only through this attach.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new CdpCallTimeout('debugger attach', CDP_CALL_DEADLINE_MS)),
        CDP_CALL_DEADLINE_MS,
      )
      Promise.resolve(chrome.debugger.attach({ tabId }, DEBUGGER_VERSION)).then(
        () => {
          clearTimeout(timer)
          resolve()
        },
        (e: unknown) => {
          clearTimeout(timer)
          reject(e instanceof Error ? e : new Error(String(e)))
        },
      )
    })
    s.attached = true
    s.domains.clear()
    logger.log(`debugger attached tab=${tabId}`)
    // Runtime carries console messages and uncaught exceptions; Network
    // carries request failures. Both feed the post-action verification
    // payload, so both are enabled eagerly: capture that starts when you
    // first ASK is capture that is always empty the first time you ask.
    // Through boundedCdpCall, NOT sendCommand: these ride the attach that
    // acquire is already paying for, and re-entering acquire from here would
    // churn the refcount and the detach linger for no benefit. Bounded so a
    // wedged tab's never-settling enables cannot hold the service worker
    // toward its 5-minute kill.
    for (const domain of CAPTURE_DOMAINS) {
      void boundedCdpCall(tabId, `${domain}.enable`, {}, CDP_CALL_DEADLINE_MS)
        .then(() => {
          sessions.get(tabId)?.domains.add(domain)
        })
        .catch((e: unknown) => logger.warn(`${domain}.enable failed tab=${tabId}:`, e))
      // Chooser interception is a silent no-op unless the SAME client has
      // Page enabled, so it must FOLLOW Page.enable; dispatched back-to-back
      // rather than on the response, because CDP processes one session's
      // commands in order, and chaining on the response left the first action
      // of a cold attach a round trip where a chooser could still open
      // (review, #169). While armed (the whole attach; it dies with the
      // session), no OS file chooser can open in this tab:
      // `Page.fileChooserOpened` fires instead and `dialogs.ts` records it
      // for act to report. Page-wide while armed, so the user's own "Choose
      // File" during a burst + linger is swallowed too; accepted, and
      // documented in SKILL.md.
      if (domain === 'Page') {
        void boundedCdpCall(
          tabId,
          'Page.setInterceptFileChooserDialog',
          { enabled: true },
          CDP_CALL_DEADLINE_MS,
        ).catch((e: unknown) =>
          logger.warn(`setInterceptFileChooserDialog failed tab=${tabId}:`, e),
        )
      }
    }
    // Start discovering cross-origin frames immediately: they attach
    // asynchronously, so arming at attach time means they are usually known
    // by the time the first page read happens.
    void armAutoAttach(tabId)
  } finally {
    s.attaching = null
  }
}

export async function acquire(tabId: number): Promise<void> {
  // A detach in flight must FINISH before a new session starts. Joining the
  // old entry mid-detach left a caller holding a ref to a session that was
  // deleted underneath it the moment the detach resolved (verified by review
  // probe): its release then no-opped against nothing and its command got
  // "Debugger is not attached". Wait it out, drop the dead entry, start cold.
  const stale = sessions.get(tabId)
  if (stale?.detaching) {
    await stale.detaching
    if (sessions.get(tabId) === stale) sessions.delete(tabId)
  }
  const s = getOrCreate(tabId)
  if (s.detachTimer) {
    clearTimeout(s.detachTimer)
    s.detachTimer = null
  }
  s.refCount += 1
  if (!s.attached) {
    // One shared in-flight attach: two concurrent cold acquires used to BOTH
    // call chrome.debugger.attach, and the loser's "already attached" error
    // failed a command that should have ridden the winner's session (verified
    // by review probe; the tabs.get pre-flight had widened that window).
    if (!s.attaching) s.attaching = doAttach(tabId, s)
    try {
      await s.attaching
    } catch (e) {
      // Roll back only OUR increment; every waiter does the same for its own.
      // Callers that never got a session never release it, so keeping the
      // count would strand the entry above zero and no detach would ever be
      // scheduled once a later attach succeeded.
      s.refCount = Math.max(0, s.refCount - 1)
      throw e
    }
  }
}

export function release(tabId: number): void {
  const s = sessions.get(tabId)
  if (!s) return
  s.refCount = Math.max(0, s.refCount - 1)
  if (s.refCount === 0 && s.attached) {
    if (s.detachTimer) clearTimeout(s.detachTimer)
    s.detachTimer = setTimeout(() => {
      void detachNow(tabId)
    }, DETACH_LINGER_MS)
  }
}

async function detachNow(tabId: number): Promise<void> {
  const s = sessions.get(tabId)
  if (!s) return
  // Single-flight per session: see `detachPending`. The first invocation
  // clears any timer a mid-gate release re-armed, so nothing is lost by
  // yielding here.
  if (s.detachPending) return
  if (s.refCount > 0) {
    // Someone re-acquired during the linger window.
    s.detachTimer = null
    return
  }
  s.detachPending = true
  s.detachTimer = null
  // The gate first (#169): an owned dialog must be resolved before the
  // attach that owns it ends, so a standing confirm effectively EXTENDS the
  // linger to its own resolution (answer, user, or the grace default). The
  // gate's own answer call rides acquire/release, which can bump the
  // refcount and re-arm a fresh linger timer mid-gate, so both are
  // re-checked after: a live caller wins and this detach stands down (its
  // release schedules the next one), and a re-armed timer is cleared so a
  // second detachNow does not chase this one.
  if (detachGate) {
    try {
      await detachGate(tabId)
    } catch (e) {
      logger.warn(`detach gate failed tab=${tabId}:`, e)
    }
    if (sessions.get(tabId) !== s) return
    if (s.refCount > 0) {
      s.detachTimer = null
      s.detachPending = false
      return
    }
    if (s.detachTimer) {
      clearTimeout(s.detachTimer)
      s.detachTimer = null
    }
  }
  // Bounded like every other debugger call: a detach against a wedged tab
  // that never answers must not strand the bookkeeping (or the worker).
  // Whatever happens, the session entry is dropped: Chrome reconciles its own
  // side on the next attach. Published on `detaching` so a concurrent
  // `acquire` waits this out and starts a fresh session, instead of joining
  // an entry that is about to be deleted underneath it.
  s.detaching = new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      logger.warn(`debugger detach did not answer tab=${tabId}`)
      resolve()
    }, DETACH_CALL_DEADLINE_MS)
    Promise.resolve(chrome.debugger.detach({ tabId })).then(
      () => {
        clearTimeout(timer)
        logger.log(`debugger detached tab=${tabId}`)
        resolve()
      },
      (e: unknown) => {
        clearTimeout(timer)
        logger.warn(`debugger detach failed tab=${tabId}:`, e)
        resolve()
      },
    )
  })
  await s.detaching
  // Guarded, session end included: an external detach may already have ended
  // this session (firing session end itself) and a fresh one may be LIVE by
  // the time a slow detach call answers. A stale session-end here would wipe
  // the live session's dialog-ownership state (review probe, #169).
  if (sessions.get(tabId) === s) {
    sessions.delete(tabId)
    fireSessionEnd(tabId)
  }
}

export interface SendCommandOpts {
  /**
   * Wall-clock bound for this one call, replacing `CDP_CALL_DEADLINE_MS`.
   * For a call whose legitimate duration the caller knows better, in either
   * direction: `settle()` and `cdp` override upward, `dialog` downward.
   */
  deadlineMs?: number
}

export async function sendCommand<T = unknown>(
  target: Cdp,
  method: string,
  params: Record<string, unknown> = {},
  opts: SendCommandOpts = {},
): Promise<T> {
  const tabId = tabOf(target)
  await acquire(tabId)
  try {
    return await boundedCdpCall<T>(target, method, params, opts.deadlineMs ?? CDP_CALL_DEADLINE_MS)
  } finally {
    // Runs at the deadline too, not only on an answer: an abandoned call must
    // not pin the refcount, or a wedged tab keeps its debugger banner for the
    // life of the worker instead of losing it a linger after the deadline.
    release(tabId)
  }
}

export async function withSession<T>(tabId: number, fn: () => Promise<T>): Promise<T> {
  await acquire(tabId)
  try {
    return await fn()
  } finally {
    release(tabId)
  }
}

export function activeTabs(): number[] {
  return Array.from(sessions.entries())
    .filter(([, s]) => s.attached)
    .map(([tabId]) => tabId)
}

export function isAttached(tabId: number): boolean {
  return sessions.get(tabId)?.attached === true
}

export function resetForTests(): void {
  for (const [, s] of sessions) {
    if (s.detachTimer) clearTimeout(s.detachTimer)
  }
  sessions.clear()
  pendingCalls.clear()
  eventHandlers.clear()
  // A test-registered gate must not leak into the next test: a never-resolving
  // one parks every later voluntary detach and masks real behavior. The
  // dialogs module re-registers its own via `resetDialogsForTests`.
  detachGate = null
  frameTrackingInstalled = false
  installFrameTracking()
}
