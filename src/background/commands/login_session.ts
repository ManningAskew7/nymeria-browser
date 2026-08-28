import { backgroundLogger as logger } from '../../utils/logger'
import { postLoginFrames } from '../api'
import { acquire, onSessionEnd, onCdpEvent, release, sendCommand } from '../debuggerSession'
import { evaluateInProbeWorld } from '../worlds'
import { viewportReadExpression } from '../viewportStamp'
import {
  dispatchKey,
  insertText,
  trustedClick,
  trustedHover,
  trustedWheel,
} from '../input'
import type { CommandResult } from '../../shared/types'

/**
 * The extension half of the human login handoff: screencast a tab out to
 * nymeria-desktop, and replay the operator's input back into it.
 *
 * This is how a person signs the agent's browser into a site without the
 * password ever passing through the agent. The backend owns the session
 * (`core/browser_login_sessions.py`) and refuses every `chrome_*` command
 * aimed at a tab while one is live; this module owns the two things only
 * the extension can do: capture the pixels, and produce trusted input.
 *
 * Three engineering facts here were measured, not reasoned, and each one
 * fails SILENTLY when got wrong:
 *
 * - `Page.startScreencast` defaults to PNG, which measured ~67x the bytes
 *   of `format: 'jpeg'` at quality 60. Always pass the format.
 * - Every frame MUST be acked (`Page.screencastFrameAck`). Chrome allows
 *   three frames in flight and then simply stops sending, with no error:
 *   a missing ack looks exactly like a page that stopped changing.
 * - Screencast is CHANGE-driven, not clock-driven. A still login form
 *   emits about one frame and then nothing, which is correct and must not
 *   be read as a stall. Liveness is the session's own business, not the
 *   frame rate's.
 *
 * Two design choices worth keeping:
 *
 * **Adaptive batching with no timer.** At most one frame POST is in flight
 * at a time; frames that arrive during it queue up and go together in the
 * next one. On a fast link that settles at roughly one frame per POST, and
 * on a slow one it coalesces into larger batches on its own. A fixed batch
 * window would have to choose between latency and request rate; this
 * chooses correctly at both ends without a constant to tune.
 *
 * **Pointer coordinates arrive NORMALIZED** (0..1 of the frame) and are
 * multiplied by the tab's live CSS viewport here. The frame image and
 * `window.innerWidth/innerHeight` describe the SAME rectangle in different
 * units, so a fraction converts between them with no ratio a page zoom,
 * device pixel ratio, or window resize can invalidate. This is the same
 * argument the capture code's `[Frame]` line rests on, and it is why the
 * viewport is read fresh (through the shared `viewportReadExpression`, so
 * the login viewer measures the viewport exactly as every other reader
 * does) rather than derived from the frame metadata's DIP dimensions.
 */

/** Frame size cap. Sized for a login form, not for video. */
export const FRAME_MAX_WIDTH = 1280
export const FRAME_MAX_HEIGHT = 800
/** JPEG quality: measured ~17KB/frame at 1280x800, which the wire carries easily. */
export const FRAME_QUALITY = 60
/** Frames sent per POST at most, matching the backend's batch cap. */
export const MAX_FRAMES_PER_POST = 8
/**
 * Frames held while a POST is in flight. Beyond this the OLDEST are
 * dropped: a stalled uplink must not grow memory, and the newest frame
 * already shows everything the ones it outran did.
 */
export const MAX_QUEUED_FRAMES = 16

interface QueuedFrame {
  data: string
  metadata?: Record<string, unknown>
}

interface LoginSession {
  sessionId: string
  tabId: number
  queue: QueuedFrame[]
  posting: boolean
  stopping: boolean
  framesSent: number
  framesDropped: number
}

/**
 * Keyed by tab: one tab can host at most one login session, because the
 * operator drives it by hand and two sessions would fight over one screen.
 */
const sessions = new Map<number, LoginSession>()

function sessionFor(sessionId: string): LoginSession | undefined {
  for (const session of sessions.values()) {
    if (session.sessionId === sessionId) return session
  }
  return undefined
}

// ---------------------------------------------------------------- capture

/**
 * Buffer a frame and keep the uplink busy.
 *
 * The ack goes out FIRST and unconditionally, before any of our own
 * bookkeeping can throw: an unacked frame silently ends the screencast
 * three frames later, so the ack must not be able to be skipped by a
 * failure in the code that follows it.
 */
function onScreencastFrame(
  tabId: number,
  params: { data?: unknown; metadata?: unknown; sessionId?: unknown },
): void {
  const session = sessions.get(tabId)
  if (!session || session.stopping) return
  if (typeof params.sessionId === 'number') {
    void sendCommand(tabId, 'Page.screencastFrameAck', { sessionId: params.sessionId }).catch(
      (error: unknown) => {
        // A failed ack is terminal for the screencast (Chrome stops after
        // three unacked frames), so it is logged rather than swallowed.
        logger.warn('login screencast ack failed:', error)
      },
    )
  }
  if (typeof params.data !== 'string') return
  session.queue.push({
    data: params.data,
    metadata:
      params.metadata && typeof params.metadata === 'object'
        ? (params.metadata as Record<string, unknown>)
        : undefined,
  })
  while (session.queue.length > MAX_QUEUED_FRAMES) {
    session.queue.shift()
    session.framesDropped += 1
  }
  void flush(session)
}

async function flush(session: LoginSession): Promise<void> {
  if (session.posting || session.stopping || session.queue.length === 0) return
  session.posting = true
  try {
    while (session.queue.length > 0 && !session.stopping) {
      const batch = session.queue.splice(0, MAX_FRAMES_PER_POST)
      const ack = await postLoginFrames(session.sessionId, batch)
      session.framesSent += ack.accepted
      if (!ack.sessionActive) {
        // The backend ended the session (Done, the time limit, a thread
        // abort) and this POST is how we find out: there is no downward
        // "stop" for an ending the extension never heard.
        logger.log(`login session ${session.sessionId} ended backend-side; stopping capture`)
        await teardown(session, 'backend ended the session')
        return
      }
    }
  } catch (error) {
    // An uplink failure must not kill the session: the operator is still
    // sitting in front of the tab, and the next frame retries. Frames
    // buffered behind a persistent failure age out through the queue cap.
    logger.warn('login frame POST failed:', error)
  } finally {
    session.posting = false
  }
}

// ------------------------------------------------------------------ input

interface LoginInputEvent {
  type?: unknown
  key?: unknown
  modifiers?: unknown
  text?: unknown
  action?: unknown
  x?: unknown
  y?: unknown
  button?: unknown
  click_count?: unknown
  delta_x?: unknown
  delta_y?: unknown
}

/**
 * Buttons a CLICK can carry, matching `input.ts`'s `MouseButton`. Middle
 * click is deliberately absent: the trusted input path does not carry it,
 * and widening that module for a login viewer would be the tail wagging
 * the dog. Anything unrecognized falls back to left.
 */
const CLICK_BUTTONS = new Set(['left', 'right'])

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * Replay one operator batch into the tab.
 *
 * Fire-and-forget from the connection layer: there is no result to POST and
 * nothing waits on it. The operator's acknowledgement is seeing their
 * keystroke appear in the next screencast frame, which is the only
 * confirmation that actually means the input landed.
 */
export async function handleLoginInput(data: {
  session_id?: unknown
  tab_id?: unknown
  events?: unknown
}): Promise<void> {
  const sessionId = typeof data.session_id === 'string' ? data.session_id : ''
  const session = sessionId ? sessionFor(sessionId) : undefined
  if (!session || session.stopping) {
    // Input for a session this worker does not have: a recycle, or an
    // event that outlived its session. Nothing to do and nothing to warn
    // about beyond the log.
    logger.log(`login input for unknown session ${sessionId.slice(0, 12)}`)
    return
  }
  const events = Array.isArray(data.events) ? (data.events as LoginInputEvent[]) : []
  if (events.length === 0) return

  const tabId = session.tabId
  // Only a pointer event needs geometry, so ordinary typing costs no round
  // trip. Read once per batch: the "being debugged" infobar and any window
  // resize move the viewport under us, and a stale one mis-aims a click.
  const needsViewport = events.some((event) => event.type === 'mouse' || event.type === 'wheel')
  let viewport: { width: number; height: number } | null = null
  if (needsViewport) {
    viewport =
      (await evaluateInProbeWorld<{ width: number; height: number } | null>(
        tabId,
        viewportReadExpression,
      )) ?? null
  }

  for (const event of events) {
    if (session.stopping) return
    try {
      await replayOne(tabId, event, viewport)
    } catch (error) {
      // One bad event must not drop the rest of the batch: the operator
      // is mid-password and a swallowed remainder is worse than a lost
      // keystroke they can see did not arrive.
      logger.warn('login input replay failed:', error)
    }
  }
}

async function replayOne(
  tabId: number,
  event: LoginInputEvent,
  viewport: { width: number; height: number } | null,
): Promise<void> {
  const modifiers = num(event.modifiers)
  if (event.type === 'key') {
    if (typeof event.key === 'string' && event.key) {
      await dispatchKey(tabId, event.key, modifiers)
    }
    return
  }
  if (event.type === 'text') {
    if (typeof event.text === 'string' && event.text) {
      await insertText(tabId, event.text)
    }
    return
  }
  if (!viewport) {
    // No viewport means no honest coordinate. Refusing to guess is right:
    // a mis-aimed trusted click on a login page can submit or navigate.
    logger.warn('login pointer event dropped: viewport unreadable')
    return
  }
  const point = {
    x: num(event.x) * viewport.width,
    y: num(event.y) * viewport.height,
  }
  if (event.type === 'wheel') {
    await trustedWheel(tabId, point, { x: num(event.delta_x), y: num(event.delta_y) }, modifiers)
    return
  }
  if (event.type === 'mouse') {
    if (event.action === 'move') {
      await trustedHover(tabId, point, modifiers)
      return
    }
    const button =
      typeof event.button === 'string' && CLICK_BUTTONS.has(event.button)
        ? (event.button as 'left' | 'right')
        : 'left'
    await trustedClick(tabId, point, {
      button,
      clickCount: Math.min(3, Math.max(1, Math.round(num(event.click_count, 1)))),
      modifiers,
    })
  }
}

// -------------------------------------------------------------- lifecycle

export async function execLoginSessionStart(args: unknown): Promise<CommandResult> {
  const { tab_id: tabId, session_id: sessionId } = (args ?? {}) as {
    tab_id?: unknown
    session_id?: unknown
  }
  if (typeof tabId !== 'number') {
    return { ok: false, status: 'error', error: 'login_session_start needs a numeric tab_id' }
  }
  if (typeof sessionId !== 'string' || !sessionId) {
    return { ok: false, status: 'error', error: 'login_session_start needs a session_id' }
  }
  const existing = sessions.get(tabId)
  if (existing) {
    return {
      ok: false,
      status: 'error',
      error:
        `tab ${tabId} already has login session ${existing.sessionId} running. ` +
        'End that one before starting another; a tab can only be driven by one person at a time.',
    }
  }

  const session: LoginSession = {
    sessionId,
    tabId,
    queue: [],
    posting: false,
    stopping: false,
    framesSent: 0,
    framesDropped: 0,
  }
  sessions.set(tabId, session)
  try {
    // A HELD attach, not a `withSession` call: the screencast has to outlive
    // this command. `releaseAllHolds` (the turn-end release) skips sessions
    // with a live refCount, so the agent answering its turn cannot detach
    // the debugger out from under a human who is mid-login.
    await acquire(tabId)
    await sendCommand(tabId, 'Page.enable')
    await sendCommand(tabId, 'Page.startScreencast', {
      format: 'jpeg',
      quality: FRAME_QUALITY,
      maxWidth: FRAME_MAX_WIDTH,
      maxHeight: FRAME_MAX_HEIGHT,
      everyNthFrame: 1,
    })
  } catch (error) {
    sessions.delete(tabId)
    release(tabId)
    return {
      ok: false,
      status: 'error',
      error: `could not start the login screencast on tab ${tabId}: ${String(error)}`,
    }
  }
  logger.log(`login session ${sessionId} started on tab ${tabId}`)
  return {
    ok: true,
    status: 'success',
    data: {
      session_id: sessionId,
      tab_id: tabId,
      streaming: true,
      note:
        'the tab is being streamed to the user. Chrome sends frames only when the ' +
        'page CHANGES, so a still login form emits about one frame and then nothing: ' +
        'that is the screencast working, not stalling.',
    },
  }
}

export async function execLoginSessionStop(args: unknown): Promise<CommandResult> {
  const { tab_id: tabId, session_id: sessionId } = (args ?? {}) as {
    tab_id?: unknown
    session_id?: unknown
  }
  const session =
    typeof sessionId === 'string' && sessionId
      ? sessionFor(sessionId)
      : typeof tabId === 'number'
        ? sessions.get(tabId)
        : undefined
  if (!session) {
    // Idempotent: the backend may stop a session this worker already tore
    // down (a recycle, or a frame POST that learned of the ending first).
    return {
      ok: true,
      status: 'success',
      data: { stopped: false, note: 'no login session was running here' },
    }
  }
  const framesSent = session.framesSent
  const framesDropped = session.framesDropped
  await teardown(session, 'stopped')
  return {
    ok: true,
    status: 'success',
    data: {
      stopped: true,
      session_id: session.sessionId,
      tab_id: session.tabId,
      frames_sent: framesSent,
      frames_dropped: framesDropped,
    },
  }
}

/**
 * End a session locally: stop the screencast, drop the debugger hold, and
 * forget it. Safe to call twice and safe to call on a tab that has already
 * gone away, which is what makes it usable from every ending path.
 */
async function teardown(session: LoginSession, reason: string): Promise<void> {
  if (session.stopping) return
  session.stopping = true
  session.queue.length = 0
  sessions.delete(session.tabId)
  try {
    await sendCommand(session.tabId, 'Page.stopScreencast')
  } catch (error) {
    // The tab closed, or Chrome already detached: the hold still has to go.
    logger.log(`login screencast stop on tab ${session.tabId} failed (${String(error)})`)
  }
  release(session.tabId)
  logger.log(`login session ${session.sessionId} ended locally: ${reason}`)
}

let installed = false
let uninstallers: (() => void)[] = []

/**
 * Bind the two CDP subscriptions this module lives on; idempotent.
 *
 * Same shape as `installDialogOwnership`, and for the same reason: a test
 * that resets the session layer drops every CDP event handler, so the
 * registration has to be re-runnable rather than a bare module-load side
 * effect. `resetLoginSessionsForTests` unsubscribes and re-binds, so the
 * order of the two resets does not matter and nothing double-registers.
 */
export function installLoginSessionHandlers(): void {
  if (installed) return
  installed = true
  uninstallers.push(
    onCdpEvent((tabId, method, params) => {
      if (method !== 'Page.screencastFrame') return
      onScreencastFrame(tabId, (params ?? {}) as Parameters<typeof onScreencastFrame>[1])
    }),
  )
  // A debugger session ending under us (tab closed, DevTools opened, the
  // user hitting the banner's cancel) ends the login session too. Without
  // this the map keeps a dead entry and the tab can never host another.
  uninstallers.push(
    onSessionEnd((tabId: number) => {
      const session = sessions.get(tabId)
      if (session) void teardown(session, 'the debugger session ended')
    }),
  )
}

installLoginSessionHandlers()

/** Test seam: drop all session state and re-bind the CDP subscriptions. */
export function resetLoginSessionsForTests(): void {
  sessions.clear()
  for (const off of uninstallers) off()
  uninstallers = []
  installed = false
  installLoginSessionHandlers()
}

/** Test/diagnostic read: which tabs currently host a login session. */
export function loginSessionTabs(): number[] {
  return [...sessions.keys()]
}
