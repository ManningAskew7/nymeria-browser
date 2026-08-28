/**
 * The popup's connect-form draft: what the user has TYPED, not what is
 * configured.
 *
 * Exists because the popup is a throwaway document and Connect's first step
 * can kill it: `chrome.permissions.request` shows a native prompt, and that
 * prompt can dismiss the popup (measured on the operator's desktop,
 * 2026-08-28: URL + token typed, Connect clicked, popup gone, fields back
 * to defaults, worker honestly `unconfigured`). The GRANT survives that
 * death, so the retry sails through with no prompt; what died was the typed
 * text. Mirroring the fields here makes the retry seamless instead of a
 * re-type.
 *
 * `chrome.storage.session` on purpose: it survives popup death and worker
 * recycles but dies with the browser, so a token draft never reaches disk
 * (the CONFIGURED token lives in `storage.local` already; a draft is the
 * one copy that might never be submitted). The token field is stored
 * through `encryptData`, same as the configured copy: anything that dumps
 * storage (a debug probe did exactly that, 2026-08-28) sees ciphertext,
 * not a live credential. Reads are shape-validated and writes are
 * fire-and-forget with their own catch, per the sessionStamp conventions;
 * a save that fails costs a re-type, never the popup.
 */

import { decryptData, encryptData } from '../utils/security'

const DRAFT_KEY = 'nymPopupDraft'

export interface ConnectDraft {
  baseUrl: string
  token: string
}

/** The saved draft, or null (never typed, malformed, storage unavailable).
 *  A token that fails decryption comes back as '' (decryptData's tamper
 *  answer): the URL half of the draft still restores. */
export async function loadDraft(): Promise<ConnectDraft | null> {
  try {
    const got = await chrome.storage.session.get(DRAFT_KEY)
    const raw = got[DRAFT_KEY] as { baseUrl?: unknown; token?: unknown } | undefined
    if (!raw || typeof raw !== 'object') return null
    if (typeof raw.baseUrl !== 'string' || typeof raw.token !== 'string') return null
    return { baseUrl: raw.baseUrl, token: await decryptData(raw.token) }
  } catch {
    return null
  }
}

/** Mirror the current field values. Fire-and-forget. */
export function saveDraft(draft: ConnectDraft): void {
  try {
    void (async () => {
      const token = await encryptData(draft.token)
      await chrome.storage.session.set({ [DRAFT_KEY]: { baseUrl: draft.baseUrl, token } })
    })().catch(() => {})
  } catch {
    /* No storage.session: the draft convenience simply does not exist. */
  }
}
