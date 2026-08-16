import { backgroundLogger as logger } from '../utils/logger'
import { getConfig } from '../utils/storage'
import { HttpError, whoami } from './api'
import { dispatchBrowserCommand } from './commands'
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
  const { baseUrl, token, clientId } = await getConfig()
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
        try {
          const event = JSON.parse(data) as AutonomousEvent
          await recordEvent(event)
          if (event.type === 'browser_command') {
            // Fire-and-forget; per-command try/catch is inside the dispatcher.
            void dispatchBrowserCommand(event as BrowserCommandEvent)
          }
        } catch (error) {
          logger.warn('failed to parse SSE frame:', error, data.slice(0, 200))
        }
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
