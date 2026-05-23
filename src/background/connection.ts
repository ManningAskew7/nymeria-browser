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
    const reason = error instanceof HttpError ? `auth (${error.status})` : 'auth (network)'
    logger.error('whoami failed:', error)
    scheduleRetry(reason)
    return
  }

  const url = new URL('/autonomous/stream', baseUrl)
  url.searchParams.set('client_id', clientId)

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
    scheduleRetry('network')
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
  if (running) return
  const { baseUrl, token } = await getConfig()
  if (baseUrl && token) await startConnection()
}
