import { backgroundLogger as logger } from '../utils/logger'
import { BROADCAST_CHANNEL } from '../shared/messages'
import type {
  AutonomousEvent,
  BackgroundSnapshot,
  CommandType,
  ConnectionStatus,
} from '../shared/types'

const SNAPSHOT_KEY = 'snapshot'

const INITIAL_SNAPSHOT: BackgroundSnapshot = {
  status: { kind: 'unconfigured' },
  lastEvent: null,
  eventCount: 0,
  commandCount: 0,
  lastCommandType: null,
  debuggerTabs: [],
}

let current: BackgroundSnapshot = { ...INITIAL_SNAPSHOT }

export function getSnapshot(): BackgroundSnapshot {
  return current
}

export async function loadFromStorage(): Promise<void> {
  const stored = (await chrome.storage.local.get([SNAPSHOT_KEY])) as { snapshot?: BackgroundSnapshot }
  if (stored.snapshot) {
    current = {
      ...INITIAL_SNAPSHOT,
      ...stored.snapshot,
      status: { kind: 'unconfigured' },
      debuggerTabs: [],
    }
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

export async function recordCommand(commandType: CommandType): Promise<void> {
  current = {
    ...current,
    commandCount: current.commandCount + 1,
    lastCommandType: commandType,
  }
  await persist()
  broadcast()
}

export async function recordDebuggerTabs(tabs: number[]): Promise<void> {
  current = { ...current, debuggerTabs: tabs }
  await persist()
  broadcast()
}

export async function resetSnapshot(): Promise<void> {
  current = { ...INITIAL_SNAPSHOT }
  await persist()
  broadcast()
}
