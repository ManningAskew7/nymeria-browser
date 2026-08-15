import { backgroundLogger as logger } from '../utils/logger'
import { clearConfig, ensureClientId, getConfig, setConfig } from '../utils/storage'
import { HttpError, ping, whoami } from './api'
import { setDispatchHooks } from './commands'
import { ensureConnected, startConnection, stopConnection } from './connection'
import { activeTabs as activeDebuggerTabs } from './debuggerSession'
import { clearTabDialogState, installDialogOwnership } from './dialogs'
import { clearWorld as clearDeliveryWorld } from './delivery'
import { clear as clearRefs } from './snapshotRefs'
import { installCdpConsoleCapture } from './consoleBuffer'
import { clearTabNav, installNavWatch } from './navWatch'
import { clearTabStatus, installStatusWatch } from './statusWatch'
import { clear as clearNetwork, installCdpNetworkCapture } from './networkBuffer'
import {
  getSnapshot,
  loadFromStorage,
  recordCommand,
  recordDebuggerTabs,
  resetSnapshot,
  setStatus,
} from './state'
import type { PopupRequest, PopupResponse } from '../shared/messages'

const HEARTBEAT_NAME = 'nymeria-heartbeat'

setDispatchHooks({
  onResult: (event) => {
    void recordCommand(event.command_type)
    void recordDebuggerTabs(activeDebuggerTabs())
  },
})

// Console + uncaught exceptions stream in over CDP, which needs no host
// permission and so works on every origin the agent can reach. Installed at
// the top level: the buffer must already be filling before the first action,
// or the post-action verification has nothing to report.
installCdpConsoleCapture()
installCdpNetworkCapture()
// Dialog ownership (#169): Page is enabled on every attach, and this module
// answers what that ownership obliges us to answer. Installed here at the
// worker top level like the console and network captures.
installDialogOwnership()
// Navigation lifecycle (start/commit/abort per tab), the browser-process
// truth that makes `url_changed` and navigate's outcome honest. Observation
// only; the ref-clearing onCommitted listener below is invalidation and
// stays separate.
installNavWatch()
// Main-frame HTTP status per tab (#175), the half of navigation truth
// webNavigation cannot see. Inert until the user grants the optional host
// permission from the popup; consumers treat "no record" as unknown.
installStatusWatch()

// A committed navigation invalidates the tab's refs, and destroys the isolated
// world the delivery probe caches (it dies with its document, so a cached
// context id would resolve to nothing). Network history is kept deliberately:
// the requests a navigation itself fired are often the answer to "why did that
// go wrong".
chrome.webNavigation?.onCommitted.addListener?.((details) => {
  if (details.frameId !== 0) return
  clearRefs(details.tabId)
  clearDeliveryWorld(details.tabId)
})
chrome.tabs.onRemoved.addListener((tabId) => {
  clearRefs(tabId)
  clearNetwork(tabId)
  clearDeliveryWorld(tabId)
  clearTabDialogState(tabId)
  clearTabStatus(tabId)
  // Wakes any navigation wait with `removed` before dropping state, so a
  // navigate on a tab the user just closed fails fast instead of riding
  // its deadline.
  clearTabNav(tabId)
})

async function bootstrap(): Promise<void> {
  logger.log('bootstrap')
  await loadFromStorage()
  await ensureClientId()
  // 1 minute is Chrome's floor for a packed extension; asking for less does
  // not go faster, it just makes the real interval a surprise.
  chrome.alarms.create(HEARTBEAT_NAME, { periodInMinutes: 1 })
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
