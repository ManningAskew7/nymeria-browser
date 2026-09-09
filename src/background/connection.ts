import { backgroundLogger as logger } from '../utils/logger'
import { getConfig } from '../utils/storage'
import { HttpError, whoami } from './api'
import { dispatchBrowserCommand } from './commands'
import { handleLoginInput } from './commands/login_session'
import { releaseAllHolds } from './debuggerSession'
import { frameToData, parseSseFrames } from './sse'
import { recordEvent, setStatus } from './state'
import type { AutonomousEvent, BrowserCommandEvent, MeResponse } from '../shared/types'

const MIN_BACKOFF_MS = 1_000
const MAX_BACKOFF_MS = 60_000

let activeController: AbortController | null = null
let running = false
let retryTimer: ReturnType<typeof setTimeout> | null = null
let attempt = 0

function jitter(ms: number): number {
  return ms + Math.floor(Math.random() * ms * 0.3)
}

function computeBackoff(): number {
  const base = Math.min(MIN_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS)
  return jitter(base)
}

function clearRetry(): void {
  if (retryTimer) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
}

/**
 * Why the connection attempt failed, in the user's terms.
 *
 * This string is rendered verbatim in the popup's status card, so it is a
 * diagnosis and has to be one we actually made. The previous wording called
 * EVERY failure here "auth", including a bare `TypeError: Failed to fetch`,
 * which is the shape a closed SSH tunnel, a stopped backend or a
 * mid-restart container all take: the request never reached anything, so
 * authentication was never attempted, let alone refused. Sending someone to
 * re-mint a token because their tunnel dropped is the same mistake this
 * codebase keeps finding in the browser tools, one layer out.
 */
export function describeConnectFailure(error: unknown): string {
  if (error instanceof HttpError) {
    if (error.status === 401 || error.status === 403) return `token rejected (${error.status})`
    return `backend error (${error.status})`
  }
  return 'cannot reach the backend'
}

function scheduleRetry(reason: string): void {
  if (!running) return
  const delay = computeBackoff()
  attempt += 1
  void setStatus({
    kind: 'disconnected',
    reason,
    nextRetryAt: Date.now() + delay,
    attempt,
  })
  logger.log(`reconnect in ${delay}ms (attempt ${attempt}, reason: ${reason})`)
  clearRetry()
  retryTimer = setTimeout(() => {
    retryTimer = null
    void connectOnce()
  }, delay)
}

async function connectOnce(): Promise<void> {
  if (!running) return
  const { baseUrl, token, clientId, kind, label } = await getConfig()
  if (!baseUrl || !token) {
    logger.log('No config; staying unconfigured')
    await setStatus({ kind: 'unconfigured' })
    running = false
    return
  }

  await setStatus({ kind: 'connecting', since: Date.now() })

  let identity: MeResponse
  try {
    identity = await whoami({ baseUrl, token, clientId })
  } catch (error) {
    logger.error('whoami failed:', error)
    scheduleRetry(describeConnectFailure(error))
    return
  }

  const url = new URL('/autonomous/stream', baseUrl)
  url.searchParams.set('client_id', clientId)
  // The running build's version, so the backend can answer "which build is
  // live" (#176 rider: chrome_reload_extension reports version_after from
  // the post-reload resubscribe instead of leaving the deploy unverified).
  url.searchParams.set('client_version', chrome.runtime.getManifest().version)
  // Which kind of browser this is (the server browser beside the backend,
  // or the user's own Chrome) and, only when one is stored, the roster
  // label hint. Kind is information for rosters and refusals, never a
  // routing rule; the backend's ladder is unchanged by it.
  url.searchParams.set('client_kind', kind)
  if (label) url.searchParams.set('client_label', label)

  activeController = new AbortController()
  let resp: Response
  try {
    resp = await fetch(url, {
      method: 'GET',
      credentials: 'omit',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'text/event-stream',
        'X-Nymeria-Client-Id': clientId,
      },
      signal: activeController.signal,
    })
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      logger.log('stream connect aborted')
      return
    }
    logger.error('stream fetch error:', error)
    // Same distinction as the whoami path: the stream never opened, so this is
    // reachability, not credentials.
    scheduleRetry(describeConnectFailure(error))
    return
  }

  if (!resp.ok || !resp.body) {
    const text = await resp.text().catch(() => '')
    logger.error('stream non-ok:', resp.status, text.slice(0, 200))
    scheduleRetry(`http ${resp.status}`)
    return
  }

  attempt = 0
  await setStatus({ kind: 'connected', since: Date.now(), identity })

  const reader = resp.body.pipeThrough(new TextDecoderStream()).getReader()
  let buf = ''
  try {
    while (running) {
      const { value, done } = await reader.read()
      if (done) break
      buf += value
      const { frames, rest } = parseSseFrames(buf)
      buf = rest
      for (const frame of frames) {
        const data = frameToData(frame)
        if (!data) continue
        let event: AutonomousEvent
        try {
          event = JSON.parse(data) as AutonomousEvent
        } catch (error) {
          logger.warn('failed to parse SSE frame:', error, data.slice(0, 200))
          continue
        }
        if (event.type === 'browser_command') {
          // Fire-and-forget; per-command try/catch is inside the dispatcher.
          void dispatchBrowserCommand(event as BrowserCommandEvent)
        } else if (event.type === 'browser_login_input') {
          // The operator is typing into a tab they are signing into. Replay
          // is fire-and-forget by design: there is no result to POST, and a
          // round trip per keystroke would put the typing latency on the
          // wrong side of the network. What confirms the input landed is the
          // next screencast frame, which the operator is already watching.
          void handleLoginInput(
            (event as { data?: Record<string, unknown> }).data ??
              (event as unknown as Record<string, unknown>),
          )
        } else if (event.type === 'browser_session_release') {
          // Turn-end signal (#191): the agent has answered, so idle debugger
          // holds end NOW and the banner drops, instead of riding out the
          // safety-net linger. Not a command: no result to POST, no budget.
          // Synchronous and self-contained (detach itself is fired
          // fire-and-forget inside it), so no guard here.
          releaseAllHolds()
        }
        // NEVER journal an operator's keystrokes. The journal writes to
        // `chrome.storage.local`, which persists across restarts, so
        // journalling this event type would leave the characters of
        // somebody's password sitting in extension storage: the one thing
        // the whole login handoff exists to prevent. The event is handled
        // above and then deliberately forgotten.
        if (event.type === 'browser_login_input') continue
        // Journal AFTER dispatch, and never on its critical path. The journal
        // writes to `chrome.storage.local`, whose 10MB quota REJECTS a large
        // upload envelope: with the write first and inside the same try, that
        // rejection ate the command, so every upload over roughly 7.5MB
        // silently never ran and rode the transport timeout out as a page
        // problem. Bookkeeping is a diagnostic; the command is the job.
        void recordEvent(event).catch((error: unknown) => {
          logger.warn('failed to journal event:', error)
        })
      }
    }
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      logger.log('stream reader aborted')
      return
    }
    logger.error('stream reader error:', error)
    scheduleRetry('reader')
    return
  }

  if (running) scheduleRetry('eof')
}

export async function startConnection(): Promise<void> {
  if (running) return
  running = true
  attempt = 0
  await connectOnce()
}

export async function stopConnection(): Promise<void> {
  running = false
  clearRetry()
  if (activeController) {
    activeController.abort()
    activeController = null
  }
  await setStatus({ kind: 'unconfigured' })
}

export function isRunning(): boolean {
  return running
}

export async function ensureConnected(): Promise<void> {
  if (running) {
    // The heartbeat alarm exists to bound reconnection at about a minute,
    // and the backend's #172 dispatch grace is sized to that promise. A
    // pending backoff can be scheduled up to 60s+jitter out (and survives
    // as long as this worker does), so an alarm that finds one waiting
    // preempts it and connects now instead of letting the retry outlive
    // the window the alarm guarantees.
    if (retryTimer) {
      clearRetry()
      await connectOnce()
    }
    return
  }
  const { baseUrl, token } = await getConfig()
  if (baseUrl && token) await startConnection()
}
