/**
 * When each tab was last DRIVEN: the newest command that targeted it (#188).
 *
 * Storage-only, deliberately. The stamp exists for one reader, the health
 * command, and its whole value is surviving the MV3 worker recycle (the
 * common case is "the agent paused to talk, the worker died, now it asks
 * whether the tab is healthy"). An in-memory map would need the hydration
 * machinery snapshotRefs.ts carries; a stamp that lives only in
 * `chrome.storage.session` needs none, because the one consumer can afford
 * an async read. Session storage, not local: the stamp should die with the
 * browser session like the tabs it describes.
 *
 * Writes are fire-and-forget with their own `.catch`, per the transport
 * rule (v0.9.0): bookkeeping must never sit in front of a dispatch, and an
 * un-awaited rejection would otherwise surface as an unhandled error.
 *
 * The health read compares a stamp against `WORKER_STARTED_AT` to say
 * honestly that a drive predates this worker life (attach state and capture
 * buffers reset in between, refs did not).
 */

import { backgroundLogger as logger } from '../utils/logger'

const PREFIX = 'nymDriven:'

/** When this worker (module) came to life; a stamp older than this was
 * written by a previous worker life. */
export const WORKER_STARTED_AT = Date.now()

export interface DriveStamp {
  at: number
  command: string
}

function key(tabId: number): string {
  return `${PREFIX}${tabId}`
}

/** Record that a command is driving this tab right now. Fire-and-forget. */
export function recordDrive(tabId: number, command: string): void {
  try {
    const stamp: DriveStamp = { at: Date.now(), command }
    void chrome.storage.session.set({ [key(tabId)]: stamp }).catch((e) => {
      logger.warn(`drive stamp for tab ${tabId} not persisted:`, e)
    })
  } catch {
    /* No storage.session (very old Chrome): health degrades to "unknown". */
  }
}

/** The last drive stamp for a tab, or null. Shape-validated: storage is a
 * store, not a trusted producer. */
export async function readDriveStamp(tabId: number): Promise<DriveStamp | null> {
  try {
    const got = await chrome.storage.session.get(key(tabId))
    const raw = got?.[key(tabId)] as { at?: unknown; command?: unknown } | undefined
    if (raw && typeof raw.at === 'number' && typeof raw.command === 'string') {
      return { at: raw.at, command: raw.command }
    }
  } catch {
    /* fall through */
  }
  return null
}

/** Drop a closed tab's stamp (Chrome reuses tab ids). Fire-and-forget. */
export function dropDriveStamp(tabId: number): void {
  try {
    void chrome.storage.session.remove(key(tabId)).catch(() => undefined)
  } catch {
    /* ignore */
  }
}
