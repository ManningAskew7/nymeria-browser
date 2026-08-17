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
  // The snapshot is bookkeeping: it survives a worker recycle so the popup
  // can render counters, and nothing else depends on it. A storage failure
  // (the 10MB quota is the realistic one) must therefore cost the write and
  // nothing more, or one oversized entry sitting in `current` would reject
  // every later write and take the connection path's status updates with it.
  try {
    await chrome.storage.local.set({ [SNAPSHOT_KEY]: current })
  } catch (error) {
    logger.warn('failed to persist snapshot:', error)
  }
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

/** Longest string value the journal keeps verbatim. */
const JOURNAL_STRING_LIMIT = 1_024

function redactLongStrings(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > JOURNAL_STRING_LIMIT ? `[${value.length} chars omitted]` : value
  }
  if (Array.isArray(value)) return value.map(redactLongStrings)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactLongStrings(v)]),
    )
  }
  return value
}

/**
 * The journalled copy of an event: its SHAPE, never its bytes.
 *
 * The journal is a diagnostic (the popup renders type, thread and age) that
 * lands on the USER'S DISK, and `chrome.storage.local` is capped at 10MB, a
 * quota a single upload envelope can exceed on its own. Every long string
 * becomes a size marker, which keeps the shape readable for a developer
 * inspecting storage while the bytes stay out of it. Small events (everything
 * but uploads, in practice) are unchanged, so the popup's display is exactly
 * what it was.
 */
function journalCopy(event: AutonomousEvent): AutonomousEvent {
  return redactLongStrings(event) as AutonomousEvent
}

export async function recordEvent(event: AutonomousEvent): Promise<void> {
  current = {
    ...current,
    lastEvent: { event: journalCopy(event), receivedAt: Date.now() },
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
