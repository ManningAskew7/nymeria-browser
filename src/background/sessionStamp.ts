/**
 * sessionStamp: the ONE shape behind the extension's per-tab evidence
 * stamps (#204). Three stores ride it: the last-driven stamp
 * (`driveStamp.ts`), swallowed-input evidence and the positive
 * delivery-proof stamp (both `delivery.ts`).
 *
 * The shared shape, deliberate in every part (the driveStamp.ts rationale):
 *  - `chrome.storage.session`, keyed `${prefix}${tabId}`: survives MV3
 *    worker recycles, dies with the browser session like the tabs it
 *    describes. Storage-only, no in-memory front: the one reader (the
 *    health command) can afford an async read, and a memory copy would be
 *    a second source of truth.
 *  - Writes are fire-and-forget with their own `.catch`, per the transport
 *    rule (v0.9.0): bookkeeping must never sit in front of a dispatch.
 *  - Reads are shape-validated: storage is a store, not a trusted
 *    producer. The validator returns a REPAIRED value or null, never a
 *    boolean, because a store may coerce optional fields (the delivery
 *    proof keeps a stamp whose `url`/`navSeq` are malformed by nulling
 *    them) rather than reject the whole stamp.
 *  - Clears remove unconditionally and fire-and-forget: removing an
 *    absent key is free, and knowing whether it is there would cost a
 *    read on every clear.
 *
 * What the factory deliberately does NOT own: write-failure logging
 * (opt-in via `onWriteError`; only the drive stamp wants it), cross-store
 * clears (they live at the act.ts verdict site, where the one-story rule
 * is decided), and reader-side age gating against `WORKER_STARTED_AT`
 * (three stores use it three different ways in health.ts; pulling it in
 * here would add machinery, not collapse it).
 */

export interface SessionStampStore<T extends object> {
  /** Persist a stamp for this tab. Fire-and-forget. */
  record(tabId: number, stamp: T): void
  /** The tab's stamp, validated/repaired, or null. */
  read(tabId: number): Promise<T | null>
  /** Drop the tab's stamp (tab close, or the evidence is spent). */
  clear(tabId: number): void
}

export function sessionStamp<T extends object>(
  prefix: string,
  validate: (raw: Record<string, unknown>) => T | null,
  opts?: { onWriteError?: (tabId: number, e: unknown) => void },
): SessionStampStore<T> {
  const key = (tabId: number): string => `${prefix}${tabId}`
  return {
    record(tabId: number, stamp: T): void {
      try {
        void chrome.storage.session.set({ [key(tabId)]: stamp }).catch((e) => {
          opts?.onWriteError?.(tabId, e)
        })
      } catch {
        /* No storage.session (very old Chrome): the stamp is simply not
         * kept, and the reader degrades to "unknown". */
      }
    },
    async read(tabId: number): Promise<T | null> {
      try {
        const got = await chrome.storage.session.get(key(tabId))
        const raw = got?.[key(tabId)]
        if (raw && typeof raw === 'object') {
          return validate(raw as Record<string, unknown>)
        }
      } catch {
        /* fall through */
      }
      return null
    },
    clear(tabId: number): void {
      try {
        void chrome.storage.session.remove(key(tabId)).catch(() => undefined)
      } catch {
        /* ignore */
      }
    },
  }
}
