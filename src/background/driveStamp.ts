/**
 * When each tab was last DRIVEN: the newest command that targeted it (#188).
 *
 * One of the three per-tab evidence stamps riding `sessionStamp.ts` (#204);
 * the shared storage rationale (storage-only, fire-and-forget writes,
 * validated reads) lives there. Specific to THIS stamp: it is the only one
 * that logs a write failure (a drive that silently fails to stamp would
 * make `last_driven` lie by omission on the very next health read), and it
 * owns `WORKER_STARTED_AT`, which the health read compares stamps against
 * to say honestly that a drive predates this worker life (attach state and
 * capture buffers reset in between, refs did not).
 */

import { sessionStamp } from './sessionStamp'
import { backgroundLogger as logger } from '../utils/logger'

/** When this worker (module) came to life; a stamp older than this was
 * written by a previous worker life. */
export const WORKER_STARTED_AT = Date.now()

export interface DriveStamp {
  at: number
  command: string
}

const store = sessionStamp<DriveStamp>(
  'nymDriven:',
  (raw) =>
    typeof raw.at === 'number' && typeof raw.command === 'string'
      ? { at: raw.at, command: raw.command }
      : null,
  {
    onWriteError: (tabId, e) => {
      logger.warn(`drive stamp for tab ${tabId} not persisted:`, e)
    },
  },
)

/** Record that a command is driving this tab right now. Fire-and-forget. */
export function recordDrive(tabId: number, command: string): void {
  store.record(tabId, { at: Date.now(), command })
}

/** The last drive stamp for a tab, or null. */
export async function readDriveStamp(tabId: number): Promise<DriveStamp | null> {
  return store.read(tabId)
}

/** Drop a closed tab's stamp (Chrome reuses tab ids). Fire-and-forget. */
export function dropDriveStamp(tabId: number): void {
  store.clear(tabId)
}
