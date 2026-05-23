import { backgroundLogger as logger } from '../utils/logger'
import { BROADCAST_CHANNEL } from '../shared/messages'
import type { AutonomousEvent, BackgroundSnapshot, ConnectionStatus } from '../shared/types'

const SNAPSHOT_KEY = 'snapshot'

let current: BackgroundSnapshot = {
  status: { kind: 'unconfigured' },
  lastEvent: null,
  eventCount: 0,
}

export function getSnapshot(): BackgroundSnapshot {
  return current
}

export async function loadFromStorage(): Promise<void> {
  const stored = (await chrome.storage.local.get([SNAPSHOT_KEY])) as { snapshot?: BackgroundSnapshot }
  if (stored.snapshot) {
    current = { ...stored.snapshot, status: { kind: 'unconfigured' } }
  }
}

async function persist(): Promise<void> {
  await chrome.storage.local.set({ [SNAPSHOT_KEY]: current })
}

function broadcast(): void {
  chrome.runtime.sendMessage({ channel: BROADCAST_CHANNEL, snapshot: current }).catch(() => {
    // Popup may not be open; ignore.
  })
}

export async function setStatus(status: ConnectionStatus): Promise<void> {
  current = { ...current, status }
  logger.log('status →', status.kind)
  await persist()
  broadcast()
}

export async function recordEvent(event: AutonomousEvent): Promise<void> {
  current = {
    ...current,
    lastEvent: { event, receivedAt: Date.now() },
    eventCount: current.eventCount + 1,
  }
  await persist()
  broadcast()
}

export async function resetSnapshot(): Promise<void> {
  current = { status: { kind: 'unconfigured' }, lastEvent: null, eventCount: 0 }
  await persist()
  broadcast()
}
