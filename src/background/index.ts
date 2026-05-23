import { backgroundLogger as logger } from '../utils/logger'
import { clearConfig, ensureClientId, getConfig, setConfig } from '../utils/storage'
import { HttpError, ping, whoami } from './api'
import { ensureConnected, startConnection, stopConnection } from './connection'
import { getSnapshot, loadFromStorage, resetSnapshot, setStatus } from './state'
import type { PopupRequest, PopupResponse } from '../shared/messages'

const HEARTBEAT_NAME = 'nymeria-heartbeat'

async function bootstrap(): Promise<void> {
  logger.log('bootstrap')
  await loadFromStorage()
  await ensureClientId()
  chrome.alarms.create(HEARTBEAT_NAME, { periodInMinutes: 0.5 })
  await ensureConnected()
}

chrome.runtime.onInstalled.addListener(() => void bootstrap())
chrome.runtime.onStartup.addListener(() => void bootstrap())

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === HEARTBEAT_NAME) void ensureConnected()
})

async function handleConnect(baseUrl: string, token: string): Promise<PopupResponse> {
  const trimmedUrl = baseUrl.trim().replace(/\/+$/, '')
  const trimmedToken = token.trim()
  if (!trimmedUrl || !trimmedToken) {
    return { ok: false, error: 'Both base URL and token are required.' }
  }
  try {
    await ping(trimmedUrl)
  } catch (error) {
    const msg = error instanceof HttpError ? `Health check failed (${error.status}).` : 'Cannot reach the Nymeria API.'
    return { ok: false, error: msg }
  }
  const { clientId } = await ensureClientId()
  let identity
  try {
    identity = await whoami({ baseUrl: trimmedUrl, token: trimmedToken, clientId })
  } catch (error) {
    const msg =
      error instanceof HttpError
        ? error.status === 401 || error.status === 403
          ? 'Token rejected. Mint a new one via POST /me/tokens.'
          : `whoami failed (${error.status}).`
        : 'whoami failed (network).'
    return { ok: false, error: msg }
  }
  await setConfig({ baseUrl: trimmedUrl, token: trimmedToken })
  await stopConnection()
  void startConnection()
  return { ok: true, identity }
}

async function handleDisconnect(): Promise<PopupResponse> {
  await stopConnection()
  return { ok: true }
}

async function handleForget(): Promise<PopupResponse> {
  await stopConnection()
  await clearConfig()
  await resetSnapshot()
  await setStatus({ kind: 'unconfigured' })
  return { ok: true }
}

chrome.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
  const msg = raw as PopupRequest
  ;(async () => {
    try {
      switch (msg.kind) {
        case 'get-snapshot':
          sendResponse({ ok: true, snapshot: getSnapshot() } satisfies PopupResponse)
          break
        case 'connect':
          sendResponse(await handleConnect(msg.baseUrl, msg.token))
          break
        case 'disconnect':
          sendResponse(await handleDisconnect())
          break
        case 'forget':
          sendResponse(await handleForget())
          break
        default:
          sendResponse({ ok: false, error: 'Unknown request' } satisfies PopupResponse)
      }
    } catch (error) {
      logger.error('message handler error:', error)
      sendResponse({ ok: false, error: (error as Error).message } satisfies PopupResponse)
    }
  })()
  return true
})

void bootstrap().then(async () => {
  const { baseUrl, token } = await getConfig()
  if (!baseUrl || !token) await setStatus({ kind: 'unconfigured' })
})
